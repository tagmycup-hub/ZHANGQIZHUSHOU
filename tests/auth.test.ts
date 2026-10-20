import { describe, it, expect } from 'vitest';
import { signInPassword, signUpPassword, sendCode, AuthError } from '../src/cloud/auth';

const P = { url: 'https://p.supabase.co/', key: 'sb_publishable_x_0123456789abcdef' };
const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const session = { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u1', email: 'Ana@Example.com' } };

describe('邮箱 + 密码登录（不发邮件）', () => {
  it('注册：关闭 Confirm email 时直接返回会话', async () => {
    let seen: any = null;
    const s = await signUpPassword(P, 'ana@example.com', 'segredo123', async (u, i) => {
      seen = { u, body: JSON.parse(String(i!.body)), apikey: (i!.headers as any).apikey };
      return new Response(JSON.stringify(session), { status: 200 });
    });
    expect(seen).toMatchObject({ u: 'https://p.supabase.co/auth/v1/signup', body: { email: 'ana@example.com', password: 'segredo123' }, apikey: P.key });
    expect(s.user.email).toBe('ana@example.com');
  });
  it('注册：开着 Confirm email（只返回用户或发信失败）给出关闭方法', async () => {
    await expect(signUpPassword(P, 'a@b.co', 'segredo123', reply(200, { id: 'u1', email: 'a@b.co' }))).rejects.toThrow(/Confirm email/);
    await expect(signUpPassword(P, 'a@b.co', 'segredo123', reply(500, { msg: 'Error sending confirmation email' }))).rejects.toThrow(/关闭「Confirm email」/);
    await expect(signUpPassword(P, 'a@b.co', 'short', reply(200, session))).rejects.toThrow(/至少 8 位/);
    await expect(signUpPassword(P, 'a@b.co', 'segredo123', reply(422, { code: 'user_already_exists', msg: 'User already registered' }))).rejects.toThrow(/已经注册过/);
  });
  it('登录：错密码、未确认邮箱都有中文提示', async () => {
    const s = await signInPassword(P, 'ana@example.com', 'segredo123', async (u) => {
      expect(u).toBe('https://p.supabase.co/auth/v1/token?grant_type=password');
      return new Response(JSON.stringify(session), { status: 200 });
    });
    expect(s.accessToken).toBe('a');
    await expect(signInPassword(P, 'a@b.co', 'x', reply(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }))).rejects.toThrow('邮箱或密码不正确');
    await expect(signInPassword(P, 'a@b.co', 'x', reply(400, { error_description: 'Email not confirmed' }))).rejects.toThrow(/还没确认/);
  });
  it('验证码邮件发不出去时提示检查 SMTP', async () => {
    const e = await sendCode(P, 'a@b.co', reply(500, { msg: 'Error sending magic link email' })).catch((x) => x);
    expect(e).toBeInstanceOf(AuthError);
    expect(e.message).toMatch(/SMTP/);
  });
});
