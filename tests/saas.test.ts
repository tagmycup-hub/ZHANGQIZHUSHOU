import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore 打包后的 Supabase 函数
import { serve } from '../supabase/functions/recognize/index.ts';
// @ts-ignore
import { createPostgrest } from './support/postgrest.mjs';
// @ts-ignore
import ece from 'http_ece';
import fixture from './fixtures/ticket-258.model.json';

const SB = 'https://proj.supabase.co';
const MPAPI = 'https://mp.test';
const GEM = 'https://gem.test/v1beta';
const PUB = 'sb_publishable_TEST_0123456789abcdef';
const SECRET = 'sb_secret_TEST_0123456789abcdef';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const TOKENS: Record<string, { id: string; email: string }> = { 'jwt-u1': { id: U1, email: 'ana@example.com' }, 'jwt-u2': { id: U2, email: 'boss@example.com' }, 'jwt-u3': { id: U3, email: 'cris@example.com' } };

let pg: PGlite;
let rest: ReturnType<typeof createPostgrest>;
let gemini: 'ok' | 'busy' = 'ok';
const mpStore = new Map<string, { id: string; status: string; external_reference: string; next_payment_date: string }>();
const authorize = (id: string) => (mpStore.get(id)!.status = 'authorized');
const mpCalls: { method: string; path: string; body: any }[] = [];
const pushes: { endpoint: string; headers: Record<string, string>; body: Uint8Array }[] = [];
let pushStatus = 201;

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init.headers);
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : init.body;
  const json = (status: number, obj: unknown) => new Response(obj === undefined ? '' : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (url.startsWith(`${SB}/auth/v1/user`)) {
    const t = (headers.get('authorization') || '').replace(/^Bearer /, '');
    const u = TOKENS[t];
    return u ? json(200, { id: u.id, email: u.email }) : json(401, { msg: 'invalid JWT' });
  }
  if (url.startsWith(`${SB}/rest/v1/`)) {
    const key = headers.get('apikey');
    const bearer = (headers.get('authorization') || '').replace(/^Bearer /, '');
    const role = key === SECRET ? 'service' : TOKENS[bearer] ? 'user' : 'anon';
    const r = await rest({ method: init.method || 'GET', path: url.slice(SB.length), body: body as string, role, sub: TOKENS[bearer]?.id ?? null, prefer: headers.get('prefer') || '' });
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith(GEM)) {
    if (url.includes('/models?')) return json(200, { models: [] });
    if (gemini === 'busy') return json(503, { error: { code: 503, message: 'overloaded' } });
    return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(fixture) }] }, finishReason: 'STOP' }] });
  }
  if (url.startsWith(MPAPI)) {
    const path = url.slice(MPAPI.length);
    const b = body ? JSON.parse(body as string) : null;
    mpCalls.push({ method: init.method || 'GET', path, body: b });
    if (headers.get('authorization') !== 'Bearer TEST-mp-token') return json(401, { message: 'invalid token' });
    if (path === '/preapproval' && init.method === 'POST') {
      const id = `pa${mpStore.size + 1}`;
      mpStore.set(id, { id, status: 'pending', external_reference: b.external_reference, next_payment_date: '2026-11-20T10:00:00.000-03:00' });
      return json(201, { id, status: 'pending', init_point: `https://mp.test/checkout/${id}`, external_reference: b.external_reference });
    }
    const m = path.match(/^\/preapproval\/(\w+)$/);
    if (m && mpStore.has(m[1])) {
      const pa = mpStore.get(m[1])!;
      if (init.method === 'PUT') pa.status = b.status;
      return json(200, pa);
    }
    if (path === '/authorized_payments/ap9') return json(200, { id: 'ap9', preapproval_id: 'pa1' });
    return json(404, { message: 'not found' });
  }
  if (url.startsWith('https://push.test/')) {
    pushes.push({ endpoint: url, headers: Object.fromEntries(headers), body: new Uint8Array(body as Uint8Array) });
    return new Response('', { status: pushStatus });
  }
  throw new Error(`unexpected fetch ${url}`);
}

const ENV = (extra: Record<string, string> = {}) => ({
  SUPABASE_URL: SB,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUB }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  GEMINI_API_KEY: 'g-secret',
  GEMINI_API_URL: GEM,
  GEMINI_FALLBACK_MODELS: '',
  RATE_PER_MIN: '100',
  MP_API_URL: MPAPI,
  ...extra,
});
const F = `${SB}/functions/v1/quick-api`;
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const call = (path: string, { token, method, body, headers, env }: { token?: string; method?: string; body?: unknown; headers?: Record<string, string>; env?: Record<string, string> } = {}) =>
  serve(
    new Request(F + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { apikey: PUB, origin: 'https://app.github.io', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env ?? ENV(),
  );
const recognizeAs = (token?: string, env?: Record<string, string>) => call('', { token, body: { mediaType: 'image/png', imageBase64: png }, env });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
  await pg.exec(readFileSync('supabase/setup.sql', 'utf8'));
  await pg.query(`insert into auth.users(id, email) values ($1, 'ana@example.com'), ($2, 'boss@example.com'), ($3, 'cris@example.com')`, [U1, U2, U3]);
  rest = createPostgrest(pg);
  vi.stubGlobal('fetch', fakeFetch);
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  gemini = 'ok';
  pushStatus = 201;
});

describe('账号版：试用 30 天 + AI 5 次，到期只读', () => {
  it('没登录：识别返回 401（login_required），health 报告需要登录', async () => {
    const r = await recognizeAs();
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe('login_required');
    const h = await (await call('/health')).json();
    expect(h).toMatchObject({ login: 'required', signedIn: false, configured: true });
    expect((await (await call('/health', { token: 'jwt-u1' })).json()).signedIn).toBe(true);
  });
  it('登录令牌无效 → 401 会话过期', async () => {
    const r = await recognizeAs('jwt-bad');
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/登录已过期/);
  });
  it('新用户自动开始 30 天试用：基础功能开，推送和导出关', async () => {
    const j = await (await call('/me', { token: 'jwt-u1' })).json();
    expect(j).toMatchObject({ email: 'ana@example.com', plan: 'trial', daysLeft: 30, features: { edit: true, push: false, export: false }, usage: { period: 'trial', ai: 0, limit: 5 }, billing: null });
    expect((await call('/me')).status).toBe(401);
    const kv = await pg.query(`select value from zq_kv where key = 'fn_url'`);
    expect(kv.rows[0]).toEqual({ value: `${SB}/functions/v1/quick-api` });
  });
  it('试用期 AI 识别共 5 次：成功才计次，失败退还，用完返回 402', async () => {
    const r = await recognizeAs('jwt-u1');
    expect(r.status).toBe(200);
    expect((await r.json()).usage).toEqual({ used: 1, limit: 5, plan: 'trial' });
    gemini = 'busy';
    expect((await recognizeAs('jwt-u1')).status).toBe(503);
    gemini = 'ok';
    for (let i = 0; i < 4; i++) expect((await recognizeAs('jwt-u1')).status).toBe(200);
    const r6 = await recognizeAs('jwt-u1');
    expect(r6.status).toBe(402);
    const j = await r6.json();
    expect(j.code).toBe('quota');
    expect(j.error).toMatch(/试用期的 5 次 AI 识别已用完/);
  });
  it('试用到期：AI 识别 402（expired），账号同步只能下载不能上传', async () => {
    await pg.query(`update zq_profiles set trial_until = now() - interval '1 day' where user_id = $1`, [U1]);
    const r = await recognizeAs('jwt-u1');
    expect(r.status).toBe(402);
    expect((await r.json()).code).toBe('expired');
    expect((await (await call('/me', { token: 'jwt-u1' })).json()).features.edit).toBe(false);
    const push = await rest({ method: 'POST', path: '/rest/v1/rpc/zq_me_push', body: JSON.stringify({ p_rows: [] }), role: 'user', sub: U1 });
    expect(push.status).toBe(400);
    expect(push.body).toMatch(/ZQ_READONLY/);
    const pull = await rest({ method: 'POST', path: '/rest/v1/rpc/zq_me_pull', body: JSON.stringify({ p_since: 0 }), role: 'user', sub: U1 });
    expect(pull.status).toBe(200);
  });
  it('管理员邮箱：全部功能、不限额度；ALLOW_KEY_ONLY=1 时允许旧版只凭 key 使用', async () => {
    const env = ENV({ OWNER_EMAILS: 'boss@example.com' });
    const r = await recognizeAs('jwt-u2', env);
    expect((await r.json()).usage).toMatchObject({ limit: -1, plan: 'owner' });
    expect((await (await call('/me', { token: 'jwt-u2', env })).json()).features).toEqual({ edit: true, push: true, export: true });
    expect((await recognizeAs(undefined, ENV({ ALLOW_KEY_ONLY: '1' }))).status).toBe(200);
  });
});

describe('订阅（Mercado Pago）：T1 / T2，月付或年付', () => {
  const MP = { MP_ACCESS_TOKEN: 'TEST-mp-token' };
  it('/me 列出套餐价格；创建 T1 年付订阅：每 12 个月扣 R$ 89,99', async () => {
    const me = await (await call('/me', { token: 'jwt-u1', env: ENV(MP) })).json();
    expect(me.billing.plans).toMatchObject({ t1: { month: 7.99, year: 89.99, ai: 20 }, t2: { month: 19.98, year: 199.99, ai: 50 } });
    expect((await call('/billing/checkout', { token: 'jwt-u1', body: { plan: 't3', period: 'month', returnUrl: 'https://app.github.io/zq/?mp=1' }, env: ENV(MP) })).status).toBe(400);
    const r = await call('/billing/checkout', { token: 'jwt-u1', body: { plan: 't1', period: 'year', returnUrl: 'https://app.github.io/zq/?mp=1' }, env: ENV(MP) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: 'https://mp.test/checkout/pa1' });
    const c = mpCalls.find((x) => x.path === '/preapproval' && x.method === 'POST')!;
    expect(c.body).toMatchObject({ external_reference: `${U1}|t1|year`, payer_email: 'ana@example.com', status: 'pending', reason: '账期助手 T1（年付）', auto_recurring: { frequency: 12, frequency_type: 'months', transaction_amount: 89.99, currency_id: 'BRL' } });
  });
  it('付款通知：签名错误拒绝；签名正确 → 回 Mercado Pago 查真实状态，开通 T1（推送开、导出关、AI 20 次/月）', async () => {
    authorize('pa1');
    const env = ENV({ ...MP, MP_WEBHOOK_SECRET: 'whsec' });
    const bad = await call('/billing/webhook?type=subscription_preapproval&data.id=pa1', { body: { type: 'subscription_preapproval', data: { id: 'pa1' } }, headers: { 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'r1' }, env });
    expect(bad.status).toBe(401);
    const ts = '1760000000';
    const v1 = crypto.createHmac('sha256', 'whsec').update(`id:pa1;request-id:r1;ts:${ts};`).digest('hex');
    const ok = await call('/billing/webhook?type=subscription_preapproval&data.id=pa1', { body: { type: 'subscription_preapproval', data: { id: 'pa1' } }, headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'r1' }, env });
    expect(ok.status).toBe(200);
    const me = await (await call('/me', { token: 'jwt-u1', env: ENV(MP) })).json();
    expect(me).toMatchObject({ plan: 't1', period: 'year', features: { edit: true, push: true, export: false }, usage: { limit: 20 } });
    expect(me.usage.period).toMatch(/^\d{4}-\d{2}$/);
    expect(me.planUntil.slice(0, 10)).toBe('2026-11-23');
    // 订阅有效 → 可以上传
    const push = await rest({ method: 'POST', path: '/rest/v1/rpc/zq_me_push', body: JSON.stringify({ p_rows: [] }), role: 'user', sub: U1 });
    expect(push.status).toBe(200);
  });
  it('升级到 T2 月付：付款成功后自动切换并取消旧订阅；T2 可导出、AI 50 次/月', async () => {
    const r = await call('/billing/checkout', { token: 'jwt-u1', body: { plan: 't2', period: 'month', returnUrl: 'https://app.github.io/zq/?mp=1' }, env: ENV(MP) });
    expect(await r.json()).toEqual({ url: 'https://mp.test/checkout/pa2' });
    // 还没付款：仍是 T1
    expect((await (await call('/me', { token: 'jwt-u1', env: ENV(MP) })).json()).plan).toBe('t1');
    authorize('pa2');
    expect((await call('/billing/webhook', { body: { type: 'subscription_preapproval', data: { id: 'pa2' } }, env: ENV(MP) })).status).toBe(200);
    const me = await (await call('/me', { token: 'jwt-u1', env: ENV(MP) })).json();
    expect(me).toMatchObject({ plan: 't2', period: 'month', features: { export: true }, usage: { limit: 50 }, subscription: { status: 'authorized' } });
    expect(mpStore.get('pa1')!.status).toBe('cancelled');
  });
  it('取消续费：已付的期间照常可用', async () => {
    const r = await call('/billing/cancel', { token: 'jwt-u1', body: {}, env: ENV(MP) });
    expect(r.status).toBe(200);
    expect(mpStore.get('pa2')!.status).toBe('cancelled');
    const me = await (await call('/me', { token: 'jwt-u1', env: ENV(MP) })).json();
    expect(me).toMatchObject({ plan: 't2', subscription: { status: 'cancelled' } });
  });
});

describe('关屏推送', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const b64u = (b: Buffer) => b.toString('base64url');
  const sub = { endpoint: 'https://push.test/dev1', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } };
  const decrypt = (body: Uint8Array) => JSON.parse(ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: b64u(authSecret) }).toString('utf8'));

  it('VAPID 公钥只生成一次；订阅需要登录', async () => {
    const k1 = await (await call('/push/key')).json();
    const k2 = await (await call('/push/key')).json();
    expect(k1.publicKey).toBe(k2.publicKey);
    expect(Buffer.from(k1.publicKey, 'base64url').length).toBe(65);
    expect((await call('/push/subscribe', { body: sub })).status).toBe(401);
    // 试用用户没有推送功能
    const trial = await call('/push/subscribe', { token: 'jwt-u3', body: { ...sub, endpoint: 'https://push.test/dev2' } });
    expect(trial.status).toBe(402);
    expect((await trial.json()).error).toMatch(/T1 \/ T2/);
    expect((await call('/push/subscribe', { token: 'jwt-u1', body: sub })).status).toBe(200);
  });
  it('测试推送：内容按 RFC 8291 加密（接收端能解密），带 VAPID 签名', async () => {
    pushes.length = 0;
    const r = await call('/push/test', { token: 'jwt-u1', body: {} });
    expect(await r.json()).toEqual({ sent: 1, devices: 1 });
    const p = pushes[0];
    expect(p.headers['content-encoding']).toBe('aes128gcm');
    expect(p.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(decrypt(p.body).title).toMatch(/测试推送/);
    // VAPID JWT 能用公钥验证
    const [, jwt, k] = p.headers.authorization.match(/t=([^,]+), k=(.+)$/)!;
    const [h, pl, sig] = jwt.split('.');
    const pub = await crypto.webcrypto.subtle.importKey('raw', Buffer.from(k, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), Buffer.from(`${h}.${pl}`))).toBe(true);
    expect(JSON.parse(Buffer.from(pl, 'base64url').toString()).aud).toBe('https://push.test');
  });
  it('每日定时：口令不对拒绝；给有到期账单的用户发一条摘要；同一天不重复；订阅失效（410）自动删除', async () => {
    await pg.exec(readFileSync('supabase/push-cron.sql', 'utf8').replace(/create extension[^;]*;/g, '').replace(/select cron[\s\S]*$/m, ''));
    const token = (await pg.query(`select value from zq_kv where key = 'cron_token'`)).rows[0] as { value: string };
    expect((await call('/push/cron', { body: {}, headers: { 'x-cron-token': 'nope' } })).status).toBe(401);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    const bill = (id: string, due: string, extra: object = {}) => ({ id, merchantNameSnapshot: `Loja ${id}`, dueDate: due, reminderDays: 3, paidAt: null, totalCents: 36800, payments: [], items: [], ...extra });
    // 账号同步写入（以用户身份调用 zq_me_push）
    const rows = [bill('b1', today), bill('b2', '2099-01-01'), bill('b3', today, { paidAt: '2026-10-01T10:00:00Z' })].map((d) => ({ kind: 'bill', id: d.id, data: d, updated_at: new Date().toISOString(), deleted: false }));
    const pushRes = await rest({ method: 'POST', path: '/rest/v1/rpc/zq_me_push', body: JSON.stringify({ p_rows: rows }), role: 'user', sub: U1 });
    expect(JSON.parse(pushRes.body)).toEqual({ applied: 3 });
    pushes.length = 0;
    const r = await call('/push/cron', { body: {}, headers: { 'x-cron-token': token.value } });
    expect(await r.json()).toEqual({ users: 1, sent: 1 });
    const msg = decrypt(pushes[0].body);
    expect(msg.title).toBe('付款提醒：1 笔，共 R$ 368,00');
    expect(msg.body).toMatch(/Loja b1 · R\$ 368,00 · 今天到期/);
    expect(await (await call('/push/cron', { body: {}, headers: { 'x-cron-token': token.value } })).json()).toEqual({ users: 0, sent: 0 });
    pushStatus = 410;
    await call('/push/test', { token: 'jwt-u1', body: {} });
    expect((await pg.query(`select count(*)::int as n from zq_push_subs`)).rows[0]).toEqual({ n: 0 });
  });
});

describe('账号同步（数据库函数）', () => {
  it('只能读写自己的空间；未登录被拒；旧的口令空间不能冒用 u: 前缀', async () => {
    const pull = (sub: string | null) => rest({ method: 'POST', path: '/rest/v1/rpc/zq_me_pull', body: JSON.stringify({ p_since: 0 }), role: sub ? 'user' : 'anon', sub });
    const mine = JSON.parse((await pull(U1)).body);
    expect(mine.map((r: any) => r.id).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(JSON.parse((await pull(U2)).body)).toEqual([]);
    expect((await pull(null)).status).toBe(400);
    const hijack = await rest({ method: 'POST', path: '/rest/v1/rpc/zq_pull', body: JSON.stringify({ p_space: `u:${U1}`, p_secret: 'x'.repeat(16) }), role: 'anon' });
    expect(hijack.status).toBe(400);
    expect(hijack.body).toMatch(/ZQ_BAD_INPUT/);
    // 用量表对普通用户不开放
    expect((await rest({ method: 'GET', path: '/rest/v1/zq_usage?select=*', role: 'user', sub: U1 })).status).toBe(400);
  });
});
