/**
 * Cloudflare Worker 入口。
 * 控制台部署请直接粘贴打包后的 worker/dist/zhangqi-worker.js（已内嵌提示词）。
 */
import prompt from '../shared/recognize-prompt.txt';
import { createHandler } from '../server/core.mjs';

const handle = createHandler({ prompt, log: (m) => console.log(m) });

export default {
  async fetch(request, env) {
    const res = await handle(request, env);
    if (res) return res;
    return new Response('账期助手识别服务运行中。请在应用「设置 → 识别服务」填写：' + new URL('/api/recognize', request.url).href, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
