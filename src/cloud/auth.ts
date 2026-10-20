/**
 * 账号登录（Supabase Auth）。直接调 GoTrue REST，不引入 SDK。
 *  - 邮箱 + 密码（不发任何邮件；Supabase 需关闭「Confirm email」）
 *      POST /auth/v1/signup                          注册（返回会话）
 *      POST /auth/v1/token?grant_type=password       登录
 *  - 邮箱验证码（需要能发邮件的 SMTP）
 *      POST /auth/v1/otp     发验证码（新邮箱自动注册）
 *      POST /auth/v1/verify  验证码换会话
 *   POST /auth/v1/token?grant_type=refresh_token  续期
 */
export interface Project {
  url: string;
  key: string;
}
export interface Session {
  url: string;
  key: string;
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳 */
  expiresAt: number;
  user: { id: string; email: string };
}

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const base = (p: Project) => p.url.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');

async function call(p: Project, path: string, body: unknown, fetchImpl: FetchLike, bearer?: string) {
  let r: Response;
  try {
    r = await fetchImpl(`${base(p)}/auth/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: p.key.trim(), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('network', '连不上登录服务，请检查网络');
  }
  const text = await r.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const msg = String(j?.msg || j?.message || j?.error_description || j?.error || text || '').slice(0, 200);
    if (r.status === 429 || /rate limit|too many|security purposes/i.test(msg)) throw new AuthError('rate', '发送太频繁：请稍等 1 分钟再试（Supabase 自带邮件每小时只能发几封，正式上线请配置自己的 SMTP）');
    if (/invalid login credentials/i.test(msg)) throw new AuthError('bad_password', '邮箱或密码不正确');
    if (/email not confirmed/i.test(msg)) throw new AuthError('not_confirmed', '这个邮箱还没确认：请管理员在 Supabase → Authentication → Sign In / Providers → Email 关闭「Confirm email」，或在 Users 里手动确认这个用户');
    if (/already registered|already exists|user_already_exists/i.test(msg)) throw new AuthError('exists', '这个邮箱已经注册过了，请直接登录');
    if (/password/i.test(msg) && /(short|least|weak|characters)/i.test(msg)) throw new AuthError('weak_password', `密码太简单：${msg}`);
    if (/error sending (confirmation|magic link)? ?email|sending.*email/i.test(msg) && path === 'signup') throw new AuthError('confirm_on', '注册时要发确认邮件但发不出去：请在 Supabase → Authentication → Sign In / Providers → Email 关闭「Confirm email」后再注册');
    if (/expired|invalid|otp/i.test(msg) && path === 'verify') throw new AuthError('bad_code', '验证码不正确或已过期，请重新获取');
    if (/error sending|smtp|email.*send/i.test(msg)) throw new AuthError('smtp', '验证码邮件发不出去：请检查 Supabase → Authentication → Emails → SMTP Settings（主机、端口、用户名、密码），或先关闭自定义 SMTP 用自带邮件');
    if (/signups? not allowed|disabled/i.test(msg)) throw new AuthError('signup_off', '这个项目关闭了新用户注册');
    if (/email address .* invalid|unable to validate email/i.test(msg)) throw new AuthError('bad_email', '邮箱地址不正确');
    if (/refresh token/i.test(msg)) throw new AuthError('session_expired', '登录已过期，请重新登录');
    throw new AuthError('server', `登录服务出错（${r.status}）：${msg || '未知错误'}`);
  }
  return j;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

export async function sendCode(p: Project, email: string, fetchImpl: FetchLike = fetch): Promise<void> {
  if (!isEmail(email)) throw new AuthError('bad_email', '邮箱地址不正确');
  await call(p, 'otp', { email: email.trim().toLowerCase(), create_user: true }, fetchImpl);
}

function toSession(p: Project, j: any): Session {
  if (!j?.access_token || !j?.refresh_token || !j?.user?.id) throw new AuthError('server', '登录服务返回的数据不完整');
  const expiresAt = j.expires_at ? Number(j.expires_at) * 1000 : Date.now() + Number(j.expires_in || 3600) * 1000;
  return { url: base(p), key: p.key.trim(), accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt, user: { id: j.user.id, email: String(j.user.email || '').toLowerCase() } };
}

export async function verifyCode(p: Project, email: string, code: string, fetchImpl: FetchLike = fetch): Promise<Session> {
  const token = code.replace(/\s/g, '');
  if (!/^\d{6,10}$/.test(token)) throw new AuthError('bad_code', '请输入邮件里的数字验证码');
  return toSession(p, await call(p, 'verify', { type: 'email', email: email.trim().toLowerCase(), token }, fetchImpl));
}

export async function signInPassword(p: Project, email: string, password: string, fetchImpl: FetchLike = fetch): Promise<Session> {
  if (!isEmail(email)) throw new AuthError('bad_email', '邮箱地址不正确');
  if (!password) throw new AuthError('bad_password', '请输入密码');
  return toSession(p, await call(p, 'token?grant_type=password', { email: email.trim().toLowerCase(), password }, fetchImpl));
}

export async function signUpPassword(p: Project, email: string, password: string, fetchImpl: FetchLike = fetch): Promise<Session> {
  if (!isEmail(email)) throw new AuthError('bad_email', '邮箱地址不正确');
  if (password.length < 8) throw new AuthError('weak_password', '密码至少 8 位');
  const j = await call(p, 'signup', { email: email.trim().toLowerCase(), password }, fetchImpl);
  // 开着「Confirm email」时只返回用户、没有会话
  if (!j?.access_token) throw new AuthError('confirm_on', '注册成功，但这个项目要求先点确认邮件：请管理员在 Supabase → Authentication → Sign In / Providers → Email 关闭「Confirm email」，或在 Users 里手动确认后再登录');
  return toSession(p, j);
}

export async function refreshSession(s: Session, fetchImpl: FetchLike = fetch): Promise<Session> {
  return toSession(s, await call(s, 'token?grant_type=refresh_token', { refresh_token: s.refreshToken }, fetchImpl));
}

export async function signOutRemote(s: Session, fetchImpl: FetchLike = fetch): Promise<void> {
  await call(s, 'logout', {}, fetchImpl, s.accessToken).catch(() => {});
}

/** 快过期（1 分钟内）就续期 */
export function needsRefresh(s: Session, now = Date.now()): boolean {
  return s.expiresAt - now < 60_000;
}
