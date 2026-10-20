import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
// @ts-ignore 打包后的 Supabase 函数（Deno 入口在 Node 下只导出 serve，不启动）
import { serve, supabaseEnv } from '../supabase/functions/recognize/index.ts';
import fixture from './fixtures/ticket-258.model.json';
import { normalizeModelOutput } from '../src/lib/ocr/protocol';

let upstream: http.Server;
let base = '';
let last: { url: string; headers: http.IncomingHttpHeaders; body: any } | null = null;
let mode: 'ok' | 'fenced' | 'blocked' | 'maxtokens' | 'quota' | 'badkey' | 'noitems' | 'busy' | 'busyOnce' | 'busyPrimary' | 'nothinking' = 'ok';
const seen: string[] = [];
let busyLeft = 0;
let listCalls = 0;

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    if (req.method === 'GET' && (req.url ?? '').startsWith('/v1beta/models')) {
      listCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
      ] }));
    }
    last = { url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') };
    seen.push(`${(req.url ?? '').split('/models/')[1]}${last.body.generationConfig?.thinkingConfig ? '+t' : ''}`);
    const overloaded = { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } };
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (mode === 'busy') return send(503, overloaded);
    if (mode === 'busyOnce' && busyLeft-- > 0) return send(503, overloaded);
    if (mode === 'busyPrimary' && (req.url ?? '').includes('gemini-3.8-flash')) return send(503, overloaded);
    if ((req.url ?? '').includes('gemini-2.5-flash')) return send(404, { error: { code: 404, message: 'models/gemini-2.5-flash is not found for API version v1beta', status: 'NOT_FOUND' } });
    if (mode === 'nothinking' && last.body.generationConfig?.thinkingConfig) return send(400, { error: { code: 400, message: 'Thinking level is not supported for this model.', status: 'INVALID_ARGUMENT' } });
    if (mode === 'quota') return send(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    if (mode === 'badkey') return send(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
    if (mode === 'blocked') return send(200, { promptFeedback: { blockReason: 'SAFETY' } });
    if (mode === 'maxtokens') return send(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
    const text = mode === 'fenced' ? '```json\n' + JSON.stringify(fixture) + '\n```' : mode === 'noitems' ? JSON.stringify({ docType: 'boleto', merchant: { value: 'X' } }) : JSON.stringify(fixture);
    send(200, { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text }] }, finishReason: 'STOP' }] });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1beta`;
});
afterAll(() => upstream?.close());

const PUB = 'sb_publishable_TESTKEY_1234567890abcdef';
const ENV = () => ({
  GEMINI_API_KEY: 'gemini-secret',
  GEMINI_API_URL: base,
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUB }),
  SUPABASE_ANON_KEY: 'eyJ-legacy-anon',
  RATE_PER_MIN: '100',
  ALLOW_KEY_ONLY: '1',
});
const F = 'https://abcd.supabase.co/functions/v1/recognize';
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const call = (headers: Record<string, string> = {}, env: Record<string, string> = ENV()) =>
  serve(new Request(F, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://tagmycup-hub.github.io', ...headers }, body: JSON.stringify({ mediaType: 'image/png', imageBase64: png }) }), env);

describe('Supabase Edge Function + Gemini', () => {
  it('health：报告 Gemini 通道和模型，不泄露密钥；需要本项目 key', async () => {
    const r = await serve(new Request(F + '/health', { headers: { apikey: PUB, origin: 'https://x.github.io' } }), ENV());
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, configured: true, provider: 'gemini', model: 'gemini-3.8-flash', auth: true, tokenOk: true });
    expect(JSON.stringify(j)).not.toContain('gemini-secret');
    expect(r.headers.get('access-control-allow-origin')).toBe('https://x.github.io');
    const r2 = await serve(new Request(F + '/health'), ENV());
    expect((await r2.json()).tokenOk).toBe(false);
  });
  it('CORS 预检放行 apikey 请求头', async () => {
    const r = await serve(new Request(F, { method: 'OPTIONS', headers: { origin: 'https://x.github.io' } }), ENV());
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-headers')).toContain('apikey');
  });
  it('没带本项目 key 返回 401；旧版 anon key 也可以', async () => {
    expect((await call()).status).toBe(401);
    expect((await call({ apikey: 'sb_publishable_other_project_key' })).status).toBe(401);
    expect((await call({ apikey: 'eyJ-legacy-anon' })).status).toBe(200);
  });
  it('调用 Gemini generateContent：图片内联、JSON 模式、密钥只在服务端请求头；跳过思考片段', async () => {
    mode = 'ok';
    const r = await call({ apikey: PUB });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(normalizeModelOutput(j.result).items).toHaveLength(4);
    expect(j.model).toBe('gemini-3.8-flash');
    expect(last!.url).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
    expect(last!.headers['x-goog-api-key']).toBe('gemini-secret');
    expect(last!.body.generationConfig.responseMimeType).toBe('application/json');
    expect(last!.body.contents[0].parts[0].inline_data).toEqual({ mime_type: 'image/png', data: png });
    expect(last!.body.contents[0].parts[1].text).toContain('不得为了让小计或总额相等而修改');
    expect(JSON.stringify(j)).not.toContain('gemini-secret');
  });
  it('容错：代码块包裹、缺 items 的单据（boleto）', async () => {
    mode = 'fenced';
    expect((await call({ apikey: PUB })).status).toBe(200);
    mode = 'noitems';
    const r = await call({ apikey: PUB });
    expect(r.status).toBe(200);
    expect((await r.json()).result.items).toEqual([]);
    mode = 'ok';
  });
  it('Gemini 繁忙（503）自动重试；主模型一直繁忙时换备用模型；不支持思考级别时自动去掉', async () => {
    mode = 'busyOnce';
    busyLeft = 1;
    seen.length = 0;
    expect((await call({ apikey: PUB })).status).toBe(200);
    expect(seen).toEqual(['gemini-3.8-flash:generateContent+t', 'gemini-3.8-flash:generateContent+t']);
    mode = 'busyPrimary';
    seen.length = 0;
    const r = await call({ apikey: PUB });
    expect(r.status).toBe(200);
    // 自动发现可用模型：优先非 lite，排除图像/嵌入模型
    expect(seen.at(-1)).toBe('gemini-3.5-flash:generateContent+t');
    expect(listCalls).toBe(1);
    // 配置的备用模型不存在（404）时继续自动发现
    mode = 'busyPrimary';
    seen.length = 0;
    expect((await call({ apikey: PUB }, { ...ENV(), GEMINI_FALLBACK_MODELS: 'gemini-2.5-flash' })).status).toBe(200);
    expect(seen.map((x) => x.split(':')[0])).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-3.5-flash']);
    mode = 'nothinking';
    seen.length = 0;
    expect((await call({ apikey: PUB })).status).toBe(200);
    expect(seen).toEqual(['gemini-3.8-flash:generateContent+t', 'gemini-3.8-flash:generateContent']);
    mode = 'busy';
    const r2 = await call({ apikey: PUB });
    expect(r2.status).toBe(503);
    // 全部繁忙：报主模型繁忙，而不是备用模型「不可用」
    expect((await r2.json()).error).toMatch(/gemini-3\.8-flash.*繁忙/);
    mode = 'ok';
  }, 60000);
  it('上游错误给出可操作的中文提示', async () => {
    const cases: [typeof mode, number, RegExp][] = [
      ['quota', 429, /额度/],
      ['badkey', 502, /GEMINI_API_KEY/],
      ['blocked', 422, /安全策略/],
      ['maxtokens', 502, /截断/],
    ];
    for (const [m, status, re] of cases) {
      mode = m;
      const r = await call({ apikey: PUB });
      expect(r.status).toBe(status);
      expect((await r.json()).error).toMatch(re);
    }
    mode = 'ok';
  });
  it('两种密钥都填时默认 Gemini，可用 AI_PROVIDER 指定；都没填时提示配置', async () => {
    const env = { ...ENV(), ANTHROPIC_API_KEY: 'a' };
    const h = async (e: Record<string, string>) => (await (await serve(new Request(F + '/health', { headers: { apikey: PUB } }), e)).json()).provider;
    expect(await h(env)).toBe('gemini');
    expect(await h({ ...env, AI_PROVIDER: 'anthropic' })).toBe('anthropic');
    const none: Record<string, string> = { ...ENV() };
    delete none.GEMINI_API_KEY;
    const r = await call({ apikey: PUB }, none);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/GEMINI_API_KEY/);
  });
  it('自定 ACCESS_TOKEN 与项目 key 并存；默认允许任意来源（由 key 把关）', () => {
    const e = supabaseEnv({ ACCESS_TOKEN: 'mine', SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUB, web: 'sb_publishable_web' }) });
    expect(e.ACCESS_TOKEN).toBe(`mine,${PUB},sb_publishable_web`);
    expect(e.ALLOWED_ORIGINS).toBe('*');
    expect(supabaseEnv({ ALLOWED_ORIGINS: 'https://a.github.io' }).ALLOWED_ORIGINS).toBe('https://a.github.io');
  });
  it('打包文件是独立单文件（无 import），可直接粘贴到控制台', () => {
    const src = readFileSync('supabase/functions/recognize/index.ts', 'utf8');
    expect(src).not.toMatch(/^import /m);
    expect(src).toContain('Deno.serve');
  });
});
