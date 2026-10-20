import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fixture from './fixtures/ticket-258.model.json';
import { normalizeModelOutput } from '../src/lib/ocr/protocol';
import { RECOGNIZE_PROMPT } from '../src/lib/ocr/prompt';

let upstream: http.Server;
let app: http.Server;
let base = '';
let lastUpstreamBody: any = null;
let upstreamMode: 'ok' | 'fenced' | 'garbage' | 'error' = 'ok';

beforeAll(async () => {
  upstream = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let b = '';
    for await (const c of req) b += c;
    lastUpstreamBody = { headers: req.headers, body: JSON.parse(b) };
    if (upstreamMode === 'error') return res.writeHead(500).end('{}');
    const text = upstreamMode === 'ok' ? JSON.stringify(fixture) : upstreamMode === 'fenced' ? '结果如下：\n```json\n' + JSON.stringify(fixture) + '\n```' : '看不清';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/messages`;
  process.env.RATE_PER_MIN = '100';
  const mod = await import('../server/index.mjs');
  app = mod.server;
  await new Promise<void>((r) => app.listen(0, r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => {
  upstream?.close();
  app?.close();
});

const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');

describe('识别服务', () => {
  it('health 不泄露密钥', async () => {
    const r = await (await fetch(`${base}/api/health`)).json();
    expect(r.configured).toBe(true);
    expect(JSON.stringify(r)).not.toContain('test-key');
  });
  it('调用模型并返回可被前端校验的 JSON；密钥只在服务端请求头', async () => {
    upstreamMode = 'ok';
    const r = await fetch(`${base}/api/recognize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mediaType: 'image/png', imageBase64: png }) });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(JSON.stringify(j)).not.toContain('test-key');
    const out = normalizeModelOutput(j.result);
    expect(out.items).toHaveLength(4);
    expect(lastUpstreamBody.headers['x-api-key']).toBe('test-key-not-real');
    const content = lastUpstreamBody.body.messages[0].content;
    expect(content[0].source.media_type).toBe('image/png');
    expect(content[1].text).toBe(RECOGNIZE_PROMPT);
  });
  it('容错解析代码块', async () => {
    upstreamMode = 'fenced';
    const r = await fetch(`${base}/api/recognize`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/jpeg', imageBase64: png }) });
    expect(r.status).toBe(200);
  });
  it('非 JSON 输出与上游错误给出中文错误', async () => {
    upstreamMode = 'garbage';
    let r = await fetch(`${base}/api/recognize`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/jpeg', imageBase64: png }) });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/JSON/);
    upstreamMode = 'error';
    r = await fetch(`${base}/api/recognize`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/jpeg', imageBase64: png }) });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/繁忙/);
  }, 20000);
  it('拒绝错误类型与无效数据', async () => {
    let r = await fetch(`${base}/api/recognize`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/gif', imageBase64: png }) });
    expect(r.status).toBe(415);
    r = await fetch(`${base}/api/recognize`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', imageBase64: '<script>' }) });
    expect(r.status).toBe(400);
    r = await fetch(`${base}/api/recognize`, { method: 'POST', body: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('提示词约束', () => {
  it('包含零编造规则', () => {
    expect(RECOGNIZE_PROMPT).toMatch(/看不清就返回 null/);
    expect(RECOGNIZE_PROMPT).toMatch(/不得为了让小计或总额相等而修改/);
    expect(RECOGNIZE_PROMPT).toMatch(/不得根据常识补全/);
  });
});

describe('Node 服务访问口令', () => {
  it('设置 ACCESS_TOKEN 后必须携带口令', async () => {
    process.env.ACCESS_TOKEN = 'n1';
    try {
      let r = await fetch(`${base}/api/recognize`, { method: 'POST', body: JSON.stringify({ mediaType: 'image/png', imageBase64: png }) });
      expect(r.status).toBe(401);
      upstreamMode = 'ok';
      r = await fetch(`${base}/api/recognize`, { method: 'POST', headers: { 'x-access-token': 'n1' }, body: JSON.stringify({ mediaType: 'image/png', imageBase64: png }) });
      expect(r.status).toBe(200);
    } finally {
      delete process.env.ACCESS_TOKEN;
    }
  });
});
