import type { Bill, Merchant, PaymentAccount, Settings } from './types';
import { SCHEMA_VERSION } from './types';
import { migrateBill, validateBill, recompute } from './bill';
import { isValidISO } from './dates';

export const BACKUP_FORMAT = 'zhangqi-zhushou-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  bills: Bill[];
  merchants: Merchant[];
  accounts: PaymentAccount[];
  settings?: Partial<Settings>;
}

export interface DataSet {
  bills: Bill[];
  merchants: Merchant[];
  accounts: PaymentAccount[];
}

export function makeBackup(data: DataSet, settings: Settings | null, now = new Date()): BackupFile {
  const { notifiedSignatures: _n, recognizeToken: _t, ...s } = settings ?? ({} as Settings);
  const strip = <T,>(list: T[]) => list.map((r: any) => {
    const { _syncedAt: _x, ...rest } = r;
    return rest as T;
  });
  return { format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), bills: strip(data.bills), merchants: strip(data.merchants), accounts: strip(data.accounts), settings: settings ? s : undefined };
}

export interface BackupCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  data: DataSet | null;
  settings?: Partial<Settings>;
}

const isStr = (v: unknown) => typeof v === 'string';

export function validateBackup(input: unknown): BackupCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let obj: any = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['文件不是有效的 JSON'], warnings, data: null };
    }
  }
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['文件内容为空或格式错误'], warnings, data: null };
  if (obj.format !== BACKUP_FORMAT) errors.push('不是账期助手的备份文件（format 不匹配）');
  if (typeof obj.schemaVersion !== 'number') errors.push('缺少 schemaVersion');
  else if (obj.schemaVersion > SCHEMA_VERSION) errors.push(`备份版本 ${obj.schemaVersion} 高于应用支持的 ${SCHEMA_VERSION}，请先升级应用`);
  for (const k of ['bills', 'merchants', 'accounts']) if (!Array.isArray(obj[k])) errors.push(`缺少 ${k} 列表`);
  if (errors.length) return { ok: false, errors, warnings, data: null };

  const ids = new Set<string>();
  const bills: Bill[] = [];
  obj.bills.forEach((raw: any, idx: number) => {
    const tag = `账单 #${idx + 1}${raw?.orderNumber ? `（${raw.orderNumber}）` : ''}`;
    try {
      if (!isStr(raw?.id)) throw new Error('缺少 id');
      if (ids.has(raw.id)) throw new Error('id 重复');
      ids.add(raw.id);
      const b = migrateBill({ ...raw, schemaVersion: raw.schemaVersion ?? obj.schemaVersion });
      for (const it of b.items) {
        if (!Number.isInteger(it.unitPriceCents) || it.unitPriceCents < 0) throw new Error('单价不是非负整数分');
      }
      if (!Number.isInteger(b.totalCents)) throw new Error('总额不是整数分');
      // 已删除的账单（墓碑）明细已清空，不重算金额
      const fixed = b.deletedAt ? b : recompute(b);
      if (fixed.totalCents !== b.totalCents) warnings.push(`${tag}：总额与明细不一致，导入时将按明细重新计算`);
      if (b.paidAt !== null && Number.isNaN(Date.parse(b.paidAt))) throw new Error('paidAt 不是有效时间');
      if (b.payments !== undefined) {
        if (!Array.isArray(b.payments)) throw new Error('付款记录格式不正确');
        for (const p of b.payments) {
          if (!isStr(p?.id) || !isValidISO(p?.date) || !Number.isInteger(p?.cents) || p.cents < 0) throw new Error('付款记录有无效的日期或金额');
        }
      }
      const issues = validateBill({ ...fixed, dueBeforeBillConfirmed: true }).filter((i) => i.field !== 'merchant' || !b.deletedAt);
      if (!isValidISO(b.billDate) || !isValidISO(b.dueDate)) throw new Error('日期无效');
      if (issues.length && !b.deletedAt) throw new Error(issues.map((i) => i.message).join('；'));
      bills.push({ ...fixed, orderNumber: String(fixed.orderNumber ?? '') });
    } catch (e) {
      errors.push(`${tag}：${(e as Error).message}`);
    }
  });
  const merchants: Merchant[] = [];
  obj.merchants.forEach((m: any, idx: number) => {
    if (!isStr(m?.id) || !isStr(m?.name) || !m.name.trim()) return errors.push(`商家 #${idx + 1}：缺少 id 或名称`);
    merchants.push({ defaultAccountId: null, active: true, createdAt: '', ...m, updatedAt: m.updatedAt || new Date().toISOString(), aliases: Array.isArray(m.aliases) ? m.aliases.map(String) : [] });
  });
  const accounts: PaymentAccount[] = [];
  obj.accounts.forEach((a: any, idx: number) => {
    if (!isStr(a?.id) || !isStr(a?.label) || !a.label.trim()) return errors.push(`付款账号 #${idx + 1}：缺少 id 或名称`);
    accounts.push({ type: 'outro', owner: '', bank: '', optionalPixHint: '', active: true, createdAt: '', ...a, updatedAt: a.updatedAt || new Date().toISOString() });
  });
  return { ok: errors.length === 0, errors, warnings, data: { bills, merchants, accounts }, settings: obj.settings };
}

export interface MergePlan<T> {
  add: T[];
  update: T[];
  conflict: { local: T; incoming: T }[];
  same: number;
}

type Rec = { id: string; updatedAt: string };

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).filter(([k]) => k !== '_syncedAt').sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** 规划合并：新 id → 新增；内容相同 → 跳过；导入更新 → 更新；本地更新或同时间不同内容 → 冲突 */
export function planMerge<T extends Rec>(local: T[], incoming: T[]): MergePlan<T> {
  const map = new Map(local.map((r) => [r.id, r]));
  const plan: MergePlan<T> = { add: [], update: [], conflict: [], same: 0 };
  for (const r of incoming) {
    const l = map.get(r.id);
    if (!l) plan.add.push(r);
    else if (stable(l) === stable(r)) plan.same++;
    else if (r.updatedAt > l.updatedAt) plan.update.push(r);
    else plan.conflict.push({ local: l, incoming: r });
  }
  return plan;
}

export interface ImportPreview {
  bills: MergePlan<Bill>;
  merchants: MergePlan<Merchant>;
  accounts: MergePlan<PaymentAccount>;
}

export function previewImport(local: DataSet, incoming: DataSet): ImportPreview {
  return {
    bills: planMerge(local.bills, incoming.bills),
    merchants: planMerge(local.merchants, incoming.merchants),
    accounts: planMerge(local.accounts, incoming.accounts),
  };
}

export type ConflictPolicy = 'keepLocal' | 'useIncoming';

/** 合并结果：返回需写入的记录 */
export function applyMerge<T extends Rec>(plan: MergePlan<T>, policy: ConflictPolicy): T[] {
  return [...plan.add, ...plan.update, ...(policy === 'useIncoming' ? plan.conflict.map((c) => c.incoming) : [])];
}
