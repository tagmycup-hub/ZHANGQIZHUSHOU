import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listProviders, pickProvider, usefulProviders, supaFnUrl, recognize, type ProviderInfo } from '../src/lib/ocr/providers';

const P = (id: ProviderInfo['id'], available: boolean): ProviderInfo => ({ id, available, label: id, sendsImage: id !== 'local', cost: '' });
const T = { url: 'https://abcd.supabase.co/', key: 'sb_publishable_xyz_0123456789' };
beforeEach(() => vi.stubGlobal('location', { hostname: 'tagmycup-hub.github.io', origin: 'https://tagmycup-hub.github.io' }));
afterEach(() => vi.unstubAllGlobals());

describe('识别通道选择', () => {
  it('函数地址由同步配置的 Project URL 生成', () => {
    expect(supaFnUrl(T)).toBe('https://abcd.supabase.co/functions/v1/recognize');
    expect(supaFnUrl({ ...T, url: 'https://abcd.supabase.co/rest/v1' })).toBe('https://abcd.supabase.co/functions/v1/recognize');
  });
  it('识别函数名：可填名称或粘贴整个网址', async () => {
    const { normalizeFn } = await import('../src/lib/ocr/providers');
    expect(normalizeFn('https://abcd.supabase.co/functions/v1/quick-api')).toBe('https://abcd.supabase.co/functions/v1/quick-api');
    expect(normalizeFn('https://abcd.supabase.co/functions/v1/quick-api/health/')).toBe('https://abcd.supabase.co/functions/v1/quick-api');
    expect(normalizeFn(' /functions/v1/quick-api ')).toBe('quick-api');
    expect(normalizeFn('')).toBe('');
    expect(normalizeFn('https://ABCD.supabase.co/functions/v1/quick-api', 'https://abcd.supabase.co/')).toBe('quick-api');
    expect(supaFnUrl({ ...T, fn: 'quick-api' })).toBe('https://abcd.supabase.co/functions/v1/quick-api');
    expect(supaFnUrl({ ...T, fn: 'https://other.supabase.co/functions/v1/x' })).toBe('https://other.supabase.co/functions/v1/x');
  });
  it('开通 AI 识别后不会卡在本机 OCR；上次用内置 AI 则沿用', () => {
    const ps = [P('supabase', true), P('claude', false), P('server', true), P('local', true)];
    expect(pickProvider(ps, 'local')).toBe('supabase');
    expect(pickProvider(ps, 'server')).toBe('supabase');
    expect(pickProvider([P('supabase', true), P('claude', true), P('local', true)], 'claude')).toBe('claude');
    expect(pickProvider([P('supabase', false), P('server', true), P('local', true)], null)).toBe('server');
    expect(pickProvider([P('supabase', false), P('local', true)], null)).toBe('local');
  });
  it('识别页只显示有用的通道', () => {
    const ps = [P('supabase', false), P('claude', false), P('server', false), P('local', true)];
    expect(usefulProviders(ps).map((p) => p.id)).toEqual(['supabase', 'local']);
  });
  it('Supabase 状态：未连接同步 / 未部署 / JWT 校验 / 缺密钥 / 可用', async () => {
    const sb = async (status: number, body: unknown = {}) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
      return (await listProviders('/api/recognize', '', T))[0];
    };
    expect((await listProviders('/api/recognize', '', null))[0].reason).toMatch(/云同步/);
    expect((await sb(404)).reason).toMatch(/找不到识别函数「recognize」/);
    expect((await sb(401)).reason).toMatch(/Verify JWT/);
    expect((await sb(200, { configured: false })).reason).toMatch(/GEMINI_API_KEY/);
    expect((await sb(200, { configured: true, auth: true, tokenOk: false })).reason).toMatch(/同一个项目/);
    const ok = await sb(200, { configured: true, provider: 'gemini', auth: true, tokenOk: true });
    expect(ok).toMatchObject({ available: true, label: 'AI 识别 · Gemini' });
  });
  it('识别请求只带 publishable key（apikey 头），不带任何模型密钥', async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ result: { items: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    await recognize('supabase', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), { endpoint: '/api/recognize', supa: T, signal: new AbortController().signal });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://abcd.supabase.co/functions/v1/recognize');
    expect(init.headers).toMatchObject({ apikey: T.key, 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toMatchObject({ mediaType: 'image/jpeg', imageBase64: 'AQID' });
  });
});
