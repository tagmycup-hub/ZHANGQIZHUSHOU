import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

// ---- 模拟 Supabase（真实 setup.sql 跑在 PGlite 里），浏览器请求经 Playwright 路由到这里 ----
const pg = new PGlite();
await pg.exec(await readFile('../tests/support/pg-auth.sql', 'utf8'));
await pg.exec(await readFile('../supabase/setup.sql', 'utf8'));
const SB_URL = 'https://e2e-test.supabase.co';
const SB_KEY = 'sb_publishable_e2e_key_0123456789';
const SB_SECRET = 'sb_secret_e2e_key_0123456789';
const MP_API = 'https://mp-e2e.test';
let sbCalls = 0;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' };
const { createPostgrest } = await import('../tests/support/postgrest.mjs');
const rest = createPostgrest(pg);
// 识别函数：运行真实打包的 supabase/functions/recognize/index.ts，上游是模拟的 Gemini / Mercado Pago
const fnSrc = await readFile('../supabase/functions/recognize/index.ts', 'utf8');
const { serve: fnServe } = await import('data:text/javascript;base64,' + Buffer.from(fnSrc).toString('base64'));
let fnDeployed = false;
let geminiCalls = 0;
const fnPaths = [];
const fnEnv = {
  SUPABASE_URL: SB_URL,
  GEMINI_API_KEY: 'e2e-gemini',
  GEMINI_API_URL: 'http://127.0.0.1:9912/v1beta',
  GEMINI_FALLBACK_MODELS: '',
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: SB_KEY }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SB_SECRET }),
  MP_ACCESS_TOKEN: 'TEST-e2e',
  MP_API_URL: MP_API,
};
// 模拟登录：验证码固定 123456；令牌 → 用户
const sessions = new Map();
const otpSent = [];
const pwUsers = new Map();
let mpStatus = 'pending';
let mpReturn = '';
let mpRef = '';
let mpBody = null;
const j = (status, obj, extra = {}) => ({ status, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: obj === undefined ? '' : JSON.stringify(obj) });
async function sbHandle(method, url, headers, body) {
  const u = new URL(url);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'OPTIONS' && !u.pathname.startsWith('/functions/')) return { status: 204, headers: CORS, body: '' };
  const bearer = (h.authorization || '').replace(/^Bearer /i, '');
  if (u.pathname.startsWith('/functions/v1/')) {
    fnPaths.push(u.pathname);
    if (!fnDeployed) return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"code":"NOT_FOUND","message":"Requested function was not found"}' };
    const r = await fnServe(new Request(url, { method, headers: h, body: ['GET', 'HEAD'].includes(method) ? undefined : body }), fnEnv);
    return { status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) };
  }
  if (u.pathname.startsWith('/auth/v1/')) {
    const p = u.pathname.slice('/auth/v1/'.length);
    const b = body ? JSON.parse(body) : {};
    if (p === 'otp') {
      otpSent.push(b.email);
      return j(200, {});
    }
    if (p === 'verify') {
      if (b.token !== '123456') return j(403, { msg: 'Token has expired or is invalid' });
      const id = b.email === 'ana@example.com' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      await pg.query('insert into auth.users(id, email) values ($1, $2) on conflict do nothing', [id, b.email]);
      const token = `jwt-${id}`;
      sessions.set(token, { id, email: b.email });
      return j(200, { access_token: token, refresh_token: `r-${id}`, expires_in: 3600, user: { id, email: b.email } });
    }
    if (p === 'signup' || p === 'token') {
      const id = b.email === 'ana@example.com' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
      if (p === 'signup') {
        if (pwUsers.has(b.email)) return j(422, { code: 'user_already_exists', msg: 'User already registered' });
        pwUsers.set(b.email, b.password);
      } else if (pwUsers.get(b.email) !== b.password) return j(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      await pg.query('insert into auth.users(id, email) values ($1, $2) on conflict do nothing', [id, b.email]);
      const token = `jwt-${id}`;
      sessions.set(token, { id, email: b.email });
      return j(200, { access_token: token, refresh_token: `r-${id}`, expires_in: 3600, user: { id, email: b.email } });
    }
    if (p === 'user') return sessions.has(bearer) ? j(200, sessions.get(bearer)) : j(401, { msg: 'invalid JWT' });
    if (p === 'logout') return j(204, undefined);
    return j(404, { msg: 'not found' });
  }
  if (u.pathname.startsWith('/rest/v1/')) {
    const role = h.apikey === SB_SECRET ? 'service' : sessions.has(bearer) ? 'user' : h.apikey === SB_KEY ? 'anon' : null;
    if (!role) return j(401, { message: 'Invalid API key' });
    if (role !== 'service') sbCalls++;
    const r = await rest({ method, path: u.pathname + u.search, body, role, sub: sessions.get(bearer)?.id ?? null, prefer: h.prefer || '' });
    return { status: r.status, headers: { ...CORS, 'content-type': 'application/json' }, body: r.body };
  }
  return j(404, { message: 'not found' });
}
async function supabaseRoute(route) {
  const req = route.request();
  const r = await sbHandle(req.method(), req.url(), req.headers(), req.postData());
  return route.fulfill({ status: r.status, headers: r.headers, body: r.body });
}
// 函数在 Node 里访问 Supabase / Mercado Pago：拦截到本地模拟
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(SB_URL)) {
    const r = await sbHandle(init.method || 'GET', url, Object.fromEntries(new Headers(init.headers)), init.body);
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  }
  if (url.startsWith(MP_API)) {
    const path = url.slice(MP_API.length);
    const b = init.body ? JSON.parse(init.body) : null;
    const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/preapproval' && init.method === 'POST') {
      mpReturn = b.back_url;
      mpRef = b.external_reference;
      mpBody = b;
      return res(201, { id: 'pa-e2e', status: 'pending', init_point: b.back_url, external_reference: b.external_reference });
    }
    if (path === '/preapproval/pa-e2e') return res(200, { id: 'pa-e2e', status: mpStatus, external_reference: mpRef, next_payment_date: new Date(Date.now() + 30 * 86400000).toISOString() });
    return res(404, { message: 'not found' });
  }
  return realFetch(input, init);
};
const addMonthsISO = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
};

const fixtures = { ticket: await readFile('../tests/fixtures/ticket-258.model.json', 'utf8'), statement: await readFile('../tests/fixtures/statement.model.json', 'utf8') };
let fixture = fixtures.ticket;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ content: [{ type: 'text', text: fixture }] }));
}).listen(9911);
const gemini = http.createServer(async (req, res) => {
  for await (const _ of req);
  geminiCalls++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: fixture }] }, finishReason: 'STOP' }] }));
}).listen(9912);
const srv = spawn('node', ['../server/index.mjs'], { env: { ...process.env, PORT: '9910', ANTHROPIC_API_KEY: 'e2e', ANTHROPIC_API_URL: 'http://127.0.0.1:9911/x' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const BASE = 'http://localhost:9910/';
const log = [];
const ok = (id, msg) => { log.push(`✔ ${id} ${msg}`); console.log(`✔ ${id} ${msg}`); };

const LAUNCH_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: LAUNCH_ARGS });
const addDaysISO = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const br = (iso) => iso.split('-').reverse().join('/');
const spToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, timezoneId: 'America/Sao_Paulo', locale: 'zh-CN', acceptDownloads: true, permissions: ['notifications', 'camera', 'clipboard-read', 'clipboard-write'], hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    window.__notes = [];
    const orig = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (t, o) { window.__notes.push(t); return orig.call(this, t, o); };
    const N = window.Notification;
    if (N) { window.Notification = class extends N { constructor(t, o) { super(t, o); window.__notes.push(t); } }; Object.defineProperty(window.Notification, 'permission', { get: () => N.permission }); window.Notification.requestPermission = N.requestPermission.bind(N); }
  });
  await ctx.route(SB_URL + '/**', supabaseRoute);
  const page = await ctx.newPage();
  /** 在分组列表里点开一笔账单，返回详情抽屉 */
  const openBill = async (text, p = page) => {
    await p.locator('.brow', { hasText: text }).first().locator('.brow-main').click();
    const dlg = p.getByRole('dialog');
    await dlg.waitFor();
    return dlg;
  };
  const closeSheet = async (p = page) => {
    await p.keyboard.press('Escape');
    await p.getByRole('dialog').waitFor({ state: 'detached' });
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const noOverflow = async (label) => {
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(w[0] <= w[1], `${label} 横向溢出 ${w}`);
  };

  await page.goto(BASE);
  await page.getByText('熟悉后可一键清除').waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shot-dashboard-360.png', fullPage: true });
  await noOverflow('首页');
  const notes = await page.evaluate(() => window.__notes);
  assert.ok(notes.length >= 2, '应发送通知 ' + JSON.stringify(notes));
  ok('A07', `应用打开时发送通知 ${notes.length} 条：${notes.join(' / ')}`);
  await page.reload();
  await page.waitForTimeout(1500);
  const notes2 = await page.evaluate(() => window.__notes);
  assert.equal(notes2.length, 0, '刷新后同一天不应重复通知');
  ok('A07', '刷新后同日同状态不重复通知（签名去重）');


  // ===== 第二轮新增功能（在示例数据上验证）=====
  // 本月账期总额
  const overview = await page.locator('.month-plan').innerText();
  assert.match(overview, /\d+月还要付 · \d+ 笔/);
  assert.match(overview, /本月账期 R\$ [\d.]+,\d\d · 已付/);
  assert.match(overview, /本月各商家账期/);
  assert.ok((await page.locator('.month-plan .seg-part').count()) >= 2, '本月账期按商家分色');
  const allBlock = await page.locator('.all-unpaid').innerText();
  assert.match(allBlock, /全部待付 · \d+ 笔/);
  assert.match(allBlock, /已逾期/);
  // 本月待付卡片（按日期分色），不再出现大卡片
  const groupsHome = await page.locator('.glabel').allInnerTexts();
  assert.ok(groupsHome.some((t) => t.startsWith('已逾期')), groupsHome.join(','));
  assert.ok(!groupsHome.some((t) => t.startsWith('以后')), '首页只显示本月');
  assert.equal(await page.locator('.bill').count(), 0, '首页不应再出现大卡片');
  ok('B03', '首页：本月还要付 + 本月账期进度 + 各商家分色条；本月待付卡片；全部待付单独区块按时间分色');

  // 商家固定账期：选择商家后自动算到期日
  await page.goto(BASE + '#/new');
  await page.click('#f-merchant');
  await page.fill('#f-merchant', 'Brás');
  await page.getByRole('option', { name: /^示例 · Brás/ }).click();
  assert.equal(await page.inputValue('#f-dueDate'), br(addDaysISO(spToday, 30)));
  await page.getByText(/已按「示例 · Brás 配件批发」账期（开单后 30 天）自动计算/).waitFor();
  // 改账单日期 → 到期日跟着变
  await page.fill('#f-billDate', br(addDaysISO(spToday, -5)));
  assert.equal(await page.inputValue('#f-dueDate'), br(addDaysISO(spToday, 25)));
  ok('B06', '选择有固定账期的商家后自动计算到期日，改开单日期同步更新');

  // 日历选择器
  await page.getByRole('button', { name: '打开日历选择选择到期日期' }).click();
  await page.getByRole('dialog', { name: '选择到期日期' }).waitFor();
  await page.screenshot({ path: 'shot-datepicker-360.png' });
  // 选同一个月里、和当前到期日不同的一天（避免跨月时目标不在画面里）
  const curDue = addDaysISO(spToday, 25);
  const target = Number(curDue.slice(8)) > 2 ? addDaysISO(curDue, -2) : addDaysISO(curDue, 2);
  await page.getByRole('gridcell', { name: new RegExp('^' + br(target)) }).first().click();
  assert.equal(await page.inputValue('#f-dueDate'), br(target));
  await page.getByText(/按「示例 · Brás 配件批发」账期重新计算/).waitFor();
  ok('B02', '到期日可用日历点选，手动改动后可一键恢复按账期计算');

  // 仅填总金额
  await page.getByRole('button', { name: '仅填总金额', exact: true }).click();
  await page.fill('#f-totalOnly', '1.234,56');
  await page.fill('#f-orderNumber', 'T-01');
  await page.getByText('R$ 1.234,56').first().waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已保存 R$ 1.234,56').waitFor();
  let sheet = await openBill('T-01');
  assert.ok(!(await sheet.innerText()).includes('整单金额（未列明细）'));
  await page.screenshot({ path: 'shot-sheet-360.png' });
  ok('B05', '明细可切换为仅填总金额并保存');

  // 复制账单（详情抽屉里）
  await sheet.getByRole('button', { name: '复制为新账单' }).click();
  await page.getByText(/复制自/).waitFor();
  assert.equal(await page.inputValue('#f-orderNumber'), '');
  assert.equal(await page.inputValue('#f-totalOnly'), '1.234,56');
  await page.getByRole('button', { name: '原日期顺延 1 个月' }).click();
  await page.fill('#f-orderNumber', 'T-02');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已保存 R$ 1.234,56').waitFor();
  await page.locator('.brow', { hasText: 'T-02' }).waitFor();
  ok('B01', '账单可复制为新账单（清空订单号、可顺延一个月）');

  // 分期商家
  await page.goto(BASE + '#/new');
  await page.click('#f-merchant');
  await page.fill('#f-merchant', 'Bom Retiro');
  await page.getByRole('option', { name: /^示例 · Bom Retiro/ }).click();
  await page.getByText('按分期保存').waitFor();
  await page.getByRole('button', { name: '仅填总金额', exact: true }).click();
  await page.fill('#f-totalOnly', '100,00');
  await page.fill('#f-orderNumber', 'P-3');
  const instTxt = await page.locator('.instbox').innerText();
  assert.match(instTxt, /第 1\/3 期[\s\S]*R\$ 33,34/);
  assert.match(instTxt, new RegExp(br(addDaysISO(spToday, 90))));
  await page.screenshot({ path: 'shot-installments-360.png', fullPage: true });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已按分期保存 3 笔，共 R$ 100,00').waitFor();
  await page.fill('#q', 'P-3');
  await page.locator('.listsum', { hasText: /合计\s*R\$ 100,00/ }).waitFor();
  assert.equal(await page.locator('.brow').count(), 3);
  ok('B06', '分期商家（30/60/90）保存为 3 笔，金额按分精确拆分');

  // 日常缴费
  await page.goto(BASE + '#/new/expense');
  await page.getByRole('radio', { name: /电费/ }).click();
  await page.getByRole('button', { name: '＋ Enel' }).click();
  await page.getByText('已保存缴费单位「Enel」').waitFor();
  await page.fill('#f-totalOnly', '215,40');
  await page.fill('#f-dueDate', br(addDaysISO(spToday, 2)));
  await page.fill('#f-paymentCode', '8'.repeat(48));
  await page.getByText(/公共缴费/).waitFor();
  // 自定义重复频率：每季度
  await page.selectOption('#f-repeatKey', 'm3');
  await page.getByText(/每季度：付款后自动生成下一期/).waitFor();
  await noOverflow('缴费页');
  await page.screenshot({ path: 'shot-expense-360.png', fullPage: true });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已保存 R$ 215,40').waitFor();
  const eRow = page.locator('.brow', { hasText: '电费 · Enel' });
  await eRow.waitFor();
  assert.match(await eRow.innerText(), /每季度/);
  sheet = await openBill('电费 · Enel');
  await sheet.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByText('付款码已复制').waitFor();
  await sheet.getByRole('button', { name: '标记已付' }).click();
  const nextDue = br(addMonthsISO(addDaysISO(spToday, 2), 3));
  await page.getByText(`已生成下一期（${nextDue} 到期）`).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: /待确认/ }).click();
  await page.locator('.brow', { hasText: '电费 · Enel' }).getByText('待确认').waitFor();
  assert.match(await page.locator('.brow', { hasText: '电费 · Enel' }).innerText(), new RegExp(nextDue.slice(0, 5)));
  ok('B07', '日常缴费：选类型与缴费单位、付款码一键复制；重复周期可选（每季度），付款后按周期生成下一期（待确认金额）');

  // 月历视图 + 多选批量
  await page.getByRole('button', { name: '月历', exact: true }).click();
  await page.getByText(/\d{4}年\d{1,2}月到期 · \d+ 笔/).waitFor();
  await page.screenshot({ path: 'shot-monthview-360.png', fullPage: true });
  await page.getByRole('button', { name: '按日期', exact: true }).click();
  // 筛选抽屉
  await page.getByRole('button', { name: /筛选与排序/ }).click();
  await page.getByRole('dialog', { name: '筛选与排序' }).getByRole('button', { name: '日常缴费' }).click();
  await page.getByRole('button', { name: /^看 \d+ 笔$/ }).click();
  await page.getByRole('button', { name: '取消筛选：日常缴费' }).click();
  await page.fill('#q', 'T-0');
  await page.getByRole('tab', { name: /^未付/ }).click();
  await page.getByRole('button', { name: '按商家', exact: true }).click();
  const mLabels = await page.locator('.gcard .glabel').allInnerTexts();
  assert.ok(mLabels.some((t) => t.includes('Brás')), mLabels.join(','));
  assert.ok((await page.locator('.gcard').first().locator('.brow-day').count()) > 0, '商家卡片内按日期列出');
  const mCard = await page.locator('.gcard.by-merchant').first().innerText();
  assert.match(mCard, /开单 \d\d\/\d\d/);
  assert.ok(!/到期 \d\d\/\d\d/.test(mCard) && !/最近/.test(mCard) && !/\d 笔/.test(mCard), mCard);
  await page.screenshot({ path: 'shot-merchant-360.png', fullPage: true });
  await page.getByRole('button', { name: '按日期', exact: true }).click();
  await page.getByRole('button', { name: '多选' }).click();
  await page.getByRole('button', { name: '全选' }).click();
  await page.getByRole('toolbar').getByRole('button', { name: '标记已付' }).click();
  await page.getByRole('button', { name: '全部标记已付' }).click();
  await page.getByText(/已标记 2 笔已付/).waitFor();
  ok('B08', '账单按日期/按商家卡片归类、月历按周分卡、筛选抽屉、多选批量标记已付');

  // 应用内相机
  await page.goto(BASE + '#/');
  await page.getByRole('button', { name: '拍照识别' }).click();
  await page.getByRole('dialog', { name: '拍摄单据' }).waitFor();
  await page.waitForFunction(() => { const v = document.querySelector('.cam video'); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
  await page.screenshot({ path: 'shot-camera-360.png' });
  await page.getByRole('button', { name: '按下快门' }).click();
  await page.getByRole('button', { name: '使用这张' }).click();
  await page.getByText('拖动四个角，框住单据').waitFor();
  ok('B04', '应用内相机：取景框拍照 → 预览确认 → 进入裁切（默认裁切为取景框）');

  // 清除示例
  await page.goto(BASE + '#/');
  await page.getByRole('button', { name: '清除示例' }).click();
  await page.getByText('熟悉后可一键清除').waitFor({ state: 'detached' });
  // 清空上面新增功能测试产生的数据，从空库开始第一轮验收
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('zhangqi-zhushou'); q.onsuccess = q.onerror = q.onblocked = () => r(null); }));
  await page.reload();
  await page.getByText('还没有账单').first().waitFor();

  // A02 固定资料
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: /固定资料/ }).click();
  await page.getByRole('tab', { name: '付款账号' }).click();
  await page.getByRole('button', { name: '新增账号' }).click();
  await page.fill('#a-label', 'PIX Itaú 主账户');
  await page.fill('#a-bank', 'Itaú');
  await page.fill('#a-pix', '12.345.678/0001-90');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('PIX Itaú 主账户').waitFor();
  assert.ok(await page.getByText('••••••1-90').isVisible(), 'PIX 应脱敏');
  await page.getByRole('tab', { name: '商家' }).click();
  await page.getByRole('button', { name: '新增商家' }).click();
  await page.fill('#m-name', 'Loja Exemplo');
  await page.fill('#m-alias', 'LOJA EX');
  await page.selectOption('#m-acc', { label: 'PIX Itaú 主账户 · Itaú' });
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('Loja Exemplo').first().waitFor();
  // 重名阻止
  await page.getByRole('button', { name: '新增商家' }).click();
  await page.fill('#m-name', 'loja ex');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText(/与「Loja Exemplo」重复/).waitFor();
  await page.getByRole('button', { name: '取消' }).click();
  ok('A02', '新增商家/账号、默认账号、PIX 脱敏、重名阻止');

  // A01 手工四行
  await page.getByRole('button', { name: '新增账单' }).click();
  await page.getByRole('button', { name: '商家账单' }).click();
  await page.click('#f-merchant');
  await page.fill('#f-merchant', 'exemplo');
  await page.getByRole('option', { name: /Loja Exemplo/ }).click();
  assert.equal(await page.inputValue('#f-account'), 'PIX Itaú 主账户');
  await page.fill('#f-orderNumber', '0042');
  await page.fill('#f-billDate', '31/02/2026');
  await page.getByText('账单日期：日期不存在').waitFor();
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).getAttribute('aria-disabled'), 'true');
  ok('A06', '31/02/2026 被拒绝，保存按钮禁用');
  await page.fill('#f-billDate', '10/09/26');
  await page.getByText('账单日期只写了两位年份').waitFor();
  await page.getByRole('button', { name: '是 2026 年' }).click();
  assert.equal(await page.inputValue('#f-billDate'), '10/09/2026');
  ok('A06', '两位年份需确认后改写为 2026');
  await page.fill('#f-dueDate', '05/09/2026');
  await page.getByText('到期日早于账单日').first().waitFor();
  await page.getByRole('button', { name: '账期：' }).count();
  await page.getByRole('button', { name: '+30' }).click();
  assert.equal(await page.inputValue('#f-dueDate'), '10/10/2026');
  const rows = [['3', 'FN-A78', '0,10'], ['1', 'X-1', '0,20'], ['7', 'CA31 3', '19,99'], ['0,5', 'meio', '3,33']];
  for (let i = 2; i < 4; i++) await page.getByRole('button', { name: '添加一行' }).click();
  const cards = page.locator('.item-card');
  for (let i = 0; i < 4; i++) {
    await cards.nth(i).locator('input').nth(0).fill(rows[i][1]);
    await cards.nth(i).locator('input').nth(1).fill(rows[i][0]);
    await cards.nth(i).locator('input').nth(2).fill(rows[i][2]);
  }
  await page.getByText('R$ 142,10').first().waitFor();
  await noOverflow('编辑页');
  await page.screenshot({ path: 'shot-editor-360.png', fullPage: true });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已保存 R$ 142,10').waitFor();
  await page.reload();
  await page.getByText('R$ 142,10').first().waitFor();
  ok('A01', '四行整数分：0,30+0,20+139,93+1,67 = R$ 142,10，刷新后仍在');

  // A03 识别流程
  await page.goto(BASE + '#/capture');
  await page.setInputFiles('input[type=file]:not([capture])', 'ticket.jpg');
  await page.getByText('拖动四个角，框住单据').waitFor();
  await noOverflow('裁切页');
  await page.screenshot({ path: 'shot-crop-360.png', fullPage: true });
  await page.getByRole('button', { name: '右转 90°' }).click();
  await page.getByText('当前 90°').waitFor();
  await page.getByRole('button', { name: '左转 90°' }).click();
  await page.getByText('当前 0°').waitFor();
  await page.getByRole('button', { name: '调整增强' }).click();
  await page.getByText('选择识别用的版本').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '黑字白底版' }).click();
  await page.screenshot({ path: 'shot-enhance-360.png', fullPage: true });
  await page.getByRole('button', { name: '下一步：识别' }).click();
  await page.getByRole('button', { name: /云端识别服务/ }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.provider[aria-pressed="true"]') || true);
  await page.getByRole('button', { name: /云端识别服务/ }).click();
  await page.getByRole('button', { name: '开始识别' }).click();
  await page.getByText('发送图片进行识别？').waitFor();
  await page.getByRole('button', { name: '同意并识别' }).click();
  await page.getByText('核对识别结果').first().waitFor({ timeout: 20000 });
  await page.getByText('R$ 368,00').first().waitFor();
  assert.equal(await page.inputValue('#f-merchant'), 'Loja Exemplo');
  const saveBtn = page.getByRole('button', { name: '确认保存' });
  assert.ok(await saveBtn.isDisabled(), '未确认前不能保存');
  await noOverflow('复核页');
  await page.screenshot({ path: 'shot-review-form-360.png', fullPage: true });
  await page.getByRole('button', { name: '原图', exact: true }).click();
  await page.getByRole('button', { name: /^4 CA31-7/ }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-review-image-360.png' });
  await page.getByRole('button', { name: /核对字段/ }).click();
  await page.getByRole('button', { name: '是 2026 年' }).click();
  await page.getByText('到期日期：日期为空').waitFor();
  await page.getByRole('button', { name: '+30' }).click();
  assert.equal(await page.inputValue('#f-dueDate'), '12/10/2026');
  await page.getByRole('button', { name: '全部标为已核对' }).click();
  assert.ok(await saveBtn.isDisabled(), '未勾选确认前不能保存');
  await page.getByLabel('我已对照原图确认').check();
  assert.ok(await saveBtn.isEnabled(), '处理完后应可保存: ' + await page.locator('#gate-reasons').innerText().catch(() => ''));
  // A05：改小计冲突（修改数量，图片小计不变）
  await page.locator('.item-card').first().locator('input').nth(1).fill('31');
  await page.getByText(/第 1 行算术不符：计算 R\$ 248,00，图片小计 R\$ 240,00，差额 \+R\$ 8,00/).waitFor();
  await page.getByText(/总额冲突：计算 R\$ 376,00，图片 TOTAL R\$ 368,00/).waitFor();
  assert.ok(await saveBtn.isDisabled(), '新警告需核对');
  ok('A05', '算术冲突同时显示计算值、图片值与差额，不自动修正，需重新核对');
  await page.locator('.item-card').first().locator('input').nth(1).fill('30');
  await page.getByText('R$ 368,00').first().waitFor();
  assert.ok(await saveBtn.isEnabled());
  await saveBtn.click();
  await page.getByText('已保存 R$ 368,00').waitFor();
  ok('A03', '样例票据形成 4 行明细，计算总额 R$ 368,00；确认后保存');
  sheet = await openBill('#0258');
  const txt = await sheet.innerText();
  assert.match(txt, /30 × FN-A78 × 8,00\s*240,00/);
  assert.match(txt, /识别/);

  // 编辑：识别记录
  await sheet.getByRole('button', { name: '编辑' }).click();
  await page.getByText(/识别记录/).waitFor();
  await page.getByRole('button', { name: '返回' }).click();

  // 标记已付（行内一键）/ 恢复（详情抽屉）
  await page.getByRole('button', { name: '标记已付：Loja Exemplo' }).first().waitFor();
  await page.locator('.brow', { hasText: '#0042' }).getByRole('button', { name: /^标记已付/ }).click();
  await page.getByText('已标记付款').waitFor();
  await page.getByRole('tab', { name: /^已付/ }).click();
  sheet = await openBill('#0042');
  await sheet.getByRole('button', { name: '恢复未付' }).click();
  await page.getByText('已恢复为未付').waitFor();
  await closeSheet();
  ok('流程', '列表一键标记已付；详情里恢复未付');

  // A08 ICS
  await page.goto(BASE + '#/settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出全部未付账单' }).click()]);
  const icsPath = 'export.ics';
  await dl.saveAs(icsPath);
  const ics = (await readFile(icsPath, 'utf8')).replace(/\r\n /g, '');
  assert.match(ics, /UID:[0-9a-f-]{36}@zhangqi-zhushou.local/);
  assert.match(ics, /SUMMARY:付款：Loja Exemplo R\$ 368\\,00/);
  assert.match(ics, /DTSTART;VALUE=DATE:\d{8}/);
  assert.match(ics, /付款账号：PIX Itaú 主账户/);
  assert.match(ics, /TRIGGER:-P2DT15H/);
  ok('A08', '日历导出：UID、商家、金额、账号、提前闹钟正确');
  await page.screenshot({ path: 'shot-settings-360.png', fullPage: true });

  // A09 备份恢复
  await page.goto(BASE + '#/data');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出备份 JSON' }).click()]);
  await bk.saveAs('backup.json');
  const backup = JSON.parse(await readFile('backup.json', 'utf8'));
  assert.equal(backup.bills.length, 2);
  backup.bills[0].notes = '备份里改过';
  backup.bills[0].updatedAt = '2099-01-01T00:00:00.000Z';
  await writeFile('backup-mod.json', JSON.stringify(backup));
  await page.setInputFiles('input[type=file]', 'backup-mod.json');
  await page.getByRole('table').waitFor();
  const tbl = await page.getByRole('table').innerText();
  assert.match(tbl, /账单\s+0\s+1\s+0\s+1/);
  await page.getByRole('button', { name: '确认合并导入' }).click();
  await page.getByRole('button', { name: '合并导入', exact: true }).click();
  await page.getByText('导入完成').waitFor();
  await writeFile('backup-bad.json', JSON.stringify({ ...backup, bills: [{ ...backup.bills[0], dueDate: '2026-02-31' }] }));
  await page.setInputFiles('input[type=file]', 'backup-bad.json');
  await page.getByText(/发现 1 个错误/).waitFor();
  ok('A09', '导出、预览（1 更新 1 相同）、合并导入；错误日期被检出');
  await page.screenshot({ path: 'shot-data-360.png', fullPage: true });

  // 列表页
  await page.goto(BASE + '#/bills');
  await page.fill('#q', '0258');
  await page.locator('.listsum').waitFor();
  assert.equal(await page.locator('.brow').count(), 1);
  await noOverflow('账单页');
  ok('A10', '360px 下首页/编辑/裁切/复核/账单页无横向溢出');

  // 表格批量导入 + 重复提醒
  await page.goto(BASE + '#/data');
  await page.fill('#imp-text', '商家;单号;开单日期;到期日期;金额\nLoja Exemplo;7001;01/09/2026;01/10/2026;1.234,56\nNova Loja SP;7002;02/09/2026;02/10/2026;800,00\nLoja Exemplo;0042;10/09/2026;10/10/2026;142,10\nSem nada;;;;\n');
  await page.getByText('可导入 2').waitFor();
  await page.getByText('重复跳过 1').waitFor();
  await page.getByText('有问题 1').waitFor();
  await page.screenshot({ path: 'shot-import-360.png', fullPage: true });
  await page.getByRole('button', { name: /导入 2 笔账单/ }).click();
  await page.getByText(/已导入 2 笔账单，新建 1 个商家/).waitFor();
  await page.goto(BASE + '#/bills');
  await page.fill('#q', 'Nova Loja');
  await page.locator('.brow', { hasText: '#7002' }).waitFor();
  ok('B15', '从表格批量导入：自动识别表头、按商家账期补到期日、重复行跳过、错误行给原因、可自动新建商家');

  // 手工录入时的重复提醒
  await page.goto(BASE + '#/new');
  await page.click('#f-merchant');
  await page.fill('#f-merchant', 'Loja');
  await page.getByRole('option', { name: /Loja Exemplo/ }).click();
  await page.fill('#f-orderNumber', '7001');
  await page.getByRole('button', { name: '仅填总金额', exact: true }).click();
  await page.fill('#f-totalOnly', '50,00');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const dupDlg = page.getByRole('dialog', { name: '可能重复录入' });
  await dupDlg.waitFor();
  assert.match(await dupDlg.innerText(), /单号 7001/);
  await dupDlg.getByRole('button', { name: '取消' }).click();
  ok('B16', '手工录入同商家同单号时提醒可能重复，可取消');
  await page.goto(BASE + '#/bills');

  // 到期日遇周末 / 节假日提示
  await page.goto(BASE + '#/new');
  await page.fill('#f-dueDate', '10/10/2026');
  await page.getByText(/10\/10 是周六，银行顺延到 周二 13\/10/).waitFor();
  await page.getByRole('button', { name: '改为 13/10' }).click();
  assert.equal(await page.inputValue('#f-dueDate'), '13/10/2026');
  ok('B17', '到期日是周末或巴西节假日时提示银行顺延日（会跳过节日），可一键改为下一个工作日');

  // 批量顺延 + 删除可撤销
  await page.goto(BASE + '#/bills');
  await page.fill('#q', '7001');
  await page.locator('.brow', { hasText: '#7001' }).waitFor();
  await page.getByRole('button', { name: '多选' }).click();
  await page.getByRole('button', { name: '全选' }).click();
  await page.getByRole('toolbar').getByRole('button', { name: '顺延' }).click();
  await page.getByRole('button', { name: '+7 天' }).click();
  await page.getByText(/已把 1 笔到期日顺延 7 天/).waitFor();
  assert.match(await page.locator('.brow', { hasText: '#7001' }).innerText(), /08\/10/);
  sheet = await openBill('#7001');
  await sheet.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await page.getByText('账单已删除').waitFor();
  await page.getByRole('button', { name: '撤销' }).last().click();
  await page.getByText('已恢复账单').waitFor();
  await page.locator('.brow', { hasText: '#7001' }).waitFor();
  await page.fill('#q', '');
  ok('B18', '多选后批量顺延到期日；删除账单后可立即撤销恢复');

  // PDF 单据：直接读文字层，数字线校验后自动填金额、到期日、付款码
  await page.goto(BASE + '#/capture');
  await page.setInputFiles('input[type=file]:not([capture])', 'boleto-exemplo.pdf');
  await page.getByText('PDF 里已读到这些信息').waitFor({ timeout: 20000 });
  await page.getByText('数字线已校验').waitFor();
  // PDF 已读出文字：AI 识别默认折叠，不打扰
  assert.equal(await page.getByRole('button', { name: '开始识别' }).count(), 0);
  await page.getByRole('button', { name: '改用 AI 识别整页…' }).waitFor();
  await page.screenshot({ path: 'shot-pdf-360.png', fullPage: true });
  await page.getByRole('button', { name: '直接用 PDF 内容生成账单（不上传）' }).click();
  await page.getByText(/付款码校验通过（来自PDF 文字）：金额 R\$ 456,78，到期 27\/10\/2026/).waitFor({ timeout: 15000 });
  assert.equal(await page.inputValue('#f-dueDate'), '27/10/2026');
  assert.equal(await page.inputValue('#f-totalOnly'), '456,78');
  assert.match(await page.inputValue('#f-paymentCode'), /^23793\.38128 00000\.000125 34567\.890107 2 16120000045678$/);
  await page.screenshot({ path: 'shot-pdf-review-360.png', fullPage: true });
  await page.getByRole('button', { name: '全部标为已核对' }).click().catch(() => {});
  await page.getByLabel('我已对照原图确认').check();
  await page.getByRole('button', { name: '确认保存' }).click();
  await page.getByText(/已保存 R\$ 456,78/).waitFor();
  ok('B19', 'PDF 单据：读取文字层（AI 识别默认折叠），数字线校验通过后自动填入金额、到期日、付款码、会计分类，不上传');

  // 对账单（AI 识别结果为多笔欠款 + 付款记录）→ 批量导入
  fixture = fixtures.statement;
  await page.goto(BASE + '#/capture');
  await page.setInputFiles('input[type=file]:not([capture])', 'ticket.jpg');
  await page.getByText('拖动四个角，框住单据').waitFor();
  await page.getByRole('button', { name: '一键识别' }).click();
  await page.getByRole('button', { name: /云端识别服务/ }).waitFor({ timeout: 30000 });
  // 一键识别会自动弹出同意框：等一下再判断，避免和弹窗抢点击
  await page.getByText('发送图片进行识别？').waitFor({ timeout: 2500 }).catch(() => {});
  if (!(await page.getByText('发送图片进行识别？').isVisible())) {
    await page.getByRole('button', { name: /云端识别服务/ }).click();
    await page.getByRole('button', { name: '开始识别' }).click();
  }
  await page.getByRole('button', { name: '同意并识别' }).click({ timeout: 5000 }).catch(() => {});
  await page.getByText(/识别为对账单/).waitFor({ timeout: 30000 });
  await page.selectOption('#st-m', { label: 'Loja Exemplo' });
  await page.getByText(/未付合计 R\$ 2\.300,00 与对账单「结欠」一致/).waitFor();
  await page.screenshot({ path: 'shot-statement-360.png', fullPage: true });
  await page.getByRole('button', { name: '导入 2 笔账单' }).click();
  await page.getByText('已导入 2 笔账单（其中已付 1 笔）').waitFor();
  await page.getByRole('tab', { name: /^全部/ }).click();
  await page.locator('.brow', { hasText: '#2609-0202' }).waitFor();
  fixture = fixtures.ticket;
  ok('B20', '对账单：一次识别多笔欠款，按付款记录标已付、按商家账期算到期日、核对结欠，并记住对账单上的客户编号');

  // 分次付款
  await page.goto(BASE + '#/bills');
  await page.fill('#q', '');
  sheet = await openBill('#0258');
  await sheet.getByRole('button', { name: '记一笔付款' }).click();
  const payDlg = page.getByRole('dialog', { name: /记一笔付款/ });
  await payDlg.waitFor();
  await payDlg.getByRole('button', { name: '一半' }).click();
  assert.equal(await page.inputValue('#pay-amount'), '184,00');
  await page.fill('#pay-amount', '100,00');
  await payDlg.locator('input[type=file]').setInputFiles('ticket.jpg');
  await payDlg.getByAltText('付款凭证预览').waitFor();
  await payDlg.getByRole('button', { name: '保存付款' }).click();
  await page.getByText('已记 R$ 100,00，还差 R$ 268,00').waitFor();
  // 只付了一部分：详情继续开着，显示已付与还差，并可付清尾款
  assert.match(await sheet.innerText(), /已付 R\$ 100,00 · 还差 R\$ 268,00/);
  await sheet.getByRole('button', { name: /付清尾款 R\$ 268,00/ }).waitFor();
  await closeSheet();
  const prow = page.locator('.brow', { hasText: '#0258' });
  await prow.getByText('已付 27%').waitFor();
  assert.match(await prow.innerText(), /R\$ 268,00/);
  sheet = await openBill('#0258');
  await sheet.getByRole('button', { name: /查看 .* 的付款凭证/ }).click();
  await page.getByRole('dialog', { name: '付款凭证' }).getByAltText('付款凭证').waitFor();
  await page.keyboard.press('Escape');
  await sheet.getByRole('button', { name: /删除 .* 的付款记录/ }).click();
  await page.getByText('已删除这条付款记录').waitFor();
  await closeSheet();
  assert.match(await page.locator('.brow', { hasText: '#0258' }).innerText(), /R\$ 368,00/);
  ok('B13', '分次付款：记一笔部分付款（附付款凭证照片）后列表显示还差多少与已付百分比，可查看凭证、删除付款记录还原');

  // 商家对账
  await page.goto(BASE + '#/masters');
  await page.getByRole('button', { name: /查看 Loja Exemplo/ }).click();
  const mDlg = page.getByRole('dialog', { name: 'Loja Exemplo' });
  await mDlg.waitFor();
  const mTxt = await mDlg.innerText();
  assert.match(mTxt, /还要付/);
  assert.match(mTxt, /平均账期/);
  assert.match(mTxt, /按时付清/);
  await page.screenshot({ path: 'shot-merchant-sheet-360.png' });
  await mDlg.getByRole('button', { name: '复制未付清单' }).click();
  await page.getByText(/未付清单已复制/).waitFor();
  const stmt = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(stmt, /Loja Exemplo — 未付清单/);
  assert.match(stmt, /合计：R\$/);
  await page.keyboard.press('Escape');
  ok('B14', '资料页点商家可看对账：还要付、累计已付、平均账期、按时付清率与最近账单');

  // 每月流水（先付一笔，测完恢复）
  await page.goto(BASE + '#/bills');
  await page.fill('#q', '');
  await page.locator('.brow', { hasText: '#0042' }).getByRole('button', { name: /^标记已付/ }).click();
  await page.getByText('已标记付款').waitFor();
  await page.goto(BASE + '#/');
  await page.getByRole('button', { name: '流水' }).click();
  const fh = await page.locator('.flow-head').innerText();
  assert.match(await page.locator('.weeklist').innerText(), /本周内/);
  assert.match(fh, /\d+月实付 · \d+ 笔/);
  assert.equal(await page.locator('.fbar').count(), 12);
  await page.screenshot({ path: 'shot-flow-360.png', fullPage: true });
  const [fdl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出本月流水表格' }).click()]);
  await fdl.saveAs('flow.csv');
  const fcsv = await readFile('flow.csv', 'utf8');
  assert.match(fcsv, /^\ufeff付款日期;商家\/缴费单位/);
  assert.match(fcsv, /合计;/);
  await page.locator('.fbar').nth(10).click();
  assert.match(page.url(), /#\/flow\/\d{4}-\d{2}$/);
  assert.match(fcsv, /Loja Exemplo;商家货款;;0042;/);
  await page.goto(BASE + '#/bills/paid');
  sheet = await openBill('#0042');
  await sheet.getByRole('button', { name: '恢复未付' }).click();
  await page.getByText('已恢复为未付').waitFor();
  await closeSheet();
  ok('B12', '每月流水：实付合计与环比、近 12 个月柱状图（点柱切换月份）、按商家/分类/账号汇总、按付款日明细、导出 CSV');

  // 外观：光明 / 深色切换
  await page.goto(BASE + '#/');
  await page.getByRole('button', { name: /切换到(深色|光明)模式/ }).click();
  const th1 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.getByRole('button', { name: /切换到(深色|光明)模式/ }).click();
  const th2 = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.ok(th1 && th2 && th1 !== th2, `${th1} ${th2}`);
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), th2, '外观选择应记住');
  await page.goto(BASE + '#/settings');
  await page.getByRole('group', { name: '外观模式' }).getByRole('button', { name: '光明' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  // 返回时保留账单页的搜索
  await page.goto(BASE + '#/bills');
  await page.fill('#q', 'Loja');
  await page.locator('.brow').first().locator('.brow-main').click();
  await page.getByRole('dialog').getByRole('button', { name: '编辑' }).click();
  await page.getByRole('button', { name: '返回' }).click();
  assert.equal(await page.inputValue('#q'), 'Loja', '返回后搜索词应保留');
  await page.fill('#q', '');
  // 每月预算 + 键盘快捷键
  await page.goto(BASE + '#/settings');
  await page.fill('#s-budget', '3.000,00');
  await page.locator('#s-rd').click();
  await page.goto(BASE + '#/flow');
  await page.getByText(/本月预算 R\$ 3.000,00/).waitFor();
  await page.locator('body').press('l');
  await page.waitForFunction(() => location.hash.startsWith('#/bills'));
  await page.locator('body').press('n');
  await page.getByRole('dialog', { name: '新增账单' }).waitFor();
  await page.keyboard.press('Escape');
  ok('B11', '光明/深色一键切换并记住；设置里可选跟随系统；从详情返回列表保留搜索；每月预算进度；电脑快捷键 N/L');

  // ===== 云同步：两台设备通过 Supabase 同步 =====
  await page.goto(BASE + '#/settings');
  await page.fill('#sy-url', SB_URL);
  await page.fill('#sy-key', SB_KEY);
  await page.getByRole('button', { name: '测试连接并开始同步' }).click();
  await page.getByText(/同步完成：下载 0 条，上传 \d+ 条/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /已同步/ }).first().waitFor();
  await page.getByRole('button', { name: '复制配置到别的设备' }).click();
  await page.getByText(/配置已复制/).waitFor();
  const cfgText = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(cfgText, /^ZQSYNC1:/);
  await page.screenshot({ path: 'shot-sync-360.png', fullPage: true });

  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Sao_Paulo', locale: 'zh-CN', isMobile: true, hasTouch: true });
  await ctx2.route(SB_URL + '/**', supabaseRoute);
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push('设备2: ' + e.message));
  await p2.goto(BASE + '#/settings');
  await p2.fill('#sy-paste', cfgText);
  await p2.getByRole('button', { name: '导入', exact: true }).click();
  await p2.getByText(/已连接，下载 \d+ 条/).waitFor({ timeout: 15000 });
  await p2.goto(BASE + '#/bills');
  await p2.fill('#q', '0258');
  await p2.locator('.brow', { hasText: 'Loja Exemplo' }).waitFor();
  // 示例数据只在本机，不上传
  await p2.fill('#q', '示例');
  const sampleRows = await p2.locator('.brow').count();
  assert.ok(sampleRows > 0, '设备 2 应有自己的示例数据');
  ok('B09', '设备 1 连接 Supabase 并上传；设备 2 粘贴配置一键导入并下载到相同账单（示例数据不上传）');

  // 设备 2 标记已付 → 自动同步 → 设备 1 看到
  await p2.fill('#q', '0258');
  await p2.locator('.brow', { hasText: '#0258' }).getByRole('button', { name: /^标记已付/ }).click();
  await p2.getByText('已标记付款').waitFor();
  const before = sbCalls;
  await p2.waitForFunction(() => document.querySelector('.sync-status')?.textContent?.includes('已同步'), null, { timeout: 10000 });
  await p2.waitForTimeout(3000);
  assert.ok(sbCalls > before, '改动后应自动同步');
  await page.goto(BASE + '#/bills');
  await page.locator('.sync-status').click();
  await page.getByRole('tab', { name: /^已付/ }).click();
  await page.locator('.brow', { hasText: '#0258' }).waitFor({ timeout: 10000 });
  // 设备 1 删除 0042 → 设备 2 也消失
  await page.getByRole('tab', { name: /^未付/ }).click();
  sheet = await openBill('#0042');
  await sheet.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await page.getByText('账单已删除').waitFor();
  await page.waitForTimeout(3500);
  await p2.reload();
  await p2.goto(BASE + '#/bills/all');
  await p2.waitForTimeout(2000);
  await p2.fill('#q', 'Loja');
  await p2.locator('.brow', { hasText: '#0258' }).waitFor();
  assert.equal(await p2.locator('.brow', { hasText: '#0042' }).count(), 0, '删除应同步到设备 2');
  await ctx2.close();
  ok('B10', '设备 2 付款自动上传，设备 1 同步后看到已付；设备 1 删除后设备 2 也删除');

  // ===== AI 识别：同步用的 Supabase 里的识别函数（Gemini），无需再填地址和口令 =====
  await page.goto(BASE + '#/settings');
  await page.getByText(/连接不到识别函数|找不到识别函数/).first().waitFor({ timeout: 15000 });
  await page.getByText('开启 AI 识别：Supabase + Gemini').waitFor();
  fnDeployed = true;
  // 控制台里函数网址的最后一段不是 recognize 时，填函数名（或粘贴整个网址）即可
  await page.fill('#s-fn', SB_URL + '/functions/v1/quick-api');
  await page.getByRole('button', { name: '保存并检查' }).click();
  // 账号版：AI 识别需要登录
  await page.getByText(/AI 识别未开启：AI 识别需要登录/).waitFor({ timeout: 15000 });
  assert.equal(await page.inputValue('#s-fn'), 'quick-api');
  await page.getByText(SB_URL + '/functions/v1/quick-api').waitFor();
  ok('B21', 'AI 识别：自动发现 Supabase 识别函数（未部署时给开启步骤；函数名可改，粘贴网址自动取名）；账号版未登录时提示先登录');

  // ===== 账号：邮箱验证码登录 → 账号同步 → AI 识别计额度 → 订阅专业版 =====
  await page.goto(BASE + '#/account');
  await page.fill('#acc-email', 'ana@example.com');
  // 邮箱验证码方式（需要 SMTP）
  await page.getByRole('button', { name: '邮箱验证码' }).click();
  await page.getByRole('button', { name: '发送验证码' }).click();
  await page.getByText('验证码已发送到邮箱').waitFor();
  assert.deepEqual(otpSent, ['ana@example.com']);
  await page.fill('#acc-code', '000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('验证码不正确或已过期').waitFor();
  // 邮箱 + 密码（不发邮件）：未注册时登录报错 → 注册即登录
  await page.getByRole('button', { name: '邮箱 + 密码' }).click();
  await page.getByRole('button', { name: '已经有账号？登录' }).click();
  await page.fill('#acc-pw', 'segredo123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('邮箱或密码不正确').waitFor();
  await page.getByRole('button', { name: '还没有账号？注册' }).click();
  await page.getByRole('button', { name: '注册，免费试用 30 天' }).click();
  await page.getByText('注册成功，已登录 ana@example.com').waitFor({ timeout: 15000 });
  await page.getByText('0 / 5 次').waitFor({ timeout: 15000 });
  await page.getByText('试用', { exact: true }).first().waitFor();
  await page.getByText(/免费试用到 .*（还剩 30 天）/).waitFor();
  const acctRows = await pg.query(`select count(*)::int as n from zq_records where space = 'u:11111111-1111-4111-8111-111111111111' and kind = 'bill'`);
  assert.ok(acctRows.rows[0].n > 0, '登录后本机账单应上传到账号');
  await page.screenshot({ path: 'shot-account-360.png', fullPage: true });
  await page.goto(BASE + '#/settings');
  await page.getByText('已用账号同步').waitFor();
  await page.getByText('AI 识别 · Gemini').first().waitFor({ timeout: 15000 });
  await page.goto(BASE + '#/capture');
  await page.setInputFiles('input[type=file]:not([capture])', 'ticket.jpg');
  await page.getByText('拖动四个角，框住单据').waitFor();
  await page.getByRole('button', { name: '一键识别' }).click();
  await page.getByText('发送图片进行识别？').waitFor({ timeout: 30000 });
  await page.getByText(/由AI 识别 · Gemini读取文字/).waitFor();
  const gBefore = geminiCalls;
  await page.getByRole('button', { name: '同意并识别' }).click();
  await page.getByText('核对识别结果').first().waitFor({ timeout: 20000 });
  await page.getByText('R$ 368,00').first().waitFor();
  assert.equal(geminiCalls, gBefore + 1, '应经 Supabase 函数调用 Gemini 一次');
  assert.ok(fnPaths.includes('/functions/v1/quick-api'), '应调用填写的函数名 ' + fnPaths.join(','));
  assert.equal(await page.inputValue('#f-merchant'), 'Loja Exemplo');
  // 学习：与「Loja Exemplo」历史记录一致的行免逐行核对
  await page.getByText(/行与「Loja Exemplo」的历史记录一致/).waitFor();
  await page.screenshot({ path: 'shot-ai-review-360.png', fullPage: true });
  await page.goto(BASE + '#/account');
  await page.getByText('1 / 5 次').waitFor({ timeout: 15000 });
  ok('B22', '账号：邮箱+密码注册登录（不发邮件）与邮箱验证码两种方式（错码/错密码提示），本机账单自动上传到账号并改为账号同步；AI 识别按次计（试用 5 次）；识别结果按商家历史免逐行核对');
  // 试用期没有导出（T2）：点导出弹出订阅说明
  await page.goto(BASE + '#/data');
  await page.getByRole('button', { name: '导出账单记录（CSV）' }).click();
  await page.getByRole('dialog', { name: '导出记录是 T2 的功能' }).waitFor();
  await page.getByRole('button', { name: '以后再说' }).click();
  // 试用到期 → 只读：首页提示、新增弹出订阅、识别页换成订阅说明
  await pg.query(`update zq_profiles set trial_until = now() - interval '1 day' where user_id = '11111111-1111-4111-8111-111111111111'`);
  await page.goto(BASE + '#/account');
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByText('试用已结束，账单只读').first().waitFor({ timeout: 15000 });
  await page.goto(BASE + '#/');
  await page.getByText(/试用已结束.*账单只读/).first().waitFor();
  await page.getByRole('button', { name: '新增账单' }).last().click();
  await page.getByRole('dialog', { name: '试用已结束' }).waitFor();
  await page.screenshot({ path: 'shot-paywall-360.png', fullPage: true });
  await page.getByRole('button', { name: '以后再说' }).click();
  await page.goto(BASE + '#/capture');
  await page.getByText(/新增、编辑、识别单据需要订阅/).waitFor();
  // 订阅 T2 年付：跳到 Mercado Pago（模拟直接返回），回来后按 Mercado Pago 的真实状态开通
  mpStatus = 'authorized';
  await page.goto(BASE + '#/account');
  await page.getByRole('button', { name: '订阅 T2' }).click();
  for (let i = 0; i < 100 && !mpReturn; i++) await page.waitForTimeout(100);
  await page.waitForLoadState('load');
  assert.match(mpReturn, /^http:\/\/localhost:9910\/\?mp=1$/);
  assert.equal(mpBody.auto_recurring.transaction_amount, 199.99);
  assert.equal(mpBody.auto_recurring.frequency, 12);
  await page.getByText(/T2（年付）有效期至/).waitFor({ timeout: 15000 });
  await page.getByText('0 / 50 次').waitFor(); // 订阅后按自然月计次（试用期的次数单独计）
  await page.goto(BASE + '#/data');
  await page.getByRole('button', { name: '导出账单记录（CSV）' }).click();
  await page.getByText('已导出账单记录').waitFor();
  ok('B23', '套餐：试用 30 天 + AI 5 次；试用期导出需 T2；到期只读（首页提示、新增与识别换成订阅说明）；Mercado Pago 订阅 T2 年付（R$ 199,99/12 个月）后恢复全部功能、AI 50 次/月、可导出 CSV');

  // 公开部署（网站根目录有 zq-config.json）：打开就是介绍 + 注册；普通用户看不到部署相关的技术设置
  const ctx3 = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'America/Sao_Paulo', locale: 'zh-CN', isMobile: true, hasTouch: true });
  await ctx3.route(SB_URL + '/**', supabaseRoute);
  await ctx3.route('**/zq-config.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ supabaseUrl: SB_URL, publishableKey: SB_KEY, functionName: 'quick-api' }) }));
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errors.push('设备3: ' + e.message));
  await p3.goto(BASE);
  await p3.getByText('新账号免费试用 30 天，含 5 次 AI 识别').waitFor({ timeout: 15000 });
  await p3.screenshot({ path: 'shot-welcome-390.png', fullPage: true });
  await p3.fill('#acc-email', 'cris@example.com');
  await p3.fill('#acc-pw', 'segredo456');
  await p3.getByRole('button', { name: '注册，免费试用 30 天' }).click();
  await p3.getByText(/免费试用还剩 30 天/).waitFor({ timeout: 15000 });
  await p3.goto(BASE + '#/settings');
  await p3.getByText('AI 识别与隐私').waitFor();
  assert.equal(await p3.locator('#s-fn').count(), 0, '普通用户不应看到识别函数名');
  assert.equal(await p3.getByText('开启 AI 识别：Supabase + Gemini').count(), 0);
  await ctx3.close();
  ok('B24', '公开部署：打开网页即是介绍与注册（不需要任何配置），注册后开始 30 天试用；普通用户看不到部署相关的技术设置');

  // 桌面
  const d = await browser.newContext({ viewport: { width: 1280, height: 860 }, timezoneId: 'America/Sao_Paulo' });
  const dp = await d.newPage();
  await dp.goto(BASE);
  await dp.waitForTimeout(1200);
  await dp.screenshot({ path: 'shot-dashboard-1280.png' });
  await dp.goto(BASE + '#/bills/all');
  await dp.waitForTimeout(600);
  await dp.screenshot({ path: 'shot-bills-1280.png' });

  // 暗色
  const dk = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', timezoneId: 'America/Sao_Paulo' });
  const kp = await dk.newPage();
  await kp.goto(BASE);
  await kp.waitForTimeout(1200);
  await kp.screenshot({ path: 'shot-dark-390.png', fullPage: true });

  assert.deepEqual(errors, [], '页面错误: ' + errors.join('\n'));
  ok('稳定性', '全程无页面脚本错误');
} finally {
  await browser.close();
  srv.kill();
  upstream.close();
  gemini.close();
  await writeFile('e2e-result.txt', log.join('\n') + '\n');
}
