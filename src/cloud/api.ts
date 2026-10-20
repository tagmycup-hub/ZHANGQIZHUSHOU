/** 账号版函数接口（与 supabase/saas.mjs 对应） */
import { supaFnUrl, type SupaTarget } from '../lib/ocr/providers';
import type { Entitlement, PlanDef, PlanId, Period } from '../../shared/plans.mjs';
export { PLAN_LABEL } from '../../shared/plans.mjs';

export interface AccountInfo extends Entitlement {
  email: string;
  subscription: { status: string | null; plan: string | null } | null;
  usage: { period: string | null; ai: number; limit: number };
  billing: { currency: string; plans: Record<PlanId, PlanDef>; trial: { days: number; ai: number } } | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fnCall<T>(t: SupaTarget, token: string | null, path: string, init: { method?: string; body?: unknown } = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  let r: Response;
  try {
    r = await fetchImpl(`${supaFnUrl(t)}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { apikey: t.key.trim(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, '连接不到服务（识别函数未部署，或网络受限）', 'network');
  }
  const text = await r.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    if (r.status === 404) throw new ApiError(404, '服务端还没升级到账号版：请把最新的识别函数代码部署到 Supabase', 'old_function');
    throw new ApiError(r.status, j?.error || `服务出错（${r.status}）`, j?.code);
  }
  return j as T;
}

export const getAccount = (t: SupaTarget, token: string) => fnCall<AccountInfo>(t, token, '/me');
export const startCheckout = (t: SupaTarget, token: string, plan: PlanId, period: Period, returnUrl: string) => fnCall<{ url: string }>(t, token, '/billing/checkout', { body: { plan, period, returnUrl } });
export const cancelSubscription = (t: SupaTarget, token: string) => fnCall<{ status: string; planUntil: string | null }>(t, token, '/billing/cancel', { body: {} });
export const pushKey = (t: SupaTarget) => fnCall<{ publicKey: string }>(t, null, '/push/key');
export const pushSubscribe = (t: SupaTarget, token: string, sub: PushSubscriptionJSON) => fnCall<{ ok: true }>(t, token, '/push/subscribe', { body: sub });
export const pushUnsubscribe = (t: SupaTarget, token: string, endpoint: string) => fnCall<{ ok: true }>(t, token, '/push/unsubscribe', { body: { endpoint } });
export const pushTest = (t: SupaTarget, token: string) => fnCall<{ sent: number; devices: number }>(t, token, '/push/test', { body: {} });

