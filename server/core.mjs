/**
 * 账期助手 · 识别服务核心（只用 Web 标准 API：Request / Response / fetch）
 * 同一份代码同时用于：
 *   - Node 服务（server/index.mjs）
 *   - Cloudflare Worker（worker/entry.mjs → worker/dist/zhangqi-worker.js）
 *
 * 环境变量（env）：二选一填模型密钥（只在服务端）
 *   GEMINI_API_KEY      Google Gemini 密钥（AI Studio 申请）；GEMINI_MODEL 默认 gemini-3.8-flash
 *   ANTHROPIC_API_KEY   Claude 密钥；ANTHROPIC_MODEL 默认 claude-sonnet-5
 *   AI_PROVIDER         可选：gemini / anthropic；两个密钥都填时用它指定（默认 gemini）
 *   GEMINI_API_URL / ANTHROPIC_API_URL  可选，测试用
 *   ALLOWED_ORIGINS     允许跨域调用的网页来源，逗号分隔，如 https://name.github.io
 *   ACCESS_TOKEN        可选但强烈建议：访问口令，防止他人盗用你的服务（可用逗号分隔多个；
 *                       请求头 x-access-token 或 apikey 任一匹配即可）
 *   MAX_IMAGE_BYTES / RECOGNIZE_TIMEOUT_MS / RATE_PER_MIN
 *
 * 票据内容不写日志；密钥不出现在任何响应中。
 */

import { withHints } from '../shared/hints.mjs';

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** 容错提取 JSON：整段 → 代码块 → 第一个 { 到最后一个 } */
export function extractJson(text) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(text.trim());
  if (v !== undefined) return v;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && (v = tryParse(fence[1])) !== undefined) return v;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a && (v = tryParse(text.slice(a, b + 1))) !== undefined) return v;
  return undefined;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 常量时间比较，避免口令被逐字符试探 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * opts.authorize(request, env)：可选的账号/额度检查（Supabase 账号版使用）。
 *   返回 { ok: false, status, error } 拒绝；或 { ok: true, key, done(success) }，识别结束后调用 done 记账/退还额度。
 * opts.health(request, env)：可选，给 /api/health 追加字段。
 */
export function createHandler({ prompt, log = () => {}, authorize = null, health = null }) {
  const hits = new Map();

  const cfg = (env) => {
    const gKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
    const aKey = env.ANTHROPIC_API_KEY || '';
    const want = String(env.AI_PROVIDER || '').toLowerCase();
    const provider = want === 'anthropic' && aKey ? 'anthropic' : want === 'gemini' && gKey ? 'gemini' : gKey ? 'gemini' : aKey ? 'anthropic' : null;
    return {
    provider,
    apiKey: provider === 'gemini' ? gKey : aKey,
    model: provider === 'gemini' ? env.GEMINI_MODEL || 'gemini-3.8-flash' : env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    apiUrl: provider === 'gemini' ? env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta' : env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages',
    thinking: env.GEMINI_THINKING === 'off' ? '' : env.GEMINI_THINKING || 'low',
    fallbacks: String(env.GEMINI_FALLBACK_MODELS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 整个识别请求的时间预算（Supabase 函数最长约 150 秒） */
    budget: Number(env.RECOGNIZE_BUDGET_MS || 120_000),
    origins: String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    tokens: String(env.ACCESS_TOKEN || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxBytes: Number(env.MAX_IMAGE_BYTES || 6 * 1024 * 1024),
    timeout: Number(env.RECOGNIZE_TIMEOUT_MS || 90_000),
    rate: Number(env.RATE_PER_MIN || 10),
    };
  };
  const KEY_ENV = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

  function rateLimited(key, limit) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > limit;
  }

  function corsHeaders(request, c) {
    const origin = request.headers.get('origin');
    if (!origin) return {};
    if (c.origins.includes('*') || c.origins.includes(origin)) {
      return {
        'access-control-allow-origin': origin,
        vary: 'Origin',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-access-token,apikey,authorization,x-client-info',
        'access-control-max-age': '86400',
      };
    }
    return {};
  }

  const json = (status, obj, extra = {}) =>
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });


  async function post(c, url, headers, body, timeout = c.timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      return await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new HttpError(504, '识别超时，请重试或裁小图片');
      throw new HttpError(502, '连接视觉模型失败');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 上游错误说明（Gemini/Anthropic 的 error.message，不含票据内容和密钥），便于在函数日志和前端排查 */
  function upstreamMessage(detail) {
    try {
      const j = JSON.parse(detail);
      const m = j?.error?.message || j?.message || '';
      return String(m).replace(/\s+/g, ' ').slice(0, 160);
    } catch {
      return '';
    }
  }

  function upstreamError(c, status, detail = '', model = c.model) {
    const msg = upstreamMessage(detail);
    log(`[recognize] upstream ${c.provider} ${model} HTTP ${status}${msg ? ' · ' + msg : ''}`);
    const keyName = KEY_ENV[c.provider];
    if (status === 503 || status === 529 || status === 500) return new HttpError(503, `模型「${model}」暂时繁忙（${status}），已自动重试，请过一会儿再点「重试」`);
    if (status === 401 || status === 403 || (status === 400 && /API key|API_KEY/i.test(detail))) return new HttpError(502, `模型密钥无效或没有权限，请检查服务器上的 ${keyName}`);
    if (status === 429) return new HttpError(429, '模型服务繁忙或今日免费额度已用完，请稍后再试');
    if (status === 404) return new HttpError(502, `模型「${model}」不可用，请检查 ${c.provider === 'gemini' ? 'GEMINI_MODEL' : 'ANTHROPIC_MODEL'}`);
    if (status === 400 && /location|region|not supported/i.test(detail)) return new HttpError(502, '模型服务在当前地区不可用');
    return new HttpError(502, `模型服务出错（${status}）${msg ? '：' + msg : ''}`);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRYABLE = new Set([500, 502, 503, 504, 529]);

  async function callAnthropic(c, mediaType, imageBase64, fullPrompt = prompt) {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
    r = await post(c, c.apiUrl, { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' }, {
      model: c.model,
      max_tokens: 6000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: fullPrompt },
          ],
        },
      ],
    });
    if (r.ok || !RETRYABLE.has(r.status) || attempt === 2) break;
    await sleep(1500 * (attempt + 1));
    }
    if (!r.ok) throw upstreamError(c, r.status, await r.text().catch(() => ''));
    const data = await r.json();
    return (data.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  }

  /** 列出这个密钥可用的 Gemini Flash 模型（每个实例缓存 1 小时），用于主模型繁忙/不可用时自动换 */
  let modelCache = null;
  async function discoverModels(c) {
    if (modelCache && modelCache.key === c.apiKey && Date.now() - modelCache.at < 3_600_000) return modelCache.list;
    let list = [];
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`${c.apiUrl.replace(/\/$/, '')}/models?pageSize=200`, { headers: { 'x-goog-api-key': c.apiKey }, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
        list = (j.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, ''))
          .filter((n) => /^gemini-/.test(n) && /flash/.test(n) && !/image|tts|audio|live|native|embed|computer|robotics/.test(n))
          .sort((a, b) => Number(/lite/.test(a)) - Number(/lite/.test(b)) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || ver(b) - ver(a));
        log(`[recognize] available flash models: ${list.slice(0, 8).join(', ') || '(none)'}`);
      } else log(`[recognize] list models HTTP ${r.status}`);
    } catch {
      log('[recognize] list models failed');
    }
    modelCache = { key: c.apiKey, at: Date.now(), list };
    return list;
  }

  /**
   * Gemini：繁忙（503/500）自动重试；仍不行就换模型——先用 GEMINI_FALLBACK_MODELS，
   * 再用这个密钥实际可用的 Flash 模型（自动发现），最多试 4 个。
   * 总时长受 RECOGNIZE_BUDGET_MS 限制，避免超过 Supabase 函数的时限。
   */
  async function callGemini(c, mediaType, imageBase64, fullPrompt = prompt) {
    const started = Date.now();
    const queue = [c.model, ...c.fallbacks.filter((m) => m !== c.model)];
    let discovered = false;
    let thinking = c.thinking;
    const errors = [];
    for (let i = 0; i < queue.length && i < 4; i++) {
      const model = queue[i];
      let modelErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = c.budget - (Date.now() - started);
        if (left < 8000) {
          modelErr = modelErr || new HttpError(504, '识别超时，请重试或裁小图片');
          i = queue.length; // 时间用完
          break;
        }
        const generationConfig = { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 16384 };
        if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking };
        const url = `${c.apiUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
        let r;
        try {
          r = await post(c, url, { 'x-goog-api-key': c.apiKey }, {
            contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mediaType, data: imageBase64 } }, { text: fullPrompt }] }],
            generationConfig,
          }, Math.min(c.timeout, left));
        } catch (e) {
          modelErr = e;
          if (e instanceof HttpError && e.status === 504) break; // 超时：换下一个模型
          continue;
        }
        if (r.ok) {
          const data = await r.json();
          if (data.promptFeedback?.blockReason) throw new HttpError(422, '图片被模型安全策略拦截，请换一张或手工录入');
          const cand = (data.candidates || [])[0];
          const text = (cand?.content?.parts || []).filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
          if (text) {
            if (model !== c.model) log(`[recognize] used fallback model ${model}`);
            return text;
          }
          if (cand?.finishReason === 'MAX_TOKENS') throw new HttpError(502, '识别结果太长被截断，请把单据裁成两部分分别识别');
          modelErr = new HttpError(502, '模型没有返回识别结果，请重试');
          continue;
        }
        const detail = await r.text().catch(() => '');
        // 这个模型不支持思考级别参数：去掉后立刻重试
        if (r.status === 400 && thinking && /thinking/i.test(detail)) {
          thinking = '';
          attempt--;
          continue;
        }
        modelErr = upstreamError(c, r.status, detail, model);
        modelErr.notFound = r.status === 404;
        if (r.status === 404) break; // 模型名不可用：换下一个
        if (r.status === 429 && /quota|exhaust/i.test(detail)) break; // 这个模型额度用完：换下一个
        if (!RETRYABLE.has(r.status)) throw modelErr;
        await sleep(1200 * (attempt + 1));
      }
      if (modelErr) errors.push(modelErr);
      // 配置的模型都用完了：自动发现这个密钥可用的模型
      if (i === queue.length - 1 && !discovered) {
        discovered = true;
        for (const m of await discoverModels(c)) if (!queue.includes(m)) queue.push(m);
      }
    }
    // 报主模型的真实原因（繁忙/额度）；备用模型「不存在」不应盖过它
    throw errors.find((e) => !e.notFound) || errors[0] || new HttpError(502, '模型服务出错');
  }

  async function recognize(request, c) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > c.maxBytes * 1.4 + 2048) throw new HttpError(413, '图片过大');
    const body = await request.text();
    if (body.length > c.maxBytes * 1.4 + 2048) throw new HttpError(413, '图片过大');
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new HttpError(400, '请求不是 JSON');
    }
    const { mediaType, imageBase64, hints } = payload || {};
    if (hints != null && typeof hints !== 'string') throw new HttpError(400, '参考资料格式错误');
    const fullPrompt = withHints(prompt, hints);
    if (!MEDIA_TYPES.has(mediaType)) throw new HttpError(415, '只接受 JPG、PNG、WebP 图片');
    if (typeof imageBase64 !== 'string' || !imageBase64 || !/^[A-Za-z0-9+/=]+$/.test(imageBase64)) throw new HttpError(400, '图片数据无效');
    if ((imageBase64.length * 3) / 4 > c.maxBytes) throw new HttpError(413, '图片过大');

    const text = c.provider === 'gemini' ? await callGemini(c, mediaType, imageBase64, fullPrompt) : await callAnthropic(c, mediaType, imageBase64, fullPrompt);
    let result = extractJson(text);
    if (Array.isArray(result) && result.length === 1 && result[0] && typeof result[0] === 'object') result = result[0];
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(502, '模型没有返回符合格式的 JSON，请重试');
    if (!Array.isArray(result.items)) {
      if (result.items != null) throw new HttpError(502, '模型没有返回符合格式的 JSON，请重试');
      result.items = [];
    }
    return { result, rawText: text.slice(0, 20000), model: c.model };
  }

  /** 处理 /api/* 请求；非 API 路径返回 null，由宿主决定 */
  return async function handle(request, env = {}) {
    const c = cfg(env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null;
    const cors = corsHeaders(request, c);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const given = request.headers.get('x-access-token') || request.headers.get('apikey') || '';
    const tokenOk = !c.tokens.length || c.tokens.some((t) => safeEqual(given, t));

    if (url.pathname === '/api/health') {
      const extra = health ? await health(request, env).catch(() => ({})) : {};
      return json(200, { ok: true, configured: Boolean(c.apiKey), provider: c.provider, model: c.apiKey ? c.model : null, auth: c.tokens.length > 0, tokenOk, ...extra }, cors);
    }
    if (url.pathname === '/api/recognize') {
      if (request.method !== 'POST') return json(405, { error: '只支持 POST' }, cors);
      if (!c.apiKey) return json(503, { error: '服务器未配置模型密钥（GEMINI_API_KEY 或 ANTHROPIC_API_KEY）' }, cors);
      const ip = request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';
      let grant = null;
      if (authorize) {
        grant = await authorize(request, env);
        if (!grant.ok) return json(grant.status || 401, { error: grant.error, code: grant.code }, cors);
      } else if (!tokenOk) {
        if (rateLimited(`bad:${ip}`, 5)) return json(429, { error: '口令错误次数过多，请稍后再试' }, cors);
        return json(401, { error: '访问口令不正确，请在「设置 → 识别服务」里填写' }, cors);
      }
      if (rateLimited(grant?.key || ip, c.rate)) {
        await grant?.done?.(false);
        return json(429, { error: '请求太频繁，请一分钟后再试' }, cors);
      }
      try {
        const t0 = Date.now();
        const out = await recognize(request, c);
        log(`[recognize] ok ${Date.now() - t0}ms items=${out.result.items.length}`);
        const usage = grant?.done ? await grant.done(true) : undefined;
        return json(200, usage ? { ...out, usage } : out, cors);
      } catch (e) {
        await grant?.done?.(false);
        return json(e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : '服务器内部错误' }, cors);
      }
    }
    return json(404, { error: 'not found' }, cors);
  };
}
