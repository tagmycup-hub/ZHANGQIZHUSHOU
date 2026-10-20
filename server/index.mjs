/**
 * 账期助手 · 识别服务（Node 18+，零依赖）
 *
 *   GEMINI_API_KEY=... ACCESS_TOKEN=自定口令 node server/index.mjs   （或 ANTHROPIC_API_KEY=sk-...）
 *
 * - POST /api/recognize  { mediaType, imageBase64 } → { result, rawText, model }
 * - GET  /api/health     → { ok, configured, provider, model, auth, tokenOk }
 * - 若存在 dist/ 目录，同时作为静态站点服务（生产部署一条命令）
 *
 * 业务逻辑在 server/core.mjs，与 Cloudflare Worker 版本共用。
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHandler } from './core.mjs';

export { extractJson } from './core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const PROMPT = await readFile(path.join(ROOT, 'shared/recognize-prompt.txt'), 'utf8');
const DIST = path.join(ROOT, 'dist');
const handle = createHandler({ prompt: PROMPT, log: (m) => console.log(m) });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(DIST, p));
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error();
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': p.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(await readFile(file));
  } catch {
    try {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(await readFile(path.join(DIST, 'index.html')));
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '未找到。开发时请用 npm run dev 访问前端。' }));
    }
  }
}

export const server = http.createServer(async (req, res) => {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  if (new URL(url).pathname.startsWith('/api/')) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    if (!headers.get('x-forwarded-for') && req.socket.remoteAddress) headers.set('x-forwarded-for', req.socket.remoteAddress);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await handle(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405).end();
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () =>
    console.log(`账期助手识别服务 http://localhost:${PORT}  (模型 ${process.env.GEMINI_API_KEY ? 'Gemini ' + (process.env.GEMINI_MODEL || 'gemini-3.8-flash') : process.env.ANTHROPIC_API_KEY ? 'Claude ' + (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5') : '未配置密钥'}, 口令 ${process.env.ACCESS_TOKEN ? '已开启' : '未开启'})`),
  );
}
