-- 账期助手 · 每天圣保罗 09:00 推送到期提醒（在 SQL Editor 运行一次；可重复运行）
-- 前提：已运行 setup.sql，并在 App 里登录、开启过一次「关屏推送」（函数会记下自己的网址）。
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 定时任务与函数之间的口令（只存在数据库里）
insert into public.zq_kv(key, value)
values ('cron_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

select cron.unschedule(jobid) from cron.job where jobname = 'zq-daily-push';
select cron.schedule(
  'zq-daily-push',
  '0 12 * * *', -- 12:00 UTC = 圣保罗 09:00
  $$
  select net.http_post(
    url := (select value from public.zq_kv where key = 'fn_url') || '/push/cron',
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-token', (select value from public.zq_kv where key = 'cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
