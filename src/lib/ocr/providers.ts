/**
 * 识别通道：
 *  - supabase：同步用的 Supabase 项目里的 Edge Function「recognize」（Gemini 或 Claude，密钥只在 Supabase Secrets）。
 *              用同步配置里的 Project URL + publishable key 调用，打开同步即自动可用
 *  - claude：在 Claude 中打开时，通过页面的 Claude 能力调用视觉模型（使用查看者自己的 Claude 账号，前端无密钥）
 *  - server：自建后端 /api/recognize（密钥只在服务器环境变量）
 *  - local：本机 tesseract.js OCR（离线降级，手写能力有限）
 */
import { RECOGNIZE_PROMPT } from './prompt';
import { withHints, HINTS_MAX } from '../../../shared/hints.mjs';
export { withHints, HINTS_MAX };
import { normalizeModelOutput, type ModelOutput } from './protocol';
import { wordsToModelOutput, type Word } from './rows';

export type ProviderId = 'supabase' | 'claude' | 'server' | 'local';

/** 同步配置里的 Supabase 项目（只用 url 与 publishable key） */
export interface SupaTarget {
  url: string;
  key: string;
  /** 函数名（slug）或完整函数网址；空 = recognize */
  fn?: string | null;
  /** 登录用户的令牌（账号版按套餐计 AI 额度） */
  bearer?: string | null;
}

export const SUPA_FN = 'recognize';
/** 把用户填的函数名 / 网址规范成 slug（同一项目的网址只保留函数名）或完整网址 */
export function normalizeFn(v: string | null | undefined, projectUrl?: string): string {
  const s = (v ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    const u = s.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\/health$/, '');
    const m = u.match(/^(https?:\/\/[^/]+)\/functions\/v1\/([\w-]+)$/i);
    const host = (projectUrl ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').toLowerCase();
    if (m && host && m[1].toLowerCase() === host) return m[2];
    return u;
  }
  const m = s.match(/functions\/v1\/([\w-]+)/);
  return (m ? m[1] : s.replace(/^\/+|\/+$/g, '')).trim();
}
export const supaFnUrl = (t: SupaTarget) => {
  const fn = normalizeFn(t.fn);
  if (/^https?:\/\//i.test(fn)) return fn;
  return `${t.url.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '')}/functions/v1/${fn || SUPA_FN}`;
};

export interface RecognizeResult {
  output: ModelOutput;
  rawText: string | null;
  provider: ProviderId;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  available: boolean;
  reason?: string;
  sendsImage: boolean;
  cost: string;
  /** 需要先登录账号 */
  needsLogin?: boolean;
}

export class RecognizeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

let samplePromise: Promise<any> | null = null;
function getSample(): Promise<any> {
  if (!samplePromise) {
    samplePromise = (async () => {
      try {
        if (typeof window === 'undefined' || !window.claude?.use) return null;
        return await window.claude.use('sample');
      } catch {
        return null;
      }
    })();
  }
  return samplePromise;
}

let downloadsPromise: Promise<any> | null = null;
export function getDownloads(): Promise<any> {
  if (!downloadsPromise) {
    downloadsPromise = (async () => {
      try {
        if (typeof window === 'undefined' || !window.claude?.use) return null;
        return await window.claude.use('downloads');
      } catch {
        return null;
      }
    })();
  }
  return downloadsPromise;
}

async function claudeInfo(): Promise<ProviderInfo> {
  const base = { id: 'claude' as const, label: 'Claude 视觉识别', sendsImage: true, cost: '消耗你自己 Claude 账号的用量，无需 API 密钥' };
  const s = await getSample();
  if (!s) return { ...base, available: false, reason: '仅在 Claude 中打开本应用时可用' };
  try {
    const lim = await s.limits();
    if (!lim?.images) return { ...base, available: false, reason: '当前 Claude 客户端不支持发送图片' };
  } catch {
    return { ...base, available: false, reason: '当前 Claude 客户端不支持发送图片' };
  }
  return { ...base, available: true };
}

async function serverInfo(endpoint: string, token = ''): Promise<ProviderInfo> {
  const base = { id: 'server' as const, label: '云端识别服务', sendsImage: true, cost: '由你部署的服务调用视觉模型，按服务器上的 API 用量计费' };
  if (endpoint.startsWith('/') && ((typeof __SINGLE__ !== 'undefined' && __SINGLE__) || /github\.io$/.test(location.hostname))) return { ...base, available: false, reason: '未配置服务地址（在「设置」里填写完整的 https 地址）' };
  try {
    const url = endpoint.replace(/\/recognize\/?$/, '/health');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(url, { signal: ctl.signal, headers: token ? { 'x-access-token': token } : {} });
    clearTimeout(t);
    if (r.status === 404 || r.status === 405) return { ...base, available: false, reason: '此网站没有识别服务（例如部署在 GitHub Pages），请到「设置」填写你的识别服务地址' };
    if (!r.ok) return { ...base, available: false, reason: `服务不可用（HTTP ${r.status}）` };
    if (!(r.headers.get('content-type') ?? '').includes('json')) return { ...base, available: false, reason: '此网站没有识别服务，请到「设置」填写你的识别服务地址' };
    const j = await r.json().catch(() => ({}));
    if (!j.configured) return { ...base, available: false, reason: '服务已启动，但服务器未配置 ANTHROPIC_API_KEY' };
    if (j.auth && !j.tokenOk) return { ...base, available: false, reason: token ? '访问口令不正确（设置 → 识别服务）' : '此服务需要访问口令，请到「设置 → 识别服务」填写' };
    return { ...base, available: true };
  } catch {
    return { ...base, available: false, reason: '连接不到识别服务（未启动或网络受限）' };
  }
}

async function supabaseInfo(t: SupaTarget | null | undefined): Promise<ProviderInfo> {
  const base = { id: 'supabase' as const, label: 'AI 识别', sendsImage: true, cost: '按你的模型密钥计费（Gemini 有每日免费额度）；密钥只存在你的 Supabase，不在本机' };
  if (!t?.url || !t?.key) return { ...base, available: false, reason: '先在「设置 → 云同步」连接 Supabase，再按「开启 AI 识别」部署识别函数' };
  try {
    // 函数冷启动时第一次可能失败：网络错误或 5xx 时再试一次
    const once = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      try {
        return await fetch(`${supaFnUrl(t)}/health`, { signal: ctl.signal, headers: { apikey: t.key.trim(), ...(t.bearer ? { authorization: `Bearer ${t.bearer}` } : {}) } });
      } finally {
        clearTimeout(timer);
      }
    };
    let r: Response;
    try {
      r = await once();
      if (r.status >= 500) throw new Error('cold');
    } catch {
      await new Promise((ok) => setTimeout(ok, 1500));
      r = await once();
    }
    if (r.status === 404) return { ...base, available: false, reason: `找不到识别函数「${normalizeFn(t.fn) || SUPA_FN}」：还没部署，或函数网址最后一段不是这个名字（可在「识别函数名」里改）` };
    if (r.status === 401) return { ...base, available: false, reason: '识别函数开启了 JWT 校验：请在函数设置里关闭「Verify JWT」' };
    if (!r.ok) return { ...base, available: false, reason: `识别函数不可用（HTTP ${r.status}）` };
    const j = await r.json().catch(() => ({}));
    const who = j.provider === 'anthropic' ? 'Claude' : j.provider === 'gemini' ? 'Gemini' : '';
    const label = who ? `AI 识别 · ${who}` : base.label;
    if (!j.configured) return { ...base, label, available: false, reason: '识别函数已部署，但还没添加 GEMINI_API_KEY（Edge Functions → Secrets）' };
    if (j.login === 'required' && !j.signedIn) return { ...base, label, available: false, reason: 'AI 识别需要登录账号（设置 → 账号，邮箱验证码登录）', needsLogin: true };
    if (j.auth && !j.tokenOk && j.login !== 'required') return { ...base, label, available: false, reason: '同步配置里的 publishable key 和识别函数不在同一个项目' };
    return { ...base, label, available: true };
  } catch {
    const slug = normalizeFn(t.fn) || SUPA_FN;
    return { ...base, available: false, reason: `连接不到识别函数（${/^https?:/.test(slug) ? slug : `/functions/v1/${slug}`}）。请检查：① 函数网址最后一段和「识别函数名」一致；② 函数 Settings 里已关闭 Verify JWT；③ 函数已部署` };
  }
}

function localInfo(): ProviderInfo {
  const online = typeof navigator === 'undefined' || navigator.onLine;
  return {
    id: 'local',
    label: '本机 OCR（离线）',
    sendsImage: false,
    cost: '免费，图片不离开设备；手写识别较弱，首次需下载语言包',
    available: true,
    reason: online ? undefined : '当前离线：若语言包未缓存将无法加载',
  };
}

export async function listProviders(endpoint: string, token = '', supa: SupaTarget | null = null): Promise<ProviderInfo[]> {
  return Promise.all([supabaseInfo(supa), claudeInfo(), serverInfo(endpoint, token), Promise.resolve(localInfo())]);
}

/**
 * 识别页只显示有用的通道：AI 识别（Supabase）总是显示（不可用时带开启提示）；
 * Claude / 自建服务不可用时隐藏；本机 OCR 作为离线备用。
 */
export function usefulProviders(ps: ProviderInfo[]): ProviderInfo[] {
  return ps.filter((p) => p.id === 'supabase' || p.id === 'local' || p.available);
}

const ORDER: ProviderId[] = ['supabase', 'claude', 'server', 'local'];
/**
 * 默认选中：上次用的是内置 AI（Supabase / Claude）且仍可用就沿用；
 * 否则按 AI 识别 → Claude → 自建服务 → 本机 OCR（开通 AI 识别后不会卡在本机 OCR）
 */
export function pickProvider(ps: ProviderInfo[], last: string | null | undefined): ProviderId | null {
  const ok = ps.filter((p) => p.available);
  if ((last === 'supabase' || last === 'claude') && ok.some((p) => p.id === last)) return last;
  return ORDER.find((id) => ok.some((p) => p.id === id)) ?? null;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const SAMPLE_ERR: Record<string, string> = {
  not_granted: '你没有允许本应用使用 Claude，可改用本机 OCR 或手工录入',
  sampling_disabled: '当前账号不可使用 Claude 识别',
  images_unavailable: '当前客户端不能发送图片',
  image_rejected: '图片无法被接受（类型或尺寸不符），请换一张或重新裁切',
  rate_limited: '请求太频繁或已达用量上限，请稍后再试',
  session_expired: '登录已过期，请重新登录 Claude',
  invalid_json: '识别结果不是有效 JSON，可重试一次',
  refused: '识别请求被拒绝，请确认图片内容为订单',
  empty_completion: '没有得到识别结果，请换一张更清晰的图片',
  cancelled: '已取消',
};

export async function recognize(provider: ProviderId, image: Blob, opts: { endpoint: string; token?: string; supa?: SupaTarget | null; hints?: string; accessToken?: string | null; signal: AbortSignal; onProgress?: (p: string) => void; chinese?: boolean }): Promise<RecognizeResult> {
  if (provider === 'claude') {
    const s = await getSample();
    if (!s) throw new RecognizeError('unavailable', 'Claude 识别不可用');
    opts.onProgress?.('等待 Claude 读取图片…');
    try {
      let chars = 0;
      const data = await s.json(withHints(RECOGNIZE_PROMPT, opts.hints), {
        images: image,
        signal: opts.signal,
        modelTier: 'complex',
        cache: false,
        onText: ({ text }: { text: string }) => {
          chars = text.length;
          opts.onProgress?.(`正在生成结构化结果（${chars} 字符）…`);
        },
      });
      return { output: normalizeModelOutput(data), rawText: JSON.stringify(data), provider };
    } catch (e: any) {
      if (e?.code) throw new RecognizeError(e.code, SAMPLE_ERR[e.code] ?? `识别失败（${e.code}）`);
      throw new RecognizeError('protocol', e?.message ?? '识别结果无法解析');
    }
  }
  if (provider === 'server' || provider === 'supabase') {
    let url = opts.endpoint;
    let headers: Record<string, string> = opts.token ? { 'x-access-token': opts.token } : {};
    if (provider === 'supabase') {
      if (!opts.supa?.url || !opts.supa.key) throw new RecognizeError('unavailable', '还没连接 Supabase（设置 → 云同步）');
      url = supaFnUrl(opts.supa);
      const bearer = opts.accessToken ?? opts.supa.bearer;
      headers = { apikey: opts.supa.key.trim(), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
    }
    opts.onProgress?.('上传图片，AI 正在读单据…');
    const body = JSON.stringify({ mediaType: image.type || 'image/jpeg', imageBase64: await blobToBase64(image), ...(opts.hints ? { hints: opts.hints.slice(0, HINTS_MAX) } : {}) });
    let r: Response;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: opts.signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new RecognizeError('cancelled', '已取消');
      throw new RecognizeError('network', '网络错误，连接不到识别服务');
    }
    let text: string;
    try {
      text = await r.text();
    } catch (e: any) {
      if (e?.name === 'AbortError' || opts.signal.aborted) throw new RecognizeError('cancelled', '已取消');
      throw new RecognizeError('network', '网络中断，没有收到识别结果');
    }
    if (!r.ok) {
      let msg = `识别服务出错（HTTP ${r.status}）`;
      try {
        msg = JSON.parse(text).error ?? msg;
      } catch {}
      if (r.status === 546) msg = '识别函数资源不足（图片可能太大），请裁小一点再试';
      if (r.status === 402) throw new RecognizeError('quota', msg);
      if (r.status === 401 && /登录/.test(msg)) throw new RecognizeError('login', msg);
      if (r.status === 401 && provider === 'supabase' && /JWT|authorization/i.test(text)) msg = '识别函数开启了 JWT 校验：请在 Supabase 函数设置里关闭「Verify JWT」';
      throw new RecognizeError(r.status === 504 ? 'timeout' : r.status === 429 ? 'rate_limited' : 'server', msg);
    }
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new RecognizeError('protocol', '识别服务返回的不是 JSON');
    }
    return { output: normalizeModelOutput(payload.result ?? payload), rawText: payload.rawText ?? null, provider };
  }
  // local
  opts.onProgress?.('加载本机 OCR 引擎…');
  let T: any;
  try {
    T = await import('tesseract.js');
  } catch {
    throw new RecognizeError('unavailable', '本机 OCR 引擎加载失败');
  }
  const langs = opts.chinese ? 'por+eng+chi_sim' : 'por+eng';
  let worker: any;
  const abort = () => worker?.terminate();
  opts.signal.addEventListener('abort', abort);
  try {
    worker = await (T.createWorker ?? T.default.createWorker)(langs, 1, {
      logger: (m: any) => {
        if (m?.status) opts.onProgress?.(`${translateStatus(m.status)} ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`);
      },
    });
    if (opts.signal.aborted) throw new RecognizeError('cancelled', '已取消');
    const bmp = await createImageBitmap(image);
    const { data } = await worker.recognize(image);
    const words: Word[] = (data.words ?? []).map((w: any) => ({ text: w.text, confidence: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
    const out = wordsToModelOutput(words, bmp.width, bmp.height);
    bmp.close();
    return { output: normalizeModelOutput(out), rawText: data.text ?? null, provider };
  } catch (e: any) {
    if (opts.signal.aborted) throw new RecognizeError('cancelled', '已取消');
    if (e instanceof RecognizeError) throw e;
    throw new RecognizeError('local', `本机 OCR 失败：${e?.message ?? e}。在 Claude 页面内运行时浏览器会阻止下载 OCR 语言包，请改用 Claude 识别或手工录入`);
  } finally {
    opts.signal.removeEventListener('abort', abort);
    worker?.terminate?.();
  }
}

function translateStatus(s: string): string {
  if (/loading tesseract core/.test(s)) return '加载 OCR 内核';
  if (/language/.test(s)) return '加载语言包';
  if (/initializ/.test(s)) return '初始化';
  if (/recognizing/.test(s)) return '识别中';
  return s;
}
