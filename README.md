<<<<<<< HEAD
# 账期助手

本地优先的商家账期管理与票据识别应用（第一阶段：本地版）。移动端优先，简体中文界面，BRL / DD/MM/YYYY / America/Sao_Paulo。

## 快速开始

```bash
npm install
npm run dev            # 前端开发服务器 http://localhost:5173
npm test               # 130+ 个自动测试（金额、日期、状态、ICS、迁移、备份、OCR 门槛、账期规则、分期、缴费、重复周期、分组、识别服务、Worker、Supabase 同步）
npm run build          # 生产构建 → dist/（PWA，可部署到 GitHub Pages / 任意静态主机）
npm run build:single   # 单文件构建 → dist-single/index.html（可直接双击打开或内嵌）
```

需要云端识别时另开一个终端：

```bash
cp .env.example .env   # 填入 GEMINI_API_KEY（或 ANTHROPIC_API_KEY）
export $(grep -v '^#' .env | xargs) && npm run server   # http://localhost:8787
```

开发时 Vite 会把 `/api` 代理到 8787。生产环境可以只运行 `npm run build && npm run server`：服务同时托管 `dist/` 与 `/api`。
前端与服务分开部署时，在应用「设置 → 云端识别服务地址」填写完整 https 地址，并在服务端设置 `ALLOWED_ORIGINS`。

端到端验收脚本：`npm run build && cd e2e && node run.mjs`（需要 Playwright + Chromium，使用模拟的模型上游；云同步用 PGlite 跑真实建表脚本模拟 Supabase，不产生费用）。

## 第九轮：账号优先 + 套餐 + 一键部署（管理员只需填密钥，用户只需注册）

### 套餐（`shared/plans.mjs`，前端与服务端共用）

| | 试用 | T1 | T2 |
|---|---|---|---|
| 价格 | 注册后 30 天免费 | R$ 7,99/月 · R$ 89,99/年 | R$ 19,98/月 · R$ 199,99/年 |
| 账期、缴费、对账、流水、提醒、同步、PDF 直读、本机 OCR、日历 | ✓ | ✓ | ✓ |
| AI 识别 | 共 5 次 | 20 次/月 | 50 次/月 |
| 关屏推送 | — | ✓ | ✓ |
| 导出记录（CSV / Excel） | — | — | ✓ |

- **试用结束且没订阅 → 只读**：能看账单、标记已付；新增、编辑、识别、删除会弹出订阅说明；数据保留，订阅后立即恢复。服务端同样把关（AI 识别返回 402；账号同步只能下载、不能上传）。
- **付款**：Mercado Pago 自动续费（月付每月、年付每 12 个月）。T1 升级 T2：新订阅付款成功后自动切换并取消旧订阅。取消续费后已付的期间照常可用。每天的定时任务会顺便核对订阅状态，漏掉 Mercado Pago 通知也不影响。
- **用户只需注册**：网站根目录有 `zq-config.json` 时，打开网页就是介绍 + 注册页（邮箱 + 密码，不需要发邮件）；登录后本机数据自动上传到账号、所有设备同步。普通用户看不到任何部署相关的技术设置（管理员邮箱登录时才显示）。

### 一键部署（管理员做一次，约 10 分钟，不需要写代码）

1. **准备三个密钥**
   - Supabase 访问令牌：[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → Generate new token
   - Supabase 项目 ref：项目 Project URL `https://xxxx.supabase.co` 里的 `xxxx`（直接填整个 Project URL 也行）
   - Gemini 密钥：[aistudio.google.com/apikey](https://aistudio.google.com/apikey) → Create API key
   - （收费时再加）Mercado Pago：开发者后台 → 你的应用 → 生产凭证 Access Token
2. **GitHub 新建仓库**，把源码压缩包解压后的全部文件上传（注意要包含 `.github/workflows/deploy.yml`；如果上传后没有这个文件，用 Add file → Create new file，文件名填 `.github/workflows/deploy.yml`，粘贴内容）。
3. 仓库 **Settings → Secrets and variables → Actions → New repository secret**，逐个添加：
   - `SUPABASE_ACCESS_TOKEN`、`SUPABASE_PROJECT_REF`、`GEMINI_API_KEY`（必填）
   - `OWNER_EMAILS`（你的邮箱，管理员：全部功能、不限次数）
   - `MP_ACCESS_TOKEN`、`MP_WEBHOOK_SECRET`（收费时填）
4. 仓库 **Settings → Pages → Source 选 GitHub Actions**。
5. **Actions → 一键部署 → Run workflow**。约 3 分钟，日志最后会显示网站网址和 Mercado Pago 通知网址。

脚本 `scripts/deploy.mjs` 会自动：运行建表脚本（可重复运行、不删数据）→ 设置登录（邮箱 + 密码注册即登录、网站地址）→ 部署识别函数并关闭 Verify JWT → 写入函数密钥 → 开启每天 09:00 到期推送 → 生成 `zq-config.json` 并发布 GitHub Pages。以后改代码推送到 main 会自动重新部署；补填密钥后再点一次 Run workflow 即可。

Mercado Pago 通知（可选，建议）：开发者后台 → Webhooks，网址填日志里显示的 `…/functions/v1/recognize/billing/webhook`，事件选「Planos e assinaturas」。

上线前请准备隐私政策和服务条款（LGPD：说明单据图片会发送给 AI 识别）；Gemini 建议开启付费层。

## 第八轮：识别更聪明 + 账号、订阅、关屏推送（可以公开上线）

### 识别优化

| 改进 | 说明 |
|---|---|
| 会学习你的修改 | 核对时把型号 A 改成 B，下次同一商家的单据自动更正（复核页顶部列出「按你之前的修改」）；识别出的商家名和你选的商家不同，自动记为别名。数据存在商家资料里，随同步走 |
| 参考资料发给 AI | 每次 AI 识别附上你的常用商家名、各商家常用型号和上次单价（几 KB 文本），专门用来辨认模糊手写；提示词要求图片上没有的内容绝不写出，按参考资料辨认的字段置信度不得高于 0.8 |
| 商家智能匹配 | 去重音、去 LTDA/ME/COMERCIO 等后缀、包含关系、相似度；唯一且明显领先才匹配，相似匹配会请你确认一次 |
| 少点「已核对」 | 型号是该商家常用型号、且数量×单价与图片小计一致（或单价与上次相同）的行，不再要求逐行核对；商家精确匹配时不再问商家 |
| 手写误读一键改 | 小计对不上时，按手写常见误读（1/7、0/6、3/8、5/6…）找「只改一个数字就对上」的唯一读法，给「数量改为 7」这样的按钮；有两种以上改法时不给（不猜） |
| 型号建议、单价提醒 | 型号不在该商家常用型号里但只差一点 → 「可能是 FN-A78」一键改；单价比上次高/低 30% 以上 → 提醒 |
| 提示词 | 增加单据类型判断规则和手写要点：同上符号、划掉的字、中文数字、箱/件/打、O 与 0 统一、总计取最后一个、置信度分档 |
| 识别准确率 | 数据管理 →「识别准确率」：用你核对后保存的账单当标准答案，统计金额、型号、明细完整率、多出的行（疑似编造）、数量×单价、商家、到期日；可「用当前 AI 重新识别并评分」（用本机保存的单据照片），可导出测试集 JSON |

### 账号与订阅（给别人用、按月收费）

- **登录**：两种方式——「邮箱 + 密码」（不发任何邮件，Supabase 里关闭 Confirm email 即可）和「邮箱验证码」（需要能发邮件的 SMTP）。登录后本机账单自动上传到账号，所有设备用同一邮箱登录即同步（不再需要空间名和口令；旧的口令同步仍可用）。
- **套餐**：见第九轮（试用 30 天 + T1 / T2）。
- **付款**：Mercado Pago 订阅（信用卡自动续费）。付款后以 Mercado Pago 查询到的真实状态为准开通；取消续费后，已付的月份照常可用。
- **AI 识别必须登录**：公开部署时 publishable key 是公开的，所以识别函数默认只接受登录用户（自己用、不想登录可设 `ALLOW_KEY_ONLY=1`）。

### 关屏推送

账号页「关屏推送提醒」→ 开启。每天圣保罗 09:00 推送一条摘要（要付几笔、共多少、哪些逾期）。iPhone 需先「添加到主屏幕」再从主屏幕打开。推送内容按 Web Push 标准端到端加密（RFC 8291），VAPID 密钥由函数自动生成并保存在数据库。

### 手动上线步骤（不用一键部署时参考）

1. **数据库**：Supabase → SQL Editor，运行最新的 `supabase/setup.sql`（可重复运行；新增账号同步、套餐、用量、推送表，全部 RLS 关闭对外访问）。
2. **登录方式**：Authentication → Sign In / Providers → Email，关闭 **Confirm email**（用邮箱 + 密码注册登录，不需要 SMTP）。想用验证码登录再配置邮件：Authentication → Emails → **Magic Link** 模板加入验证码，例如 `<p>你的验证码：{{ .Token }}</p>`。Supabase 自带邮件每小时只能发几封，正式上线请在 Authentication → SMTP 配置自己的邮件服务（如 Resend、Brevo）。
3. **函数**：把 `supabase/functions/recognize/index.ts` 部署为 Edge Function（设置里可一键复制），函数设置关闭 **Verify JWT**。Secrets：
   - `GEMINI_API_KEY`（必填）
   - `MP_ACCESS_TOKEN`：Mercado Pago 开发者后台 → 你的应用 → 生产凭证的 Access Token（测试用 TEST- 开头的）
   - `MP_WEBHOOK_SECRET`（建议）：Mercado Pago → Webhooks 的签名密钥
   - `OWNER_EMAILS`：你自己的邮箱（不限额度）
   - 可选：`PRO_PRICE`（默认 19.90）、`PLAN_FREE_AI`（20）、`PLAN_PRO_AI`（500）、`PUSH_SUBJECT`（mailto:你的邮箱）
4. **Mercado Pago 通知**：Webhooks → 网址填 `<函数网址>/billing/webhook`，事件勾选「Planos e assinaturas」（subscription_preapproval、subscription_authorized_payment）。
5. **网站配置**：把 `public/zq-config.example.json` 复制为网站根目录的 `zq-config.json`，填 Project URL、publishable key、函数名。用户打开网页就能直接登录，不需要任何配置。
6. **定时推送**：自己登录并开启一次推送后，在 SQL Editor 运行 `supabase/push-cron.sql`（开启 pg_cron / pg_net，每天 12:00 UTC 调用函数）。
7. **上线前**：准备隐私政策和服务条款（LGPD：说明单据图片会发送给 AI 识别、数据存储位置）；Gemini 请开启付费层（免费层提交的内容可能被用于改进产品）。

函数路由（同一个函数）：`POST /` 识别、`GET /health`、`GET /me`、`POST /billing/checkout|cancel|webhook`、`GET /push/key`、`POST /push/subscribe|unsubscribe|test|cron`。

## AI 识别：Supabase + Gemini（上线推荐，只做一次）

> 第八轮起识别函数也负责账号、订阅和推送，AI 识别默认需要登录账号（见上一节）；只给自己用可设 Secret `ALLOW_KEY_ONLY=1`。

识别函数部署在**你同步用的同一个 Supabase 项目**里，App 用同步配置里的 Project URL + publishable key 自动调用，不用再填地址和口令；别的设备导入同步配置后也自动可用。模型密钥只存在 Supabase Secrets，浏览器里没有。

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key**，复制。
2. Supabase 控制台 → 项目 → **Edge Functions → Secrets** → 添加 `GEMINI_API_KEY`。
3. **Edge Functions → Deploy a new function → Via Editor**，函数名填 `recognize`，粘贴 `supabase/functions/recognize/index.ts`（也可在应用「设置 → AI 识别与隐私」点「复制识别函数代码」）→ **Deploy function**。
   控制台里函数网址（`/functions/v1/` 后面那段）就是函数名；如果不是 `recognize`（例如 `quick-api`），在应用「设置 → 识别函数名」填它或直接粘贴整个网址即可（会随同步到别的设备）。
4. 打开该函数的 **Settings**，关闭 **Verify JWT**（新版 publishable key 不是 JWT；函数自己校验 `apikey` 头必须是本项目的 publishable / anon key）。
5. 应用「设置 → AI 识别与隐私」点「保存并检查」，显示「AI 识别 · Gemini 可用」即完成。

CLI 方式：

```bash
supabase secrets set GEMINI_API_KEY=你的密钥
supabase functions deploy recognize --no-verify-jwt
```

可选 Secrets：`GEMINI_MODEL`（默认 `gemini-3.8-flash`）、`GEMINI_FALLBACK_MODELS`（主模型繁忙/不可用/额度用完时先改用这些，逗号分隔；之后还会自动查这个密钥实际可用的 Flash 模型，最多共试 4 个）、`GEMINI_THINKING`（默认 low；medium / high / off）、`RECOGNIZE_BUDGET_MS`（整次识别时间预算，默认 120000）、`ANTHROPIC_API_KEY` + `AI_PROVIDER=anthropic`（改用 Claude）、`ACCESS_TOKEN`（额外口令）、`ALLOWED_ORIGINS`（默认 `*`，由 key 把关）、`RATE_PER_MIN`。

Gemini 返回 503「模型繁忙」时函数会自动重试，并自动换成这个密钥可用的其他 Flash 模型（日志里会列出可用模型和实际使用的模型）；失败原因（不含票据内容）写在 Supabase 函数的 **Logs** 里。

隐私：Gemini 免费额度下提交的内容可能被 Google 用于改进产品并由人工审阅；工资单、银行单据含个人信息，建议在 AI Studio 为该密钥开启结算（付费层）。

识别页的通道顺序：AI 识别（Supabase）→ Claude（在 Claude App 里打开时）→ 自建服务 → 本机 OCR；不可用的 Claude / 自建服务不再显示。PDF 有文字层时仍优先直接读 PDF（不上传）。

## 全面检查与优化（第七轮）

| 范围 | 修复 / 优化 |
|---|---|
| 付款 | 记付款、标已付后都能「撤销」；0 元付款不再记录；改总额时保留原付款凭证；取消「已付款」会清空多笔付款记录，现在先确认；恢复未付时同时删掉凭证照片 |
| 付款码 | 复制后回到本应用会提示「标记已付」；PIX 按原文复制（含空格），boleto 只复制数字 |
| 批量操作 | 批量顺延的撤销只还原没被再次改过的账单；删除账单的撤销不会恢复已删的凭证照片引用 |
| 同步 | 两台设备同时改同一笔账单时，旧版本不会覆盖新版本；设置按项合并（本机未同步的改动保留），提醒去重记录不再被覆盖；增量游标留出时钟误差余量 |
| 备份 | 导入时校验付款记录（金额 ≥ 0、日期合法）；可恢复设置（提醒天数、预算、默认商家/账号、识别服务地址等） |
| 重复 / 分期 | 编辑重复账单不改到期日时保留原对齐日（如每月 31 号）；分期生成的各期不再继承重复规则和付款记录 |
| 表格导入 | 表头匹配改为精确优先、再取最长别名，避免「Pagamento」误判为账号列；两位年份只接受前后一年内 |
| 识别 / 复核 | PDF 已读出文字时，AI 识别默认折叠，主按钮就是「直接用 PDF 内容生成账单」；复核页显示「识别名称」；仅填总额时不再提示「按明细重算」；复核时也能直接勾选已付款；缴费类型选好后收起为一个小标签（可「更改」） |
| 无障碍 / 稳定 | 弹窗叠放时 Esc 只关最上层，焦点进入弹窗并在内循环；下拉选择支持读屏；日历可用方向键选日；扫码关闭后摄像头立即释放；凭证与对账单预览图用完即释放内存 |
| 列表 | 从商家资料跳到账单时打开「全部」标签，已付账单也能看到 |

## 第三轮更新：界面整理、重复周期、云同步

| 功能 | 说明 |
|---|---|
| 首页重排 | 顶部只有一张紧凑概览卡：待付总额、已逾期 / 7 天内 / 本月未付，以及本月账期总额进度条（点开进入月历）；下面三个常用按钮；然后是待处理卡片（最多 4 张，可切换按日期 / 按商家）。去掉了重复的「下一笔」「7 天内卡片」「提醒横幅」「货款/缴费分栏」 |
| 账单页重排 | 搜索框 + 「筛选」按钮（类型 / 缴费分类 / 到期时间 / 排序都收进抽屉，启用的条件显示为可一键取消的小标签）；状态标签页 未付 / 逾期 / 即将到期 / 待确认 / 已付 / 全部；视图 按日期 / 按商家 / 月历 |
| 卡片归类 | 账单以卡片显示，卡片内是列表；可切换「按日期」（已逾期 / 7 天内 / 本月稍后 / 以后，最多 4 张）或「按商家」（同商家账单放一张卡，最急的商家在前，合计只算未付）；月历按周分卡。每张卡默认显示前几笔，可展开。每行右侧圆形按钮一键标记已付，点开是详情（明细、付款码、编辑、复制、导出日历、删除、立即生成下一期） |
| 重复周期 | 每周 / 每 2 周 / 每月 / 每 2 个月 / 每季度 / 每半年 / 每年 / 自定义（每 N 天·周·月·年），可设结束日期；缴费单位可设默认重复周期；月、年周期按原日期对齐（31 号遇到小月取月末） |
| 云同步 | 与「进货价格本」同样的方式：填 Supabase Project URL + publishable key，自动生成同步空间名和口令；立即同步 / 上传改动 / 下载合并 / 改动后自动同步 / 强制全量上传 / 复制配置到别的设备（另一台粘贴即可）。顶栏显示同步状态 |
| 修复 | 旧记录时间在"未来"（别的设备时钟偏快、导入的备份）时，本地修改和删除会输给旧版本——现在本地写入保证时间单调递增；详情菜单操作后自动收起；手机上点问题会跳到可见的明细输入框；按商家汇总同名商家不再冲突；付款后提示改为「已生成下一期」 |

## 识别增强：多种单据、PDF、校验

| 单据 | 识别后自动填写 |
|---|---|
| 手写/打印订单 | 明细（支持「箱数 × 每箱件数 × 单价」写法，数量按总件数）、总额冲突提示、两位年份离今年太远时可一键「按今年」 |
| Boleto 银行单 | 收款方、单号、金额、到期日、数字线、分项（如房租 + 物业），按内容判断分类（房租、会计等） |
| 水电网账单 | 公司、总额、到期日、参考月份、PIX 复制码，分类自动设为水费/电费/燃气/网络 |
| 税费 / FGTS / DAS | 税种、金额、到期日、PIX 复制码 |
| 工资单 | 员工、实发金额（Líquido a receber），到期日按次月第 5 个工作日建议 |
| 对账单（如供应商 Excel 截图） | 进入批量导入页：多笔欠款一次导入，按付款记录标已付、按商家账期算到期日、核对「结欠」，并把表头上的客户编号记为商家别名 |

**校验优先**：数字线（47/48 位）会验证每段校验位和总校验位，从中读出的金额和到期日（含 2025-02-22 起新的到期因子规则）优先于"看图读数"；PIX 复制码校验 CRC。与票面读数不一致时只警告、不悄悄改；校验不通过的数字线不会被采用。安卓 Chrome 还会用浏览器扫码直接读取照片里的条码 / 二维码。

**PDF**：可以直接上传 PDF（银行 Boleto、FGTS 等电子单据）。应用读取 PDF 文字层，不用 AI、不上传就能生成账单；也可以用 AI 识别整页。

## 扫码、节假日、付款凭证与修复

| 功能 | 说明 |
|---|---|
| 扫码填付款码 | 编辑页付款码旁的扫码按钮：扫 Boleto 条码或 PIX 二维码（也可从相册选图）。44 位条码会先校验，再自动转成银行 App 可输入的数字线（银行 47 位 / 水电税 48 位），扫错会提示重扫。需要浏览器支持扫码（安卓 Chrome 支持；iPhone Safari 暂不支持，按钮不显示） |
| 周末 / 节假日提示 | 到期日落在周六、周日或巴西全国节假日（含狂欢节、耶稣受难日、基督圣体节等移动节日）时，提示银行顺延到哪天，可一键改为下一个工作日；日历上节日标红点 |
| 付款凭证照片 | 「记一笔付款」时可附 PIX 回单 / 转账截图（自动压缩），付款记录旁可查看；只存本机，不同步 |
| 批量顺延 | 账单页多选 →「顺延」+3 / 7 / 15 / 30 天，可撤销 |
| 删除可撤销 | 删除账单后提示条上可立即撤销 |
| 修复 | 编辑并保存分次付款中的账单会丢失付款记录；重复账单生成下一期时继承了上一期的付款记录（导致新一期显示已付）；叠加的弹窗按 Esc 会一起关闭；表格导入不认英文格式金额（1234.56、1,234.56）；通知、账单摘要文字改为显示还差多少；备份恢复时校验付款记录 |

## 批量导入、防重复、预算与快捷键

| 功能 | 说明 |
|---|---|
| 表格批量导入 | 「设置 → 数据管理 → 从表格批量导入账单」：粘贴 Excel/Google 表格内容或选 .csv；自动识别中文/葡文表头（商家、单号、开单、到期、金额、账号、分类、备注），列对应可手动改；缺到期日时按商家固定账期自动计算；重复行标记跳过、错误行写明原因；可一键新建缺失的商家；附模板下载 |
| 防重复录入 | 手工保存时若已有同商家同单号（或同商家 + 同到期日 + 同金额）的账单，会先提示确认 |
| 每月预算 | 「设置」里填每月支出预算，「流水」页显示本月实付进度，接近或超出会变色提醒 |
| 未付清单 | 「资料」里点商家 →「复制未付清单」，生成可直接发 WhatsApp 的对账文字（到期日、单号、已付部分、合计） |
| 电脑快捷键 | N 新增账单 · / 搜索 · G 首页 · L 账单 · F 流水 · Esc 关闭弹窗（设置页有说明） |

## 分次付款、现金流预测与商家对账

| 功能 | 说明 |
|---|---|
| 分次付款 | 账单详情「记一笔付款」可只付一部分（有全部/一半/30% 快捷键），列表和汇总自动按「还差多少」计算，并显示已付百分比；付清时自动标记已付并生成下一期；每条付款记录可单独删除 |
| 现金流预测 | 流水页「接下来要付」：已逾期 / 未来 7 天 / 未来 30 天，以及未来 6 周每周要付多少（都按还差多少算） |
| 商家对账 | 「资料」页点商家/缴费单位：还要付、累计已付（含近 12 个月）、账单数、平均账期、按时付清率、平均开单后几天付清、下一笔到期，以及最近 5 笔账单 |
| 日历同步 | 未付清的账单导出到日历时写的是尾款金额，并注明已付多少 |

## 每月流水

底部导航新增「流水」（「资料」移到「设置 → 固定资料」，电脑侧栏仍直接显示）：

- 按**实际付款日期**（圣保罗时间）统计每月实付，拆成商家货款 / 日常缴费；和上月比较（当月未过完时与上月同期比较）。
- 本月新开账期金额、本月到期笔数与按时付清笔数。
- 近 12 个月付款柱状图（货款/缴费分色，虚线为月均），点柱子切换月份，悬停看明细。
- 「钱付给了谁」：按商家 / 分类 / 付款账号汇总并显示占比，点商家直接查看其账单。
- 流水明细按付款日分组；可导出当月 CSV（分号分隔、巴西格式金额，Excel 直接打开）。

## 第五轮：精简、外观切换与体验细节

- 配色保持原来的深紫主题；新增「光明 / 深色 / 跟随系统」外观：顶栏右上角一键切换，「设置 → 外观」可选跟随系统，每台设备各自记住。
- 去掉重复内容：顶栏提醒铃（底部「账单」已有逾期角标）、账单页重复的笔数、「即将到期」标签页、首页通知提示、编辑页和设置页的多余说明；「提醒」与「日历」合并为一个区块。
- 体验：从详情/编辑返回账单页时保留搜索、标签、视图，并回到原来的滚动位置；点商家卡片标题或首页商家图例直接查看该商家全部账单；一键付款有按压反馈和震动。

## 第四轮：颜色区分与首页重排

| 功能 | 说明 |
|---|---|
| 首页只看本月 | 顶部「N月还要付」：本月到期未付 + 之前逾期未付；本月账期总额与已付进度；「本月各商家账期」分色条 + 图例（前 4 家，其余并入"其他"） |
| 本月待付卡片 | 只列本月要付的账单，可按日期（已逾期=红、7 天内=橙、本月稍后=蓝）或按商家（商家识别色）归类 |
| 全部待付 | 单独区块：已逾期 / 本月内 / 下月 / 更晚 分色条，点图例进入对应列表 |
| 商家识别色 | 7 种颜色（已做色盲区分校验，红色留给逾期），新建商家自动分配用得最少的颜色，可在「资料」里改；首页、账单卡片、资料列表统一使用 |
| 商家卡片 | 圆形彩色头像 + 名称 + 笔数小圆标（有逾期时显示「逾期 N」）；卡内每笔左侧是到期日方块，标题写距离到期多久，下面写开单日与单号，不再重复商家名和到期日 |
| 其他颜色 | 快捷按钮分色（拍照紫、商家账单蓝、日常缴费青绿）；账单页标签计数按状态上色 |

## 云同步（Supabase）

1. 打开 [Supabase 控制台](https://supabase.com/dashboard)，进入项目（可以和价格本共用一个项目，表名以 `zq_` 开头，互不影响）。
2. **SQL Editor → New query**，粘贴 `supabase/setup.sql`（应用「设置 → 云同步 → 复制建表脚本」也能复制），点 Run。脚本可以重复运行。
3. **Project Settings → API Keys**，把 Project URL 和 publishable key（旧项目叫 anon public key）填进应用「设置 → 云同步」，点「测试连接并开始同步」。
4. 其他设备：在第一台设备点「复制配置到别的设备」，发给自己，在另一台设备的同一位置粘贴导入。

同步规则：

- 数据先存本机（IndexedDB），离线照常使用；联网后自动同步。打开应用、回到前台、恢复联网、每 3 分钟会下载合并；本机改动 2 秒后自动上传。
- 同一笔记录以更新时间较新的为准；删除以"墓碑"同步，另一台设备也会删除。
- 只同步账单、商家/缴费单位、付款账号和提醒设置（默认提前天数、即将到期范围、默认商家/账号）。**票据照片不上传**，只留在拍摄的设备上。示例数据不上传。
- 安全：`zq_records` 表开启 RLS 且不对外开放，只能通过 `zq_status / zq_pull / zq_push` 三个函数读写，而且必须带同步口令（云端只保存口令的 SHA-256）。仅凭 URL 和 publishable key 读不到账单。复制出的配置包含口令，只发给自己的设备。
- Claude 页面版禁止连接外部网站，云同步请在 GitHub Pages 版使用。

## 第二轮新增功能

| 功能 | 说明 |
|---|---|
| 账期复制 | 账单详情 → 复制为新账单；可「从今天起算同样账期」或「原日期顺延 1 个月」；保存后提示「再复制一笔」 |
| 日历选择 | 所有日期都可点日历图标选择，格子里显示当天已有的未付金额，方便错开付款日；输入 8 位数字自动补斜杠 |
| 本月账期总额 | 首页概览卡显示本月账期总额与已付进度；账单页「月历」视图可切换月份，看每天到期金额 |
| 应用内相机 | 实时取景框、闪光灯、前后摄像头切换、拍后预览；取景框自动作为默认裁切；「一键识别」直接跑完裁切→识别 |
| 仅填总金额 | 明细可切换为「仅填总金额」，保存为一行整单金额，可随时切回 |
| 商家固定账期 | 资料页给商家设置：开单后 N 天 / 每月固定日（可设截单日）/ 分期 30/60/90；选商家后自动算到期日，分期自动拆成多笔（按分精确拆分） |
| 日常缴费 | 水费、电费、燃气、网络、房租、物业、税费、工资社保、会计、运费、平台费用、贷款、订阅等分类；缴费单位可设默认分类与固定缴费日；每月重复账单在付款后自动生成下月（金额标为「待确认」） |
| 付款码 | 每笔账单可存 Boleto 条码或 PIX 复制码，卡片上一键复制；付款账号的 PIX 也可一键复制 |
| 批量操作 | 账单页「多选」→ 批量标记已付 / 导出日历 |
| 补录已付 | 新增或编辑时可勾选「已付款」并选择付款日期 |
| AI 识别开启 | 设置页填服务地址 + 访问口令并测试连接；内置 Cloudflare Worker 部署步骤与「复制 Worker 代码」按钮 |

## Cloudflare Worker 识别服务（备选）

`npm run build:worker` 生成 `worker/dist/zhangqi-worker.js`（单文件，已内嵌提示词），也可以直接在应用「设置 → 票据识别」里点「复制 Worker 代码」。

1. Cloudflare 控制台 → Workers & Pages → Create → Hello World → Deploy → Edit code，粘贴代码并 Deploy。
2. Settings → Variables and Secrets：`GEMINI_API_KEY` 或 `ANTHROPIC_API_KEY`（Secret）、`ACCESS_TOKEN`（Secret，自定口令）、`ALLOWED_ORIGINS`（如 `https://你的用户名.github.io`），可选 `ANTHROPIC_MODEL`（默认 `claude-sonnet-5`）。
3. 应用「设置 → 票据识别」填 Worker 网址与口令，点「保存并测试连接」。

或用 CLI：`cd worker && npx wrangler deploy && npx wrangler secret put ANTHROPIC_API_KEY && npx wrangler secret put ACCESS_TOKEN`。

Node 服务（`server/index.mjs`）与 Worker 共用 `server/core.mjs`，同样支持 `ACCESS_TOKEN`。

## 部署到 GitHub Pages

**方式 A：直接上传（不需要任何命令）**
1. GitHub 新建仓库，例如 `zhangqi`（Public）。
2. 解压 `账期助手-GitHub-Pages.zip`，在仓库页面 *Add file → Upload files*，把里面的**全部文件和 assets 文件夹**拖进去（包括 `.nojekyll`），提交。
3. *Settings → Pages → Build and deployment*：Source 选 *Deploy from a branch*，Branch 选 `main` / `(root)`，保存。
4. 1–2 分钟后打开 `https://你的用户名.github.io/zhangqi/`。手机上用 Safari「分享 → 添加到主屏幕」或 Chrome「安装应用」。

也可以放进已有仓库的子文件夹（如 `zhangqi/`），所有路径都是相对路径。

**方式 B：推送源码，自动构建**
把整个源码推到仓库的 `main` 分支，*Settings → Pages* 的 Source 选 *GitHub Actions*。
`.github/workflows/deploy.yml` 会自动 `npm ci → npm test → npm run build` 并发布；测试不通过不会发布。

**注意**
- 数据先存在各自设备的浏览器里，按网址区分。要在手机和电脑之间共用，开启「设置 → 云同步」（见上文）；不想用云端时，用「数据管理」导出/导入备份。
- GitHub Pages 只托管静态页面，没有识别服务。需要 AI 识别时，把 `server/` 部署到任意 Node 主机（Render、Railway、自己的 VPS 等），设置 `ALLOWED_ORIGINS=https://你的用户名.github.io`，再在应用「设置 → 云端识别服务地址」填 `https://你的服务域名/api/recognize`。
- 更新版本后，已安装的 PWA 会在下次联网打开时取到新页面（页面走网络优先）。

## 技术栈

TypeScript · React 18 · Vite · IndexedDB（`idb` 封装）· Vitest · 零依赖 Node 识别服务 · 可选 tesseract.js 本地 OCR。

## 目录

```
src/lib/money.ts        金额解析/格式化（整数分，巴西格式，歧义检测，舍入规则）
src/lib/dates.ts        日期校验、两位年份确认、圣保罗"今天"
src/lib/status.ts       open / dueSoon / overdue / paid 计算、提醒窗口、通知签名
src/lib/ics.ts          ICS 生成（稳定 UID、转义、75 字节折行、提前闹钟）
src/lib/bill.ts         账单校验、重算、schema 迁移
src/lib/backup.ts       备份导出、导入校验、合并预览（新增/更新/冲突/相同）
src/lib/terms.ts        商家固定账期规则、分期拆分
src/lib/expense.ts      日常缴费分类、付款码识别
src/lib/recurrence.ts   重复周期（每 N 天/周/月/年、结束日期、生成下一期）
src/lib/groups.ts       账单列表分组（按紧急程度 / 付款月份 / 到期日）
src/lib/monthly.ts      月度统计、每日到期汇总
src/lib/ocr/protocol.ts 模型输出协议规范化、复核问题计算、保存门槛
src/lib/ocr/rows.ts     本地 OCR 词框 → 行重建 → 明细
src/lib/ocr/providers.ts 识别通道：Claude / 自建服务 / 本机 OCR
src/lib/image/*         四角裁切校验、单应矩阵透视矫正、灰度/自适应二值化/蓝线抑制
src/db/repo.ts          Repository 接口与 IndexedDB 实现（墓碑删除、本地时间单调、同步标记）
src/sync/engine.ts      Supabase 同步引擎（增量游标、上传改动、下载合并、配置分享）
supabase/setup.sql      Supabase 建表脚本（RLS + 口令校验函数）
src/ui/BillList.tsx     分组行列表 + 详情抽屉
src/pages/*             仪表盘、账单、新增/编辑/复核、拍照识别、固定资料、提醒设置、数据管理
server/core.mjs         识别服务核心（Web 标准 API，Node 与 Worker 共用）
server/index.mjs        Node 识别服务（密钥仅在服务器环境变量）
worker/                 Cloudflare Worker 入口、wrangler.toml、打包产物 dist/zhangqi-worker.js
shared/recognize-prompt.txt  前后端共用的视觉模型提示词
public/sw.js            离线应用壳 + 通知显示 + 第二阶段 push 入口
```

## 数据结构

`Bill`、`Item`、`Merchant`、`PaymentAccount`、`Settings` 定义见 `src/lib/types.ts`，字段与需求文档一致：

- 金额全部为整数分；`totalCents` 每次保存都由有效明细重新计算，不采信图片总额。
- 小计 = 数量（按千分位整数）× 单价，结果四舍五入到分（0.5 分进位）。
- `status` 不存储，由 `paidAt` 和圣保罗当天日期计算。
- 新增可选字段（无需迁移，旧数据视为默认值）：Bill `kind`（supplier/expense）、`category`、`amountMode`（items/total）、`paymentCode`、`recurrence`、`estimated`、`installment`；Merchant `type`（supplier/payee）、`term`（固定账期规则）、`defaultCategory`、`recurring`。
- 分期：`buildInstallmentBills()` 把总额按整数分均分，余数放第一期；每期是独立账单（独立提醒/付款），`installment.groupId` 关联同一原单。
- 账单保存 `merchantNameSnapshot` / `accountLabelSnapshot`，停用或改名不影响历史。
- `ocrReview` 记录识别通道、原始返回、候选、警告、已核对项、人工修改（原值→新值）、确认时间和图片 id。
- 删除采用墓碑（`deletedAt` + `updatedAt`），第二阶段同步可直接复用。
- IndexedDB 版本 `DB_VERSION`，升级在 `upgrade()` 中逐级执行；账单读取时经过 `migrateBill()`；更高版本数据会拒绝而不是清空。

## 识别服务接口

`GET /api/health` → `{ ok, configured, provider, model, auth, tokenOk }`（请求头 `x-access-token` 或 `apikey` 可选）

Supabase 函数路径：`/functions/v1/recognize`（识别）与 `/functions/v1/recognize/health`（状态），请求头 `apikey: <publishable key>`。

`POST /api/recognize`
请求：`{ "mediaType": "image/jpeg|image/png|image/webp", "imageBase64": "..." }`（默认上限 6 MB）
响应：`{ "result": <协议 JSON>, "rawText": "...", "model": "..." }`
请求头：设置了 `ACCESS_TOKEN`（可逗号分隔多个）时必须带 `x-access-token` 或 `apikey`，否则 401（错误次数过多会限流）。
错误：`{ "error": "中文说明" }`，状态码 400/401/413/415/429/502/503/504。

协议 JSON 见需求文档第七节，额外支持每行可选 `bbox: [x,y,w,h]`（0–1 归一化），用于在原图上高亮。前端 `normalizeModelOutput()` 会再次校验类型、范围、日期与金额，原文和数值矛盾时两者都不采信。

环境变量见 `.env.example`：`GEMINI_API_KEY`、`GEMINI_MODEL`、`GEMINI_THINKING`、`ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`AI_PROVIDER`、`ACCESS_TOKEN`、`PORT`、`ALLOWED_ORIGINS`、`MAX_IMAGE_BYTES`、`RECOGNIZE_TIMEOUT_MS`、`RATE_PER_MIN`。

## 四种识别方式

| 方式 | 何时可用 | 图片去向 | 费用 |
|---|---|---|---|
| AI 识别（Supabase 函数） | 连接了云同步并部署了 recognize 函数 | 发到你的 Supabase 函数，再到 Gemini / Claude | Gemini 有免费额度，超出按量 |
| Claude 视觉识别 | 在 Claude 中打开本应用时 | 当前这 1 张图片发给 Claude | 使用你自己的 Claude 账号用量，无需任何密钥 |
| 云端识别服务 | 部署了 Cloudflare Worker 或 `server/` 并配置密钥 | 发到你的服务，再到模型 | 模型 API 用量 |
| 本机 OCR | 任何时候（首次需下载语言包） | 不离开设备 | 免费，手写识别较弱 |

发送图片前一定弹出同意说明（可选择"以后不再询问"，在设置里可撤销）。拒绝时仍可用本机 OCR 或"对照图片手工录入"。

## 已知限制（请务必了解）

- **关屏提醒**：纯本地网页关闭后无法在未来某个时间自行唤醒。第一阶段可靠的关屏提醒是 ICS 日历（每笔账单含提前 N 天 09:00 与当天 09:00 两个闹钟）。Service Worker 只负责显示通知，不会准点唤醒。
- **日历不同步**：导入的日历事件不会随账单变化自动更新；修改或付款后需在日历中更新/删除（重新导出同一账单时 UID 不变，多数日历会覆盖）。
- **在 Claude 中打开时**：浏览器沙箱不允许下载 .ics 文件，会改用系统分享或复制到剪贴板，也可用"添加到 Google 日历"；本机 OCR 的语言包无法下载，请使用 Claude 识别；系统通知是否可用取决于客户端。
- **应用内相机**：需要 https（GitHub Pages 满足）和相机权限；在 Claude App 内嵌打开时通常不能用网页相机，会自动改用系统相机/相册。
- **重复账单**：下一期在本期「标记已付」时生成（也可在详情里「现在生成下一期」），金额沿用本期并标为「待确认」。
- **HEIC**：取决于浏览器解码能力（Safari 通常可以，Chrome 桌面版通常不行），不行时会提示改用 JPG。
- **识别质量**：需求第十五节要求的 30 张已标注真实票据测试集尚未建立，因此**没有宣称识别准确率**。`tests/fixtures/` 只有样例票据 258 的夹具，用于验证协议与复核逻辑，生产代码没有任何针对它的特例。建议下一步收集真实票据按第十五节指标评估。
- **本机 OCR 的行重建**是启发式规则（数量 → 描述 → 单价 → 小计），描述中出现纯数字或行尾不是金额时一律归入"未解析行"。
- 未开启云同步时数据只保存在当前浏览器，清理网站数据会丢失。建议开启云同步，或定期在「数据管理」导出备份。
- **云同步冲突**：同一笔账单在两台设备离线时都改了，以后改的那次为准（整条记录覆盖，不做字段级合并）。

## 第二阶段建议

1. 云同步已完成（Supabase，口令空间）。后续可改为 Supabase Auth 账号登录，并做字段级冲突提示。
2. Web Push：保存订阅 → 服务端定时任务每天圣保罗 09:00 计算进入提醒期的账单 → 以"日期|账单|到期日|状态"为幂等键发送 → 失败重试、退订清理。`public/sw.js` 已有 `push` 与 `notificationclick` 处理。
3. 图片云端存储（用户明确同意后），识别服务增加鉴权与按用户限流。
4. 建立 30+ 张标注测试集，按金额字段 ≥95%、型号 ≥90%、明细行完整率、零编造四项指标出报告。
=======
# ZHANGQIZHUSHOU
>>>>>>> 9a54f0f3cb16a9601adeae979d3ea5400189a650
