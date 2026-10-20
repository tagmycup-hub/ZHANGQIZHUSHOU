/**
 * Supabase Edge Function 入口（Deno）。打包后的单文件：supabase/functions/recognize/index.ts，
 * 可直接粘贴到 Supabase 控制台的函数编辑器（函数名随意，App 里「识别函数名」填一致即可）。
 *
 * 路由（都在同一个函数下）：
 *   POST /            AI 识别（登录用户按套餐扣额度）
 *   GET  /health      状态
 *   GET  /me          账号、套餐、本月用量
 *   POST /billing/checkout | /billing/cancel | /billing/webhook   Mercado Pago 订阅
 *   GET  /push/key    POST /push/subscribe | /push/unsubscribe | /push/test | /push/cron   关屏推送
 * 函数设置里要关闭「Verify JWT」：认证由本函数自己做（publishable key 不是 JWT）。
 */
import prompt from '../shared/recognize-prompt.txt';
import { createHandler } from '../server/core.mjs';
import { createSaas } from './saas.mjs';

const log = (m) => console.log(m);
const saas = createSaas({ log });
const handle = createHandler({ prompt, log, authorize: saas.authorizeRecognize, health: saas.health });

/** 本项目可接受的客户端 key：新版 publishable keys（JSON）+ 旧版 anon key */
export function projectKeys(get) {
  const keys = [];
  try {
    const j = JSON.parse(get('SUPABASE_PUBLISHABLE_KEYS') || '{}');
    for (const v of Object.values(j)) if (typeof v === 'string' && v) keys.push(v);
  } catch {}
  const anon = get('SUPABASE_ANON_KEY');
  if (anon) keys.push(anon);
  return keys;
}

export function supabaseEnv(all) {
  const get = (k) => all[k] || '';
  const keys = projectKeys(get);
  const token = [get('ACCESS_TOKEN'), ...keys].filter(Boolean).join(',');
  return { ...all, ACCESS_TOKEN: token, ALLOWED_ORIGINS: get('ALLOWED_ORIGINS') || '*' };
}

const ROUTES = ['/billing/checkout', '/billing/cancel', '/billing/webhook', '/push/key', '/push/subscribe', '/push/unsubscribe', '/push/test', '/push/cron', '/me'];

function cors(req, env) {
  const origin = req.headers.get('origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''));
  if (!allowed.includes('*') && !allowed.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

export async function serve(req, all) {
  const env = supabaseEnv(all);
  const u = new URL(req.url);
  const path = u.pathname.replace(/\/+$/, '');
  const sub = ROUTES.find((r) => path.endsWith(r));
  if (sub && req.method !== 'OPTIONS') {
    const res = await saas.route(req, env, sub, cors(req, env));
    if (res) return res;
  }
  const inner = new Request(new URL(/\/health$/.test(path) ? '/api/health' : '/api/recognize', u.origin).href, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
  });
  return (await handle(inner, env)) ?? new Response('not found', { status: 404 });
}

if (typeof Deno !== 'undefined' && Deno.serve) {
  Deno.serve((req) => serve(req, Deno.env.toObject()));
}
