/**
 * 套餐与权限（前端与服务端共用，唯一来源）
 *  - 试用：注册后 30 天，基础功能全开 + AI 识别共 5 次
 *  - T1：R$ 7,99/月 或 R$ 89,99/年 —— 基础功能 + 关屏推送 + AI 识别 20 次/月
 *  - T2：R$ 19,98/月 或 R$ 199,99/年 —— T1 全部 + 导出记录（CSV/Excel）+ AI 识别 50 次/月
 *  - 试用结束且没有订阅：只读（能看账单、标记已付；不能新增、编辑、识别）
 */
export const TRIAL = { days: 30, ai: 5 };
export const PLANS = {
  t1: { name: 'T1', month: 7.99, year: 89.99, ai: 20, push: true, export: false },
  t2: { name: 'T2', month: 19.98, year: 199.99, ai: 50, push: true, export: true },
};
export const PLAN_LABEL = { trial: '试用', t1: 'T1', t2: 'T2', owner: '管理员', expired: '已到期' };

/** 圣保罗时间的年月（AI 月度额度的周期） */
export function monthKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * 根据账号资料算出当前权限。
 * profile: { plan: 't1'|'t2'|'owner'|null, period, plan_until, trial_until }
 */
export function entitlement(profile, { email = '', owners = [], now = new Date(), plans = PLANS, trial = TRIAL } = {}) {
  const t = now.getTime();
  const trialUntil = profile?.trial_until ?? null;
  const planUntil = profile?.plan_until ?? null;
  const rawPlan = profile?.plan === 'pro' ? 't2' : profile?.plan;
  let plan;
  if (profile?.plan === 'owner' || (email && owners.includes(String(email).toLowerCase()))) plan = 'owner';
  else if ((rawPlan === 't1' || rawPlan === 't2') && ms(planUntil) > t) plan = rawPlan;
  else if (ms(trialUntil) > t) plan = 'trial';
  else plan = 'expired';
  const p = plan === 't1' || plan === 't2' ? plans[plan] : null;
  const features = {
    edit: plan !== 'expired',
    push: plan === 'owner' || !!p?.push,
    export: plan === 'owner' || !!p?.export,
  };
  const ai = plan === 'owner' ? { key: monthKey(now), limit: -1 } : p ? { key: monthKey(now), limit: p.ai } : plan === 'trial' ? { key: 'trial', limit: trial.ai } : { key: null, limit: 0 };
  const until = plan === 'trial' ? trialUntil : p ? planUntil : null;
  const daysLeft = until ? Math.max(0, Math.ceil((ms(until) - t) / 86400000)) : null;
  return { plan, period: p ? profile?.period ?? 'month' : null, trialUntil, planUntil, features, ai, daysLeft };
}

export function priceOf(plan, period, plans = PLANS) {
  const p = plans[plan];
  if (!p || (period !== 'month' && period !== 'year')) return null;
  return p[period];
}
