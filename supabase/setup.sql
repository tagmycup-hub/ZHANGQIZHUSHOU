-- 账期助手 · Supabase 云同步建表脚本
-- 在 Supabase 控制台 → SQL Editor 里整段粘贴运行一次即可（可重复运行）。
-- 设计：数据表不对外开放（RLS 开启且没有任何 policy），网页只能通过下面 3 个函数读写，
--       每个"同步空间"都有自己的口令（只存 SHA-256 哈希），只知道 Project URL 和 publishable key 的人读不到你的数据。

create sequence if not exists public.zq_seq;

create table if not exists public.zq_spaces (
  space       text primary key,
  secret_hash text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.zq_records (
  space      text not null references public.zq_spaces(space) on delete cascade,
  kind       text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null,
  deleted    boolean not null default false,
  seq        bigint not null default nextval('public.zq_seq'),
  primary key (space, kind, id)
);
create index if not exists zq_records_space_seq on public.zq_records (space, seq);

alter table public.zq_spaces  enable row level security;
alter table public.zq_records enable row level security;
revoke all on public.zq_spaces, public.zq_records from anon, authenticated;

-- 校验同步空间口令；p_create = true 时空间不存在就创建（第一台设备上传时）
create or replace function public.zq_auth(p_space text, p_secret text, p_create boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  h text := encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  s text;
begin
  if coalesce(length(p_space), 0) < 6 or coalesce(length(p_space), 0) > 64 or coalesce(length(p_secret), 0) < 12 then
    raise exception 'ZQ_BAD_INPUT';
  end if;
  -- 「u:」开头的是账号空间，只能通过登录访问
  if p_space like 'u:%' then
    raise exception 'ZQ_BAD_INPUT';
  end if;
  select secret_hash into s from zq_spaces where space = p_space;
  if s is null then
    if p_create then
      insert into zq_spaces(space, secret_hash) values (p_space, h) on conflict (space) do nothing;
      select secret_hash into s from zq_spaces where space = p_space;
    else
      raise exception 'ZQ_NO_SPACE';
    end if;
  end if;
  if s <> h then
    raise exception 'ZQ_BAD_SECRET';
  end if;
end;
$$;

-- 空间状态（测试连接用）
create or replace function public.zq_status(p_space text, p_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from zq_spaces where space = p_space) then
    return jsonb_build_object('exists', false, 'count', 0, 'cursor', 0);
  end if;
  perform zq_auth(p_space, p_secret, false);
  return jsonb_build_object(
    'exists', true,
    'count', (select count(*) from zq_records where space = p_space and not deleted and kind <> 'settings'),
    'cursor', (select coalesce(max(seq), 0) from zq_records where space = p_space)
  );
end;
$$;

-- 下载：返回 seq 大于游标的记录（分页）
create or replace function public.zq_pull(p_space text, p_secret text, p_since bigint default 0, p_limit int default 500)
returns table (kind text, id text, data jsonb, updated_at timestamptz, deleted boolean, seq bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform zq_auth(p_space, p_secret, false);
  return query
    select r.kind, r.id, r.data, r.updated_at, r.deleted, r.seq
      from zq_records r
     where r.space = p_space and r.seq > coalesce(p_since, 0)
     order by r.seq
     limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

-- 上传：按 updated_at 取新者（较旧的改动不会覆盖云端较新的数据）
create or replace function public.zq_push(p_space text, p_secret text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  perform zq_auth(p_space, p_secret, true);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'ZQ_BAD_ROWS';
  end if;
  with src as (
    select x->>'kind' as kind,
           x->>'id' as id,
           x->'data' as data,
           (x->>'updated_at')::timestamptz as updated_at,
           coalesce((x->>'deleted')::boolean, false) as deleted
      from jsonb_array_elements(p_rows) as x
     where x->>'kind' in ('bill', 'merchant', 'account', 'settings')
       and coalesce(length(x->>'id'), 0) between 1 and 200
       and x->'data' is not null
  ), up as (
    insert into zq_records as r (space, kind, id, data, updated_at, deleted)
    select p_space, kind, id, data, updated_at, deleted from src
    on conflict (space, kind, id) do update
       set data = excluded.data,
           updated_at = excluded.updated_at,
           deleted = excluded.deleted,
           seq = nextval('public.zq_seq')
     where r.updated_at < excluded.updated_at
    returning 1
  )
  select count(*) into n from up;
  return jsonb_build_object('applied', n);
end;
$$;

revoke all on function public.zq_auth(text, text, boolean) from public, anon, authenticated;
grant execute on function public.zq_status(text, text) to anon, authenticated;
grant execute on function public.zq_pull(text, text, bigint, int) to anon, authenticated;
grant execute on function public.zq_push(text, text, jsonb) to anon, authenticated;

-- =====================================================================
-- 第二部分：账号登录、订阅套餐、AI 额度、关屏推送（可重复运行）
-- 账号数据存在同一张 zq_records 表，空间名为 u:<用户ID>，只能由登录的本人读写。
-- =====================================================================

-- 账号同步：按登录用户读写自己的空间
-- （zq_me_space 定义在套餐表之后）

create or replace function public.zq_me_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sp text := zq_me_space();
begin
  return jsonb_build_object(
    'exists', true,
    'count', (select count(*) from zq_records where space = sp and not deleted and kind <> 'settings'),
    'cursor', (select coalesce(max(seq), 0) from zq_records where space = sp)
  );
end;
$$;

create or replace function public.zq_me_pull(p_since bigint default 0, p_limit int default 500)
returns table (kind text, id text, data jsonb, updated_at timestamptz, deleted boolean, seq bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  sp text := zq_me_space();
begin
  return query
    select r.kind, r.id, r.data, r.updated_at, r.deleted, r.seq
      from zq_records r
     where r.space = sp and r.seq > coalesce(p_since, 0)
     order by r.seq
     limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end;
$$;

create or replace function public.zq_me_push(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sp text := zq_me_space();
  n int;
begin
  -- 试用结束且没有订阅：只读
  if not zq_can_write(auth.uid()) then
    raise exception 'ZQ_READONLY';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then
    raise exception 'ZQ_BAD_ROWS';
  end if;
  with src as (
    select x->>'kind' as kind, x->>'id' as id, x->'data' as data,
           (x->>'updated_at')::timestamptz as updated_at,
           coalesce((x->>'deleted')::boolean, false) as deleted
      from jsonb_array_elements(p_rows) as x
     where x->>'kind' in ('bill', 'merchant', 'account', 'settings')
       and coalesce(length(x->>'id'), 0) between 1 and 200
       and x->'data' is not null
  ), up as (
    insert into zq_records as r (space, kind, id, data, updated_at, deleted)
    select sp, kind, id, data, updated_at, deleted from src
    on conflict (space, kind, id) do update
       set data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, seq = nextval('public.zq_seq')
     where r.updated_at < excluded.updated_at
    returning 1
  )
  select count(*) into n from up;
  return jsonb_build_object('applied', n);
end;
$$;

revoke all on function public.zq_me_status() from public, anon;
revoke all on function public.zq_me_pull(bigint, int) from public, anon;
revoke all on function public.zq_me_push(jsonb) from public, anon;
grant execute on function public.zq_me_status() to authenticated;
grant execute on function public.zq_me_pull(bigint, int) to authenticated;
grant execute on function public.zq_me_push(jsonb) to authenticated;

-- 套餐、用量、推送订阅、函数私有配置（全部只允许服务端访问）
create table if not exists public.zq_profiles (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  email             text,
  plan              text,
  plan_until        timestamptz,
  mp_preapproval_id text,
  mp_status         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create table if not exists public.zq_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month   text not null,
  ai      int not null default 0,
  primary key (user_id, month)
);
create table if not exists public.zq_push_subs (
  endpoint   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  fails      int not null default 0
);
create index if not exists zq_push_subs_user on public.zq_push_subs (user_id);
create table if not exists public.zq_push_log (
  key     text primary key,
  sent_at timestamptz not null default now()
);
create table if not exists public.zq_kv (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
-- 套餐字段（第九轮）：试用到期日、付款周期、换套餐时的待生效订阅
alter table public.zq_profiles add column if not exists trial_until timestamptz not null default (now() + interval '30 days');
alter table public.zq_profiles add column if not exists period text;
alter table public.zq_profiles add column if not exists pending_id text;
alter table public.zq_profiles add column if not exists pending_plan text;
alter table public.zq_profiles alter column plan drop not null;
alter table public.zq_profiles alter column plan drop default;
update public.zq_profiles set plan = null where plan in ('free');

-- 登录用户的同步空间；第一次使用时自动建立账号资料（开始 30 天试用）
create or replace function public.zq_me_space()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sp text;
begin
  if uid is null then
    raise exception 'ZQ_LOGIN';
  end if;
  sp := 'u:' || uid::text;
  insert into zq_spaces(space, secret_hash) values (sp, 'account') on conflict (space) do nothing;
  insert into zq_profiles(user_id, email) select uid, u.email from auth.users u where u.id = uid on conflict (user_id) do nothing;
  return sp;
end;
$$;

-- 能否修改数据：管理员、试用期内、订阅有效期内
create or replace function public.zq_can_write(p_user uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from zq_profiles p
     where p.user_id = p_user
       and (p.plan = 'owner' or p.trial_until > now() or (p.plan in ('t1', 't2', 'pro') and p.plan_until > now()))
  );
$$;
revoke all on function public.zq_me_space() from public, anon, authenticated;
revoke all on function public.zq_can_write(uuid) from public, anon, authenticated;

alter table public.zq_profiles  enable row level security;
alter table public.zq_usage     enable row level security;
alter table public.zq_push_subs enable row level security;
alter table public.zq_push_log  enable row level security;
alter table public.zq_kv        enable row level security;
revoke all on public.zq_profiles, public.zq_usage, public.zq_push_subs, public.zq_push_log, public.zq_kv from anon, authenticated;

-- AI 额度：未超过上限就 +1 并返回新值；超过返回 -1（p_limit < 0 表示不限）
create or replace function public.zq_usage_take(p_user uuid, p_month text, p_limit int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  insert into zq_usage(user_id, month, ai) values (p_user, p_month, 0) on conflict do nothing;
  update zq_usage set ai = ai + 1
   where user_id = p_user and month = p_month and (p_limit < 0 or ai < p_limit)
  returning ai into n;
  return coalesce(n, -1);
end;
$$;

create or replace function public.zq_usage_refund(p_user uuid, p_month text)
returns void
language sql
security definer
set search_path = public
as $$
  update zq_usage set ai = greatest(ai - 1, 0) where user_id = p_user and month = p_month;
$$;

-- 推送：某用户未付、未删除、60 天内到期的账单
create or replace function public.zq_push_bills(p_user uuid)
returns table (id text, data jsonb)
language sql
security definer
set search_path = public
as $$
  select r.id, r.data from zq_records r
   where r.space = 'u:' || p_user::text and r.kind = 'bill' and not r.deleted
     and coalesce(r.data->>'paidAt', '') = '' and coalesce(r.data->>'deletedAt', '') = ''
     and (r.data->>'dueDate') <= to_char((now() at time zone 'America/Sao_Paulo')::date + 60, 'YYYY-MM-DD');
$$;

revoke all on function public.zq_usage_take(uuid, text, int) from public, anon, authenticated;
revoke all on function public.zq_usage_refund(uuid, text) from public, anon, authenticated;
revoke all on function public.zq_push_bills(uuid) from public, anon, authenticated;
grant execute on function public.zq_usage_take(uuid, text, int) to service_role;
grant execute on function public.zq_usage_refund(uuid, text) to service_role;
grant execute on function public.zq_push_bills(uuid) to service_role;
grant all on public.zq_profiles, public.zq_usage, public.zq_push_subs, public.zq_push_log, public.zq_kv to service_role;

