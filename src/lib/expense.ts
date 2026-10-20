/** 日常缴费分类与常见缴费单位 */
import type { Bill } from './types';

export interface ExpenseCategory {
  id: string;
  label: string;
  pt: string;
  mark: string; // 单字标记，用于图标位
  suggestions: string[];
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { id: 'water', label: '水费', pt: 'Água', mark: '水', suggestions: ['Sabesp', 'Cedae', 'Copasa'] },
  { id: 'power', label: '电费', pt: 'Energia', mark: '电', suggestions: ['Enel', 'Light', 'CPFL', 'Cemig'] },
  { id: 'gas', label: '燃气', pt: 'Gás', mark: '气', suggestions: ['Comgás', 'Naturgy'] },
  { id: 'internet', label: '网络电话', pt: 'Internet / Telefone', mark: '网', suggestions: ['Vivo', 'Claro', 'TIM'] },
  { id: 'rent', label: '房租', pt: 'Aluguel', mark: '租', suggestions: [] },
  { id: 'condo', label: '物业费', pt: 'Condomínio', mark: '物', suggestions: [] },
  { id: 'tax', label: '税费', pt: 'Impostos', mark: '税', suggestions: ['DAS Simples Nacional', 'ICMS', 'ISS', 'IPTU', 'IPVA', 'DARF'] },
  { id: 'payroll', label: '工资社保', pt: 'Salários / INSS / FGTS', mark: '薪', suggestions: ['INSS', 'FGTS', 'eSocial'] },
  { id: 'accounting', label: '会计', pt: 'Contabilidade', mark: '账', suggestions: [] },
  { id: 'shipping', label: '物流运费', pt: 'Frete', mark: '运', suggestions: ['Correios', 'Jadlog', 'Loggi'] },
  { id: 'platform', label: '平台费用', pt: 'Marketplace', mark: '台', suggestions: ['Shopee', 'TikTok Shop', 'Mercado Livre'] },
  { id: 'loan', label: '贷款信用卡', pt: 'Empréstimo / Cartão', mark: '贷', suggestions: [] },
  { id: 'software', label: '软件订阅', pt: 'Assinaturas', mark: '订', suggestions: [] },
  { id: 'other', label: '其他', pt: 'Outros', mark: '其', suggestions: [] },
];

const BY_ID = new Map(EXPENSE_CATEGORIES.map((c) => [c.id, c]));
export const categoryOf = (id: string | null | undefined) => (id ? BY_ID.get(id) ?? null : null);
export const categoryLabel = (id: string | null | undefined) => categoryOf(id)?.label ?? '缴费';

export const isExpense = (b: Pick<Bill, 'kind'>) => b.kind === 'expense';

/** 列表/日历里显示的名称 */
export function billTitle(b: Pick<Bill, 'kind' | 'category' | 'merchantNameSnapshot'>): string {
  if (!isExpense(b)) return b.merchantNameSnapshot;
  const cat = categoryLabel(b.category);
  return b.merchantNameSnapshot && b.merchantNameSnapshot !== cat ? `${cat} · ${b.merchantNameSnapshot}` : cat;
}

export { nextRecurring, needsNextRecurring } from './recurrence';

/** 巴西 boleto 线（47/48 位）或 PIX copia-e-cola 的粗略识别 */
export function describePaymentCode(code: string): string {
  const c = code.replace(/\s+/g, '');
  if (!c) return '';
  if (/^000201/.test(c)) return 'PIX 复制码';
  const digits = c.replace(/\D/g, '');
  if (digits.length === 47) return 'Boleto 银行单';
  if (digits.length === 48) return 'Boleto 公共缴费（水电税）';
  return '付款码';
}
