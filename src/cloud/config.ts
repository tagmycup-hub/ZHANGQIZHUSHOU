/**
 * 公开部署配置：网站根目录的 zq-config.json（可选）。
 * 给别人用（账号 + 订阅）时，把 Supabase 的 Project URL、publishable key 和函数名写在这里，
 * 用户打开网页就能直接登录，不需要自己配置同步。
 * {
 *   "supabaseUrl": "https://xxxx.supabase.co",
 *   "publishableKey": "sb_publishable_...",
 *   "functionName": "recognize"
 * }
 */
export interface PublicConfig {
  url: string;
  key: string;
  fn: string;
}

export function parsePublicConfig(j: unknown): PublicConfig | null {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const url = String(o.supabaseUrl ?? '').trim().replace(/\/+$/, '');
  const key = String(o.publishableKey ?? '').trim();
  if (!/^https:\/\/[^/\s]+$/.test(url) || key.length < 20) return null;
  return { url, key, fn: String(o.functionName ?? '').trim() };
}

export async function loadPublicConfig(fetchImpl: typeof fetch = fetch): Promise<PublicConfig | null> {
  try {
    const r = await fetchImpl('./zq-config.json', { cache: 'no-store' });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return parsePublicConfig(await r.json());
  } catch {
    return null;
  }
}
