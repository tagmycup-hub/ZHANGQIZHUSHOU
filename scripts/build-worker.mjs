// 打包识别服务为单文件：
//  - Cloudflare Worker（worker/dist/zhangqi-worker.js，可直接粘贴到 Cloudflare 控制台）
//  - Supabase Edge Function（supabase/functions/recognize/index.ts，可直接粘贴到 Supabase 函数编辑器）
import { build } from 'esbuild';
const common = { bundle: true, format: 'esm', target: 'es2022', loader: { '.txt': 'text' }, charset: 'utf8', logLevel: 'info' };
await build({
  ...common,
  entryPoints: ['worker/entry.mjs'],
  outfile: 'worker/dist/zhangqi-worker.js',
  banner: { js: '// 账期助手识别服务 · Cloudflare Worker（由 npm run build:worker 生成，请勿手改）' },
});
await build({
  ...common,
  entryPoints: ['supabase/entry.mjs'],
  outfile: 'supabase/functions/recognize/index.ts',
  banner: { js: '// @ts-nocheck\n// 账期助手识别服务 · Supabase Edge Function（由 npm run build:worker 生成，请勿手改）\n// 需要的 Secret：GEMINI_API_KEY（或 ANTHROPIC_API_KEY）。函数设置里关闭 Verify JWT。' },
});
