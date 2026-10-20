#!/usr/bin/env node
/**
 * 账期助手 · 一键部署（GitHub Actions 里运行，也可以在本机运行）
 *
 * 做的事（全部可重复执行）：
 *   1. 检查密钥与 Supabase 项目
 *   2. 运行建表脚本 supabase/setup.sql（账号同步、套餐、用量、推送）
 *   3. 登录设置：邮箱 + 密码注册即可登录（不发确认邮件，不需要 SMTP），网站地址
 *   4. 部署识别函数（AI 识别 / 账号 / 订阅 / 推送都在这一个函数里），关闭 Verify JWT
 *   5. 写入函数密钥（GEMINI_API_KEY、MP_ACCESS_TOKEN、OWNER_EMAILS…）
 *   6. 开启每天 09:00（圣保罗）的到期推送
 *   7. 生成网站配置 dist/zq-config.json（Project URL + publishable key + 函数名）
 *
 * 需要的环境变量：SUPABASE_ACCESS_TOKEN、SUPABASE_PROJECT_REF（或 Project URL）、GEMINI_API_KEY
 * 可选：MP_ACCESS_TOKEN、MP_WEBHOOK_SECRET、OWNER_EMAILS、SITE_URL、FUNCTION_NAME
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.supabase.com/v1';

export class DeployError extends Error {}

export function parseRef(v) {
  const s = String(v || '').trim();
  const m = s.match(/^https?:\/\/([a-z0-9]{10,40})\.supabase\.co/i);
  if (m) return m[1];
  if (/^[a-z0-9]{10,40}$/i.test(s)) return s;
  return null;
}

/** GitHub Pages 网址：<owner>.github.io/<repo>/（仓库名本身是 <owner>.github.io 时为根目录） */
export function pagesUrl(env) {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/?$/, '/');
  const repo = env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host ? `https://${host}/` : `https://${host}/${name}/`;
}

export async function main({ env = process.env, fetchImpl = fetch, run, root, log = console.log } = {}) {
  root = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  run = run ?? (async (cmd, args, extraEnv) => (await promisify(execFile)(cmd, args, { cwd: root, env: { ...process.env, ...extraEnv }, maxBuffer: 20 * 1024 * 1024 })).stdout);
  const step = (n, t) => log(`\n▶ ${n}. ${t}`);
  const ok = (t) => log(`  ✓ ${t}`);

  step(1, '检查密钥');
  const token = env.SUPABASE_ACCESS_TOKEN;
  const ref = parseRef(env.SUPABASE_PROJECT_REF);
  const missing = [];
  if (!token) missing.push('SUPABASE_ACCESS_TOKEN（supabase.com/dashboard/account/tokens 生成）');
  if (!ref) missing.push('SUPABASE_PROJECT_REF（Project URL 里 https:// 和 .supabase.co 之间那段，或直接填 Project URL）');
  if (!env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY（aistudio.google.com/apikey 生成）');
  if (missing.length) throw new DeployError(`缺少仓库密钥（Settings → Secrets and variables → Actions → New repository secret）：\n  - ${missing.join('\n  - ')}`);
  const fn = env.FUNCTION_NAME || 'recognize';
  const projectUrl = `https://${ref}.supabase.co`;
  const fnUrl = `${projectUrl}/functions/v1/${fn}`;
  const site = pagesUrl(env);

  const api = async (method, p, body) => {
    const r = await fetchImpl(`${API}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) {
      if (r.status === 401) throw new DeployError('SUPABASE_ACCESS_TOKEN 无效或已过期：请到 supabase.com/dashboard/account/tokens 重新生成');
      if (r.status === 404 && p === `/projects/${ref}`) throw new DeployError(`找不到项目 ${ref}：请检查 SUPABASE_PROJECT_REF`);
      throw new DeployError(`Supabase 接口 ${method} ${p} 失败（${r.status}）：${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  };
  const sql = (query) => api('POST', `/projects/${ref}/database/query`, { query });

  const project = await api('GET', `/projects/${ref}`);
  if (project?.status && !/ACTIVE/i.test(project.status)) throw new DeployError(`项目 ${ref} 当前状态是 ${project.status}（可能已暂停）：请先在 Supabase 控制台恢复项目`);
  ok(`项目 ${project?.name ?? ref}（${projectUrl}）`);

  step(2, '建表（可重复运行，不会删除数据）');
  await sql(await readFile(path.join(root, 'supabase/setup.sql'), 'utf8'));
  ok('数据库已就绪');

  step(3, '登录设置');
  const auth = { mailer_autoconfirm: true, external_email_enabled: true, password_min_length: 8 };
  if (site) Object.assign(auth, { site_url: site, uri_allow_list: site });
  await api('PATCH', `/projects/${ref}/config/auth`, auth);
  ok(`邮箱 + 密码注册即登录（不发确认邮件）${site ? `；网站地址 ${site}` : ''}`);

  step(4, `部署识别函数「${fn}」`);
  const base = ['functions', 'deploy', fn, '--project-ref', ref, '--no-verify-jwt'];
  try {
    await run('supabase', [...base, '--use-api'], { SUPABASE_ACCESS_TOKEN: token });
  } catch {
    await run('supabase', base, { SUPABASE_ACCESS_TOKEN: token });
  }
  ok(fnUrl);

  step(5, '写入函数密钥');
  const secrets = Object.entries({
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    MP_ACCESS_TOKEN: env.MP_ACCESS_TOKEN,
    MP_WEBHOOK_SECRET: env.MP_WEBHOOK_SECRET,
    OWNER_EMAILS: env.OWNER_EMAILS,
  })
    .filter(([, v]) => v)
    .map(([name, value]) => ({ name, value }));
  await api('POST', `/projects/${ref}/secrets`, secrets);
  ok(secrets.map((s) => s.name).join('、'));
  if (!env.MP_ACCESS_TOKEN) log('  ! 没有 MP_ACCESS_TOKEN：订阅收款未开放，用户试用结束后只能查看（之后补上密钥再运行一次即可）');

  step(6, '每天 09:00（圣保罗）到期推送');
  await sql(`insert into public.zq_kv(key, value) values ('fn_url', '${fnUrl.replace(/'/g, "''")}') on conflict (key) do update set value = excluded.value, updated_at = now();`);
  try {
    await sql(await readFile(path.join(root, 'supabase/push-cron.sql'), 'utf8'));
    ok('定时任务已设置（12:00 UTC）');
  } catch (e) {
    log(`  ! 定时推送没设置成功（不影响其他功能）：${e.message}`);
  }

  step(7, '生成网站配置 zq-config.json');
  const keys = (await api('GET', `/projects/${ref}/api-keys?reveal=false`)) ?? [];
  const pub = keys.find((k) => k.type === 'publishable') ?? keys.find((k) => k.name === 'anon' || k.type === 'legacy');
  if (!pub?.api_key) throw new DeployError('没找到 publishable key：请在 Supabase → Project Settings → API Keys 创建一个 publishable key 后重试');
  const cfg = { supabaseUrl: projectUrl, publishableKey: pub.api_key, functionName: fn };
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist/zq-config.json'), JSON.stringify(cfg, null, 2) + '\n');
  ok('dist/zq-config.json');

  log('\n✅ 部署完成');
  if (site) log(`   网站：${site}`);
  log(`   Mercado Pago 通知网址（可选，在 Mercado Pago 开发者后台 → Webhooks 填写，事件选「Planos e assinaturas」）：\n   ${fnUrl}/billing/webhook`);
  return { ref, fnUrl, site, config: cfg };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n❌ ${e instanceof DeployError ? e.message : e?.stack ?? e}`);
    process.exit(1);
  });
}
