/**
 * 账号版后端（Supabase Edge Function 内运行）：账号、订阅（Mercado Pago）、AI 额度、Web Push。
 * 所有数据库读写用项目的 secret / service role key，经 PostgREST；表都开了 RLS 且不对外开放。
 *
 * 需要的 Secrets（Edge Functions → Secrets）：
 *   GEMINI_API_KEY            AI 识别
 *   MP_ACCESS_TOKEN           Mercado Pago 访问令牌（不填 = 不开放订阅；试用结束后只读）
 *   MP_WEBHOOK_SECRET         可选：Mercado Pago 通知签名密钥（填了就校验 x-signature）
 *   OWNER_EMAILS              管理员邮箱（逗号分隔；全部功能、不限额度）
 *   套餐与价格见 shared/plans.mjs（试用 30 天 + AI 5 次；T1 / T2 月付或年付）
 *   ALLOW_KEY_ONLY            =1 时允许不登录、只凭 publishable key 使用 AI 识别（旧版自用模式）
 *   PUSH_SUBJECT              可选：推送联系人（mailto:你的邮箱）
 * SUPABASE_URL / SUPABASE_*_KEY(S) 由平台自动提供。
 */
import { billStatus, inReminderWindow } from '../src/lib/status';
import { openCents, isPartial } from '../src/lib/payments';
import { formatBRL } from '../src/lib/money';
import { relativeDue, todayISO } from '../src/lib/dates';
import { generateVapidKeys, sendPush } from '../server/webpush.mjs';
import { entitlement, priceOf, monthKey, PLANS, TRIAL } from '../shared/plans.mjs';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}


export function saasConfig(env) {
  const get = (k) => env[k] || '';
  let secret = '';
  try {
    const j = JSON.parse(get('SUPABASE_SECRET_KEYS') || '{}');
    secret = j.default || Object.values(j)[0] || '';
  } catch {}
  secret = secret || get('SUPABASE_SERVICE_ROLE_KEY');
  let publishable = '';
  try {
    const j = JSON.parse(get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    publishable = j.default || Object.values(j)[0] || '';
  } catch {}
  publishable = publishable || get('SUPABASE_ANON_KEY');
  return {
    url: get('SUPABASE_URL').replace(/\/+$/, ''),
    secret,
    publishable,
    anon: get('SUPABASE_ANON_KEY'),
    mpToken: get('MP_ACCESS_TOKEN'),
    mpWebhookSecret: get('MP_WEBHOOK_SECRET'),
    mpApi: get('MP_API_URL') || 'https://api.mercadopago.com',
    owners: get('OWNER_EMAILS')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    allowKeyOnly: /^(1|true|yes|on)$/i.test(get('ALLOW_KEY_ONLY')),
    pushSubject: get('PUSH_SUBJECT') || 'mailto:noreply@zhangqi.app',
  };
}

export function createSaas({ fetchImpl = (...a) => fetch(...a), log = () => {}, now = () => new Date() } = {}) {
  /* ---------- PostgREST（service role） ---------- */
  function dbHeaders(c, extra = {}) {
    const h = { apikey: c.secret, 'content-type': 'application/json', ...extra };
    if (c.secret.startsWith('eyJ')) h.authorization = `Bearer ${c.secret}`;
    return h;
  }
  async function db(c, path, init = {}) {
    if (!c.url || !c.secret) throw new ApiError(500, '函数缺少 SUPABASE_URL 或 service key');
    const r = await fetchImpl(`${c.url}/rest/v1/${path}`, { ...init, headers: dbHeaders(c, init.headers) });
    const text = await r.text();
    if (!r.ok) {
      log(`[saas] db ${path.split('?')[0]} HTTP ${r.status} ${text.slice(0, 160)}`);
      if (/does not exist|PGRST20[25]|Could not find/i.test(text)) throw new ApiError(500, '数据库还没升级：请在 Supabase SQL Editor 重新运行最新的 setup.sql', 'no_setup');
      throw new ApiError(500, `数据库错误（${r.status}）`);
    }
    return text ? JSON.parse(text) : null;
  }
  const rpc = (c, fn, args) => db(c, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

  async function kvGet(c, key) {
    const rows = await db(c, `zq_kv?key=eq.${encodeURIComponent(key)}&select=value`);
    return rows?.[0]?.value ?? null;
  }
  async function kvSet(c, key, value) {
    await db(c, 'zq_kv', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key, value, updated_at: now().toISOString() }) });
  }

  /* ---------- 用户 ---------- */
  const userCache = new Map();
  /** 从 Authorization: Bearer <用户 JWT> 取当前用户；没有登录返回 null，令牌无效抛 401 */
  async function getUser(c, request) {
    const h = request.headers.get('authorization') || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1].trim();
    // publishable / anon key 不是用户令牌
    if (token === c.publishable || token === c.anon || token.startsWith('sb_')) return null;
    const hit = userCache.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    const r = await fetchImpl(`${c.url}/auth/v1/user`, { headers: { apikey: c.publishable || c.secret, authorization: `Bearer ${token}` } });
    if (!r.ok) throw new ApiError(401, '登录已过期，请重新登录', 'session_expired');
    const u = await r.json();
    if (!u?.id) throw new ApiError(401, '登录已过期，请重新登录', 'session_expired');
    const user = { id: u.id, email: String(u.email || '').toLowerCase() };
    userCache.set(token, { user, exp: Date.now() + 60_000 });
    if (userCache.size > 500) userCache.clear();
    return user;
  }
  async function requireUser(c, request) {
    const u = await getUser(c, request);
    if (!u) throw new ApiError(401, '请先登录（设置 → 账号）', 'login_required');
    return u;
  }

  /* ---------- 套餐与额度 ---------- */
  async function getProfile(c, user) {
    const rows = await db(c, `zq_profiles?user_id=eq.${user.id}&select=*`);
    let p = rows?.[0];
    if (!p) {
      await db(c, 'zq_profiles', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ user_id: user.id, email: user.email }) });
      p = (await db(c, `zq_profiles?user_id=eq.${user.id}&select=*`))?.[0] ?? { user_id: user.id, email: user.email, plan: null, trial_until: new Date(now().getTime() + TRIAL.days * 86400000).toISOString() };
    }
    // 管理员：数据库里也标记为 owner（同步写入权限按数据库判断）
    if (c.owners.includes(user.email) && p.plan !== 'owner') {
      await db(c, `zq_profiles?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ plan: 'owner', updated_at: now().toISOString() }) });
      p = { ...p, plan: 'owner' };
    }
    return p;
  }
  const entOf = (c, user, profile) => entitlement(profile, { email: user.email, owners: c.owners, now: now() });
  async function usedOf(c, user, key) {
    if (!key) return 0;
    const rows = await db(c, `zq_usage?user_id=eq.${user.id}&month=eq.${encodeURIComponent(key)}&select=ai`);
    return rows?.[0]?.ai ?? 0;
  }

  /** AI 识别前：登录 + 按套餐扣额度；识别失败退还 */
  async function authorizeRecognize(request, env) {
    const c = saasConfig(env);
    let user;
    try {
      user = await getUser(c, request);
    } catch (e) {
      return { ok: false, status: e.status || 401, error: e.message, code: e.code };
    }
    if (!user) {
      if (c.allowKeyOnly) {
        const given = request.headers.get('apikey') || request.headers.get('x-access-token') || '';
        const keys = [c.publishable, env.SUPABASE_ANON_KEY, ...String(env.ACCESS_TOKEN || '').split(',')].filter(Boolean);
        return keys.includes(given) ? { ok: true } : { ok: false, status: 401, error: '访问口令不正确' };
      }
      return { ok: false, status: 401, error: 'AI 识别需要先登录账号', code: 'login_required' };
    }
    try {
      const ent = entOf(c, user, await getProfile(c, user));
      if (ent.plan === 'expired') return { ok: false, status: 402, code: 'expired', error: '试用已结束：订阅 T1 或 T2 后继续使用 AI 识别' };
      const n = await rpc(c, 'zq_usage_take', { p_user: user.id, p_month: ent.ai.key, p_limit: ent.ai.limit });
      if (n === -1 || n === null) {
        const msg = ent.plan === 'trial' ? `试用期的 ${ent.ai.limit} 次 AI 识别已用完：订阅后每月 ${PLANS.t1.ai}～${PLANS.t2.ai} 次` : ent.plan === 't1' ? `本月 ${ent.ai.limit} 次 AI 识别已用完：升级 T2 每月 ${PLANS.t2.ai} 次，或下月 1 日恢复` : `本月 ${ent.ai.limit} 次 AI 识别已用完，下月 1 日恢复`;
        return { ok: false, status: 402, code: 'quota', error: msg };
      }
      return {
        ok: true,
        key: `u:${user.id}`,
        done: async (success) => {
          if (!success) {
            await rpc(c, 'zq_usage_refund', { p_user: user.id, p_month: ent.ai.key }).catch(() => {});
            return undefined;
          }
          return { used: n, limit: ent.ai.limit, plan: ent.plan };
        },
      };
    } catch (e) {
      return { ok: false, status: e.status || 500, error: e.message, code: e.code };
    }
  }

  async function me(c, request) {
    const user = await requireUser(c, request);
    let p = await getProfile(c, user);
    // 付款回来后 webhook 可能还没到：有待支付的订阅时主动查一次
    if (c.mpToken && p.mp_preapproval_id && p.mp_status === 'pending') {
      p = (await refreshPreapproval(c, p.mp_preapproval_id).catch(() => null)) ?? p;
    }
    const ent = entOf(c, user, p);
    await rememberFnUrl(c, request).catch(() => {});
    return {
      email: user.email,
      ...ent,
      subscription: p.mp_preapproval_id ? { status: p.mp_status ?? null, plan: p.pending_plan ?? null } : null,
      usage: { period: ent.ai.key, ai: await usedOf(c, user, ent.ai.key), limit: ent.ai.limit },
      billing: c.mpToken ? { currency: 'BRL', plans: PLANS, trial: TRIAL } : null,
    };
  }

  /* ---------- Mercado Pago 订阅 ---------- */
  async function mp(c, path, init = {}) {
    if (!c.mpToken) throw new ApiError(503, '还没开通订阅收款（服务器未配置 MP_ACCESS_TOKEN）', 'billing_off');
    const r = await fetchImpl(`${c.mpApi}${path}`, { ...init, headers: { authorization: `Bearer ${c.mpToken}`, 'content-type': 'application/json', ...(init.headers || {}) } });
    const text = await r.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {}
    if (!r.ok) {
      log(`[billing] MP ${path.split('?')[0]} HTTP ${r.status} ${(j?.message || text).slice(0, 200)}`);
      throw new ApiError(502, `Mercado Pago 返回错误（${r.status}）：${j?.message || '请稍后再试'}`);
    }
    return j;
  }

  /** external_reference = 用户ID|套餐|周期 */
  const parseRef = (ref) => {
    const [userId, plan, period] = String(ref || '').split('|');
    return { userId, plan: plan === 't1' || plan === 't2' ? plan : 't2', period: period === 'year' ? 'year' : 'month' };
  };

  /** 以 Mercado Pago 为准刷新订阅状态，写回 profile */
  async function refreshPreapproval(c, id) {
    const pa = await mp(c, `/preapproval/${encodeURIComponent(id)}`);
    const ref = parseRef(pa.external_reference);
    if (!ref.userId || !/^[0-9a-f-]{36}$/i.test(ref.userId)) throw new ApiError(400, '订阅缺少用户信息');
    const rows = await db(c, `zq_profiles?user_id=eq.${ref.userId}&select=*`);
    const cur = rows?.[0];
    if (!cur) throw new ApiError(404, '找不到订阅对应的账号');
    const patch = { updated_at: now().toISOString() };
    const isCurrent = !cur.mp_preapproval_id || cur.mp_preapproval_id === pa.id;
    if (pa.status === 'authorized') {
      // 已授权：有效期到下次扣款日再宽限 3 天；扣款失败时 MP 会改状态，过期后自动只读
      const next = pa.next_payment_date ? Date.parse(pa.next_payment_date) : NaN;
      const fallback = (ref.period === 'year' ? 368 : 33) * 86400000;
      const until = Number.isFinite(next) ? next + 3 * 86400000 : now().getTime() + fallback;
      const keep = cur.plan === ref.plan && cur.plan_until ? Date.parse(cur.plan_until) : 0;
      Object.assign(patch, { plan: cur.plan === 'owner' ? 'owner' : ref.plan, period: ref.period, plan_until: new Date(Math.max(until, keep)).toISOString(), mp_preapproval_id: pa.id, mp_status: 'authorized', pending_plan: null });
      // 换套餐：新订阅生效后取消旧订阅
      const old = cur.mp_preapproval_id && cur.mp_preapproval_id !== pa.id ? cur.mp_preapproval_id : null;
      if (old) {
        await mp(c, `/preapproval/${encodeURIComponent(old)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }).catch(() => {});
        log(`[billing] switched ${old} -> ${pa.id}`);
      }
    } else if (isCurrent) {
      patch.mp_status = pa.status;
      patch.mp_preapproval_id = pa.id;
    } else if (pa.status === 'pending') {
      patch.pending_id = pa.id;
    }
    await db(c, `zq_profiles?user_id=eq.${ref.userId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    return { ...cur, ...patch };
  }

  async function checkout(c, request) {
    const user = await requireUser(c, request);
    if (!user.email) throw new ApiError(400, '账号没有邮箱');
    const body = await request.json().catch(() => ({}));
    const plan = body.plan;
    const period = body.period ?? 'month';
    const price = priceOf(plan, period);
    if (price === null) throw new ApiError(400, '请选择套餐（T1 / T2）和付款周期（月付 / 年付）');
    const back = String(body.returnUrl || '');
    if (!/^https:\/\/[^\s]+$/.test(back) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/.test(back)) throw new ApiError(400, '返回地址必须是 https 网址');
    const profile = await getProfile(c, user);
    const ent = entOf(c, user, profile);
    if (ent.plan === plan && profile.mp_status === 'authorized' && ent.period === period) throw new ApiError(409, `你已经订阅了 ${PLANS[plan].name}`);
    const pa = await mp(c, '/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: `账期助手 ${PLANS[plan].name}（${period === 'year' ? '年付' : '月付'}）`,
        external_reference: `${user.id}|${plan}|${period}`,
        payer_email: user.email,
        back_url: back,
        status: 'pending',
        auto_recurring: { frequency: period === 'year' ? 12 : 1, frequency_type: 'months', transaction_amount: price, currency_id: 'BRL' },
      }),
    });
    if (!pa.init_point) throw new ApiError(502, 'Mercado Pago 没有返回付款链接');
    // 还没有生效的订阅时，把新订阅记为当前；已有生效订阅（换套餐）时先记为待生效，付款成功后再切换
    const patch = profile.mp_status === 'authorized' ? { pending_id: pa.id, pending_plan: plan } : { mp_preapproval_id: pa.id, mp_status: pa.status ?? 'pending', pending_plan: plan };
    await db(c, `zq_profiles?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: now().toISOString() }) });
    return { url: pa.init_point };
  }

  async function cancel(c, request) {
    const user = await requireUser(c, request);
    const profile = await getProfile(c, user);
    if (!profile.mp_preapproval_id) throw new ApiError(400, '没有进行中的订阅');
    await mp(c, `/preapproval/${encodeURIComponent(profile.mp_preapproval_id)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
    const p = await refreshPreapproval(c, profile.mp_preapproval_id);
    return { status: p.mp_status, planUntil: p.plan_until ?? null };
  }

  /** 定时任务里顺便核对订阅（防止漏掉 Mercado Pago 通知） */
  async function reconcileSubscriptions(c) {
    if (!c.mpToken) return 0;
    const soon = new Date(now().getTime() + 5 * 86400000).toISOString();
    const rows = (await db(c, `zq_profiles?select=user_id,mp_preapproval_id,pending_id,mp_status,plan_until&mp_preapproval_id=not.is.null`)) ?? [];
    let n = 0;
    for (const r of rows) {
      const due = r.mp_status === 'pending' || (r.mp_status === 'authorized' && (!r.plan_until || r.plan_until < soon));
      for (const id of [due ? r.mp_preapproval_id : null, r.pending_id].filter(Boolean)) {
        await refreshPreapproval(c, id).then(() => n++).catch(() => {});
      }
    }
    return n;
  }

  /** x-signature 校验（填了 MP_WEBHOOK_SECRET 时） */
  async function verifyMpSignature(c, request, dataId) {
    if (!c.mpWebhookSecret) return true;
    const sig = request.headers.get('x-signature') || '';
    const reqId = request.headers.get('x-request-id') || '';
    const parts = Object.fromEntries(sig.split(',').map((p) => p.trim().split('=').map((x) => x.trim())));
    if (!parts.ts || !parts.v1) return false;
    const manifest = `${dataId ? `id:${String(dataId).toLowerCase()};` : ''}${reqId ? `request-id:${reqId};` : ''}ts:${parts.ts};`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.mpWebhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.length === parts.v1.length && hex === parts.v1.toLowerCase();
  }

  async function webhook(c, request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const type = String(body.type || body.topic || url.searchParams.get('type') || url.searchParams.get('topic') || '');
    const id = String(body.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id') || '');
    if (!id) return { ignored: true };
    if (!(await verifyMpSignature(c, request, url.searchParams.get('data.id') || id))) throw new ApiError(401, 'invalid signature');
    // 不信任通知内容：一律回 Mercado Pago 查真实状态
    if (/subscription_authorized_payment|authorized_payment/.test(type)) {
      const ap = await mp(c, `/authorized_payments/${encodeURIComponent(id)}`);
      if (ap?.preapproval_id) await refreshPreapproval(c, ap.preapproval_id);
      return { ok: true };
    }
    if (/preapproval/.test(type)) {
      await refreshPreapproval(c, id);
      return { ok: true };
    }
    return { ignored: true };
  }

  /* ---------- Web Push ---------- */
  /** 记住函数自己的网址（定时任务用）：SUPABASE_URL + /functions/v1/<函数名> */
  async function rememberFnUrl(c, request) {
    const segs = new URL(request.url).pathname.split('/').filter(Boolean);
    const i = segs.indexOf('v1');
    const slug = segs[0] === 'functions' && i >= 0 ? segs[i + 1] : segs[0];
    if (!slug || !c.url) return;
    const fnUrl = `${c.url}/functions/v1/${slug}`;
    if ((await kvGet(c, 'fn_url')) !== fnUrl) await kvSet(c, 'fn_url', fnUrl);
  }

  async function vapid(c) {
    const raw = await kvGet(c, 'vapid');
    if (raw) return JSON.parse(raw);
    const keys = await generateVapidKeys();
    await db(c, 'zq_kv', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ key: 'vapid', value: JSON.stringify(keys) }) });
    // 并发时以数据库里先写入的为准
    return JSON.parse((await kvGet(c, 'vapid')) ?? JSON.stringify(keys));
  }

  async function subscribe(c, request) {
    const user = await requireUser(c, request);
    if (!entOf(c, user, await getProfile(c, user)).features.push) throw new ApiError(402, '关屏推送是 T1 / T2 套餐的功能', 'plan_required');
    const b = await request.json().catch(() => ({}));
    const endpoint = String(b.endpoint || '');
    const p256dh = String(b.keys?.p256dh || '');
    const auth = String(b.keys?.auth || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) throw new ApiError(400, '推送订阅无效');
    await db(c, 'zq_push_subs', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ endpoint, user_id: user.id, p256dh, auth, ua: String(request.headers.get('user-agent') || '').slice(0, 200), fails: 0 }),
    });
    await rememberFnUrl(c, request).catch(() => {});
    return { ok: true };
  }

  async function unsubscribe(c, request) {
    const user = await requireUser(c, request);
    const b = await request.json().catch(() => ({}));
    const endpoint = String(b.endpoint || '');
    await db(c, `zq_push_subs?user_id=eq.${user.id}${endpoint ? `&endpoint=eq.${encodeURIComponent(endpoint)}` : ''}`, { method: 'DELETE' });
    return { ok: true };
  }

  async function sendToSubs(c, subs, payload) {
    const keys = await vapid(c);
    let sent = 0;
    for (const s of subs) {
      try {
        const r = await sendPush(s, payload, keys, { subject: c.pushSubject, fetchImpl });
        if (r.ok) {
          sent++;
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'PATCH', body: JSON.stringify({ last_ok: now().toISOString(), fails: 0 }) });
        } else if (r.gone || (s.fails ?? 0) >= 5) {
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' });
        } else {
          log(`[push] HTTP ${r.status}`);
          await db(c, `zq_push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'PATCH', body: JSON.stringify({ fails: (s.fails ?? 0) + 1 }) });
        }
      } catch (e) {
        log(`[push] send failed ${e?.message ?? e}`);
      }
    }
    return sent;
  }

  async function pushTest(c, request) {
    const user = await requireUser(c, request);
    const subs = await db(c, `zq_push_subs?user_id=eq.${user.id}&select=*`);
    if (!subs?.length) throw new ApiError(400, '这台设备还没开启推送');
    const sent = await sendToSubs(c, subs, { title: '账期助手 · 测试推送', body: '关屏推送正常。每天圣保罗时间 09:00 左右提醒到期账单。', tag: 'zq-test', url: './#/bills' });
    return { sent, devices: subs.length };
  }

  /** 每个用户一条摘要：今天要处理的账单（提醒期内 + 逾期） */
  function digest(bills, today) {
    const due = bills.filter((b) => !b.deletedAt && !String(b.id).startsWith('sample') && inReminderWindow(b, today));
    if (!due.length) return null;
    const overdue = due.filter((b) => billStatus(b, today) === 'overdue');
    due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const total = due.reduce((s, b) => s + openCents(b), 0);
    const lines = due.slice(0, 4).map((b) => `${b.merchantNameSnapshot || '账单'} · ${isPartial(b) ? `还差 ${formatBRL(openCents(b))}` : formatBRL(b.totalCents)} · ${relativeDue(b.dueDate, today)}`);
    if (due.length > 4) lines.push(`…还有 ${due.length - 4} 笔`);
    return {
      title: overdue.length ? `${overdue.length} 笔已逾期 · 共 ${due.length} 笔要处理` : `付款提醒：${due.length} 笔，共 ${formatBRL(total)}`,
      body: lines.join('\n'),
      tag: `zq-digest-${today}`,
      url: './#/bills/unpaid',
    };
  }

  async function cron(c, request) {
    const token = request.headers.get('x-cron-token') || '';
    const want = await kvGet(c, 'cron_token');
    if (!want || token !== want) throw new ApiError(401, 'bad cron token');
    const today = todayISO(now());
    const reconciled = await reconcileSubscriptions(c).catch(() => 0);
    const subs = (await db(c, 'zq_push_subs?select=*')) ?? [];
    const profiles = new Map(((await db(c, 'zq_profiles?select=*')) ?? []).map((p) => [p.user_id, p]));
    const byUser = new Map();
    subs.forEach((s) => byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]));
    let users = 0;
    let sent = 0;
    for (const [userId, list] of byUser) {
      const prof = profiles.get(userId);
      if (!entitlement(prof ?? null, { email: prof?.email ?? '', owners: c.owners, now: now() }).features.push) continue;
      const key = `${userId}|${today}`;
      const done = await db(c, `zq_push_log?key=eq.${encodeURIComponent(key)}&select=key`);
      if (done?.length) continue;
      const rows = (await rpc(c, 'zq_push_bills', { p_user: userId })) ?? [];
      const d = digest(rows.map((r) => ({ ...r.data, id: r.id })), today);
      if (!d) continue;
      users++;
      sent += await sendToSubs(c, list, d);
      await db(c, 'zq_push_log', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ key }) });
    }
    log(`[push] cron ${today} users=${users} sent=${sent} reconciled=${reconciled}`);
    return { users, sent };
  }

  /** 路由：返回 Response，或 null（交给识别处理器） */
  async function route(request, env, sub, cors) {
    const c = saasConfig(env);
    const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });
    const handlers = {
      'GET /me': () => me(c, request),
      'POST /billing/checkout': () => checkout(c, request),
      'POST /billing/cancel': () => cancel(c, request),
      'POST /billing/webhook': () => webhook(c, request),
      'GET /push/key': async () => ({ publicKey: (await vapid(c)).publicKey }),
      'POST /push/subscribe': () => subscribe(c, request),
      'POST /push/unsubscribe': () => unsubscribe(c, request),
      'POST /push/test': () => pushTest(c, request),
      'POST /push/cron': () => cron(c, request),
    };
    const h = handlers[`${request.method} ${sub}`];
    if (!h) return null;
    try {
      return json(200, await h());
    } catch (e) {
      if (!(e instanceof ApiError)) log(`[saas] ${sub} ${e?.stack ?? e}`);
      return json(e instanceof ApiError ? e.status : 500, { error: e instanceof ApiError ? e.message : '服务器内部错误', code: e?.code });
    }
  }

  async function health(request, env) {
    const c = saasConfig(env);
    let user = null;
    try {
      user = await getUser(c, request);
    } catch {}
    return { login: c.allowKeyOnly ? 'optional' : 'required', signedIn: !!user, billing: !!c.mpToken };
  }

  return { route, authorizeRecognize, health, digest, verifyMpSignature, saasConfig };
}
