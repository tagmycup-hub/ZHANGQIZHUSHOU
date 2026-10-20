/**
 * 极简 PostgREST 模拟（测试用）：在 PGlite 上执行 /rest/v1/<表> 与 /rest/v1/rpc/<函数>。
 * 只支持本项目用到的语法：?col=eq.v / in.(a,b) / select=、POST（prefer resolution=merge-duplicates|ignore-duplicates）、PATCH、DELETE。
 * role：'service'（secret key）或 'user'（登录用户，设置 request.jwt.claim.sub）或 'anon'。
 */
const PK = { zq_kv: ['key'], zq_profiles: ['user_id'], zq_usage: ['user_id', 'month'], zq_push_subs: ['endpoint'], zq_push_log: ['key'] };

function filters(params) {
  const where = [];
  const vals = [];
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'limit') continue;
    if (v.startsWith('eq.')) {
      vals.push(v.slice(3));
      where.push(`"${k}" = $${vals.length}`);
    } else if (v.startsWith('in.(')) {
      const items = v.slice(4, -1).split(',');
      where.push(`"${k}" in (${items.map((it) => (vals.push(it), `$${vals.length}`)).join(',')})`);
    } else if (v === 'is.null') where.push(`"${k}" is null`);
    else if (v === 'not.is.null') where.push(`"${k}" is not null`);
    else throw new Error(`unsupported filter ${k}=${v}`);
  }
  return { where: where.length ? `where ${where.join(' and ')}` : '', vals };
}

export function createPostgrest(pg) {
  async function asRole(role, sub, fn) {
    await pg.query(`set role ${role === 'service' ? 'service_role' : role === 'user' ? 'authenticated' : 'anon'}`);
    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub || '']);
    try {
      return await fn();
    } finally {
      await pg.query('reset role');
      await pg.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  }

  return async function handle({ method, path, body, role = 'service', sub = null, prefer = '' }) {
    const u = new URL(path, 'http://x');
    const name = u.pathname.replace(/^\/rest\/v1\//, '');
    try {
      return await asRole(role, sub, async () => {
        if (name.startsWith('rpc/')) {
          const fn = name.slice(4);
          const args = body ? JSON.parse(body) : {};
          const names = Object.keys(args);
          const params = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
          const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
          const meta = await pg.query(`select p.proretset, pg_get_function_result(p.oid) as res from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1`, [fn]);
          if (!meta.rows.length) return { status: 404, body: JSON.stringify({ code: 'PGRST202', message: `Could not find the function public.${fn}` }) };
          const { proretset, res } = meta.rows[0];
          if (proretset || /^TABLE/i.test(res)) {
            const r = await pg.query(`select * from ${call}`, params);
            return { status: 200, body: JSON.stringify(r.rows) };
          }
          if (/^void$/i.test(res)) {
            await pg.query(`select ${call}`, params);
            return { status: 200, body: '' };
          }
          const r = await pg.query(`select ${call} as r`, params);
          return { status: 200, body: JSON.stringify(r.rows[0].r) };
        }
        const table = `public."${name}"`;
        const { where, vals } = filters(u.searchParams);
        if (method === 'GET') {
          const cols = u.searchParams.get('select') && u.searchParams.get('select') !== '*' ? u.searchParams.get('select').split(',').map((c) => `"${c}"`).join(',') : '*';
          const r = await pg.query(`select ${cols} from ${table} ${where}`, vals);
          return { status: 200, body: JSON.stringify(r.rows) };
        }
        if (method === 'POST') {
          const rows = [].concat(JSON.parse(body));
          for (const row of rows) {
            const cols = Object.keys(row);
            const pk = PK[name] ?? ['id'];
            const conflict = /ignore-duplicates/.test(prefer) ? `on conflict (${pk.map((c) => `"${c}"`).join(',')}) do nothing` : /merge-duplicates/.test(prefer) ? `on conflict (${pk.map((c) => `"${c}"`).join(',')}) do update set ${cols.filter((c) => !pk.includes(c)).map((c) => `"${c}" = excluded."${c}"`).join(', ') || `"${pk[0]}" = excluded."${pk[0]}"`}` : '';
            await pg.query(
              `insert into ${table} (${cols.map((c) => `"${c}"`).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) ${conflict}`,
              cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])),
            );
          }
          return { status: 201, body: '' };
        }
        if (method === 'PATCH') {
          const patch = JSON.parse(body);
          const cols = Object.keys(patch);
          const off = vals.length;
          await pg.query(`update ${table} set ${cols.map((c, i) => `"${c}" = $${off + i + 1}`).join(', ')} ${where}`, [...vals, ...cols.map((c) => patch[c])]);
          return { status: 204, body: '' };
        }
        if (method === 'DELETE') {
          await pg.query(`delete from ${table} ${where}`, vals);
          return { status: 204, body: '' };
        }
        return { status: 405, body: '' };
      });
    } catch (e) {
      return { status: 400, body: JSON.stringify({ code: 'P0001', message: e.message }) };
    }
  };
}
