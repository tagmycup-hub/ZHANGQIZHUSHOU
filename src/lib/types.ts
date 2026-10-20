export const SCHEMA_VERSION = 1;

export type BillStatus = 'open' | 'dueSoon' | 'overdue' | 'paid';

export interface Item {
  id: string;
  quantity: number;
  description: string;
  unitPriceCents: number;
  subtotalCents: number;
  /** 图片中小计原文，仅用于比对 */
  recognizedSubtotalRaw?: string | null;
}

export interface OcrReviewRecord {
  provider: string;
  rawText?: string | null;
  /** 模型/OCR 原始候选（规范化后） */
  candidate: unknown;
  warnings: string[];
  /** 用户对警告的确认 */
  acknowledged: string[];
  /** 用户修改过的字段 */
  edits: { field: string; from: unknown; to: unknown }[];
  confirmedAt: string;
  confirmedBy: string;
  imageId?: string | null;
  originalImageId?: string | null;
}

/** 商家/缴费单位的固定账期规则 */
export type TermRule =
  | { kind: 'days'; days: number }
  | { kind: 'monthDay'; day: number; monthOffset: number; cutoffDay?: number | null }
  | { kind: 'installments'; days: number[] };

export type BillKind = 'supplier' | 'expense';

export interface InstallmentInfo {
  groupId: string;
  index: number; // 1 起
  count: number;
  groupTotalCents: number;
  /** 原始明细（仅供查看，金额以本期为准） */
  sourceItems?: Item[];
}

export interface Bill {
  id: string;
  merchantId: string | null;
  merchantNameSnapshot: string;
  orderNumber: string;
  billDate: string;
  dueDate: string;
  /** 用户确认到期日早于账单日 */
  dueBeforeBillConfirmed?: boolean;
  accountId: string | null;
  accountLabelSnapshot: string;
  reminderDays: number;
  paidAt: string | null;
  notes: string;
  items: Item[];
  /** 'total' = 仅填总金额（一行整单金额），缺省为逐行明细 */
  amountMode?: 'items' | 'total';
  totalCents: number;
  ocrReview: OcrReviewRecord | null;
  /** 账单类型：商家货款（默认）/ 日常缴费 */
  kind?: BillKind;
  /** 日常缴费分类，见 lib/expense.ts */
  category?: string | null;
  /** Boleto 条码 / PIX 复制码 */
  paymentCode?: string;
  /** 重复周期（见 lib/recurrence.ts） */
  recurrence?: import('./recurrence').Recurrence | null;
  /** 金额为预估（自动生成的下期账单），收到实际账单后需确认 */
  estimated?: boolean;
  /** 分期账单 */
  installment?: InstallmentInfo | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  schemaVersion: number;
  /** 分次付款记录（付清后 paidAt 同时写入） */
  payments?: import('./payments').Payment[];
}

export interface Merchant {
  id: string;
  name: string;
  aliases: string[];
  defaultAccountId: string | null;
  active: boolean;
  /** supplier = 商家（默认），payee = 缴费单位（水电公司、税务等） */
  type?: 'supplier' | 'payee';
  /** 固定账期 */
  term?: TermRule | null;
  /** 缴费单位的默认分类 */
  defaultCategory?: string | null;
  /** 旧版：默认每月重复 */
  recurring?: boolean;
  /** 默认重复周期 */
  repeat?: import('./recurrence').RepeatRule | null;
  note?: string;
  /** 识别色（0–6，见 lib/colors） */
  color?: number | null;
  /** 识别学习：「识别成 A → 实际是 B」（key 为规范化后的识别文字），复核时自动记录 */
  ocrFixes?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export type AccountType = 'pix' | 'banco' | 'boleto' | 'dinheiro' | 'outro';

export interface PaymentAccount {
  id: string;
  label: string;
  type: AccountType;
  owner: string;
  bank: string;
  /** PIX 键或账号，界面默认脱敏 */
  optionalPixHint: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface Settings {
  id: 'settings';
  defaultReminderDays: number;
  dueSoonDays: number;
  defaultMerchantId: string | null;
  defaultAccountId: string | null;
  notificationsEnabled: boolean;
  /** 已发送通知的签名，用于去重 */
  notifiedSignatures: string[];
  cloudConsent: boolean;
  recognizeEndpoint: string;
  /** 自建识别服务的访问口令（不是模型密钥，防止他人盗用你的服务） */
  recognizeToken: string;
  /** Supabase 识别函数名（网址 /functions/v1/ 后面那段）或完整网址；空 = recognize */
  recognizeFn?: string | null;
  /** 上次成功使用的识别方式 */
  lastProvider: string | null;
  /** 每月支出预算（分），0 或空表示不设 */
  monthlyBudgetCents?: number | null;
  updatedAt: string;
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  pix: 'PIX',
  banco: '银行转账',
  boleto: 'Boleto',
  dinheiro: '现金',
  outro: '其他',
};

export function defaultSettings(): Settings {
  return {
    id: 'settings',
    defaultReminderDays: 3,
    dueSoonDays: 7,
    defaultMerchantId: null,
    defaultAccountId: null,
    notificationsEnabled: true,
    notifiedSignatures: [],
    cloudConsent: false,
    recognizeEndpoint: '/api/recognize',
    recognizeToken: '',
    lastProvider: null,
    monthlyBudgetCents: null,
    updatedAt: new Date(0).toISOString(),
  };
}
