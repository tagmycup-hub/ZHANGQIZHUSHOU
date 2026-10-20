import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import worker from '../worker/dist/zhangqi-worker.js';
import fixture from './fixtures/ticket-258.model.json';
import { normalizeModelOutput } from '../src/lib/ocr/protocol';

let upstream: http.Server;
let env: Record<string, string>;
let upstreamStatus = 200;
beforeAll(async () => {
  upstream = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    for await (const _ of req);
    if (upstreamStatus !== 200) return res.writeHead(upstreamStatus).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(fixture) }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  env = {
    ANTHROPIC_API_KEY: 'worker-secret',
    ANTHROPIC_API_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/messages`,
    ALLOWED_ORIGINS: 'https://user.github.io',
    ACCESS_TOKEN: 'abc123',
    RATE_PER_MIN: '50',
  };
});
afterAll(() => upstream?.close());

const W = 'https://zq.example.workers.dev';
const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const post = (headers: Record<string, string> = {}, body: unknown = { mediaType: 'image/png', imageBase64: png }) =>
  worker.fetch(new Request(`${W}/api/recognize`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://user.github.io', ...headers }, body: JSON.stringify(body) }), env);

describe('Cloudflare Worker', () => {
  it('打包文件内嵌的提示词与 shared 保持一致', () => {
    const bundled = readFileSync('worker/dist/zhangqi-worker.js', 'utf8');
    const prompt = readFileSync('shared/recognize-prompt.txt', 'utf8');
    const firstLine = prompt.split('\n')[0];
    expect(bundled).toContain(firstLine);
    expect(bundled).toContain('不得为了让小计或总额相等而修改');
  });
  it('health 报告配置与口令状态，不泄露密钥', async () => {
    const r = await worker.fetch(new Request(`${W}/api/health`, { headers: { origin: 'https://user.github.io', 'x-access-token': 'abc123' } }), env);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, configured: true, auth: true, tokenOk: true });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://user.github.io');
    expect(JSON.stringify(j)).not.toContain('worker-secret');
    const r2 = await worker.fetch(new Request(`${W}/api/health`), env);
    expect((await r2.json()).tokenOk).toBe(false);
  });
  it('CORS 预检只放行允许的来源', async () => {
    const ok = await worker.fetch(new Request(`${W}/api/recognize`, { method: 'OPTIONS', headers: { origin: 'https://user.github.io' } }), env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-headers')).toContain('x-access-token');
    const bad = await worker.fetch(new Request(`${W}/api/recognize`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('没有口令或口令错误返回 401', async () => {
    expect((await post()).status).toBe(401);
    const r = await post({ 'x-access-token': 'wrong', 'cf-connecting-ip': '9.9.9.9' });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/口令/);
  });
  it('口令正确时返回可校验的识别结果', async () => {
    const r = await post({ 'x-access-token': 'abc123' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(normalizeModelOutput(j.result).items).toHaveLength(4);
    expect(j.model).toBe('claude-sonnet-5');
  });
  it('上游密钥错误给出可操作的中文提示', async () => {
    upstreamStatus = 401;
    const r = await post({ 'x-access-token': 'abc123' });
    upstreamStatus = 200;
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/ANTHROPIC_API_KEY/);
  });
  it('错误口令多次尝试后限流', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await post({ 'x-access-token': 'x', 'cf-connecting-ip': '7.7.7.7' })).status;
    expect(last).toBe(429);
  });
  it('非 API 路径返回说明文字', async () => {
    const r = await worker.fetch(new Request(`${W}/`), env);
    expect(await r.text()).toContain('/api/recognize');
  });
});
