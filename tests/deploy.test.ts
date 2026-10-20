import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
// @ts-ignore
import { main, parseRef, pagesUrl, DeployError } from '../scripts/deploy.mjs';

describe('一键部署脚本', () => {
  it('解析项目 ref 与 GitHub Pages 网址', () => {
    expect(parseRef('https://uszhvzetcwnegugjlcgi.supabase.co')).toBe('uszhvzetcwnegugjlcgi');
    expect(parseRef('uszhvzetcwnegugjlcgi')).toBe('uszhvzetcwnegugjlcgi');
    expect(parseRef('xx')).toBeNull();
    expect(pagesUrl({ GITHUB_REPOSITORY: 'tagmycup-hub/zhangqi' })).toBe('https://tagmycup-hub.github.io/zhangqi/');
    expect(pagesUrl({ GITHUB_REPOSITORY: 'TagMyCup-Hub/tagmycup-hub.github.io' })).toBe('https://tagmycup-hub.github.io/');
  });
  it('缺少密钥时列出要填哪些', async () => {
    await expect(main({ env: {}, log: () => {} })).rejects.toThrow(/SUPABASE_ACCESS_TOKEN[\s\S]*SUPABASE_PROJECT_REF[\s\S]*GEMINI_API_KEY/);
  });
  it('完整流程：建表、登录设置、部署函数、密钥、定时推送、写网站配置（SQL 在真实数据库上可重复运行）', async () => {
    const pg = new PGlite();
    await pg.exec(readFileSync('tests/support/pg-auth.sql', 'utf8'));
    // 定时推送需要的扩展在 PGlite 里没有：模拟 cron/net
    await pg.exec(`create schema cron; create table cron.job(jobid serial, jobname text); create function cron.schedule(n text, s text, c text) returns int language sql as $$ insert into cron.job(jobname) values (n) returning jobid $$; create function cron.unschedule(id int) returns bool language sql as $$ delete from cron.job where jobid = id returning true $$;`);
    const root = mkdtempSync(path.join(tmpdir(), 'zq-deploy-'));
    mkdirSync(path.join(root, 'supabase'));
    cpSync('supabase/setup.sql', path.join(root, 'supabase/setup.sql'));
    cpSync('supabase/push-cron.sql', path.join(root, 'supabase/push-cron.sql'));
    const calls: { method: string; path: string; body: any }[] = [];
    const runs: string[][] = [];
    const fetchImpl = async (url: string, init: any) => {
      const p = url.replace('https://api.supabase.com/v1', '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: p, body });
      expect(init.headers.authorization).toBe('Bearer sbp_test');
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (p === '/projects/abcdefghijklmnopqrst') return j({ name: 'zq', status: 'ACTIVE_HEALTHY' });
      if (p.endsWith('/database/query')) {
        await pg.exec(body.query.replace(/create extension[^;]*;/g, ''));
        return j([]);
      }
      if (p.includes('/api-keys')) return j([{ name: 'anon', type: 'legacy', api_key: 'eyJlegacy' }, { name: 'default', type: 'publishable', api_key: 'sb_publishable_xyz' }]);
      return j({});
    };
    const env = { SUPABASE_ACCESS_TOKEN: 'sbp_test', SUPABASE_PROJECT_REF: 'https://abcdefghijklmnopqrst.supabase.co', GEMINI_API_KEY: 'g', OWNER_EMAILS: 'me@x.com', GITHUB_REPOSITORY: 'tagmycup-hub/zhangqi' };
    const run = async (_c: string, args: string[]) => {
      runs.push(args);
      if (args.includes('--use-api')) throw new Error('old cli');
      return '';
    };
    const out = await main({ env, fetchImpl, run, root, log: () => {} });
    // 再跑一次：全部可重复执行
    await main({ env, fetchImpl, run, root, log: () => {} });
    expect(out.config).toEqual({ supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_xyz', functionName: 'recognize' });
    expect(JSON.parse(readFileSync(path.join(root, 'dist/zq-config.json'), 'utf8'))).toEqual(out.config);
    expect(calls.find((c) => c.path.endsWith('/config/auth'))!.body).toMatchObject({ mailer_autoconfirm: true, site_url: 'https://tagmycup-hub.github.io/zhangqi/' });
    expect(calls.find((c) => c.path.endsWith('/secrets'))!.body).toEqual([{ name: 'GEMINI_API_KEY', value: 'g' }, { name: 'OWNER_EMAILS', value: 'me@x.com' }]);
    expect(runs[0]).toEqual(['functions', 'deploy', 'recognize', '--project-ref', 'abcdefghijklmnopqrst', '--no-verify-jwt', '--use-api']);
    expect(runs[1]).not.toContain('--use-api');
    expect((await pg.query(`select value from zq_kv where key = 'fn_url'`)).rows[0]).toEqual({ value: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/recognize' });
    expect((await pg.query(`select count(*)::int as n from cron.job where jobname = 'zq-daily-push'`)).rows[0]).toEqual({ n: 1 });
  });
  it('令牌无效给出中文说明', async () => {
    const env = { SUPABASE_ACCESS_TOKEN: 'bad', SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', GEMINI_API_KEY: 'g' };
    const e = await main({ env, fetchImpl: async () => new Response('{}', { status: 401 }), run: async () => '', root: '.', log: () => {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DeployError);
    expect((e as Error).message).toMatch(/重新生成/);
  });
});
