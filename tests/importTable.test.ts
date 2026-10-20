import { describe, it, expect } from 'vitest';
import { detectDelimiter, guessField, parseRows, planImport, findDuplicate } from '../src/lib/importTable';
import type { Bill, Merchant, PaymentAccount } from '../src/lib/types';
import { recompute } from '../src/lib/bill';

const merchants: Merchant[] = [
  { id: 'm1', name: 'Loja Exemplo', aliases: ['LOJA EX'], defaultAccountId: null, active: true, term: { kind: 'days', days: 30 }, createdAt: '', updatedAt: '' },
  { id: 'm2', name: 'Bras Acessórios', aliases: [], defaultAccountId: null, active: true, createdAt: '', updatedAt: '' },
];
const accounts: PaymentAccount[] = [{ id: 'a1', label: 'PIX 公司主账户', type: 'pix', active: true, createdAt: '', updatedAt: '' } as PaymentAccount];
let n = 0;
const opts = (bills: Bill[] = []) => ({ merchants, accounts, bills, settings: { defaultReminderDays: 3, defaultAccountId: 'a1' }, today: '2026-09-20', uuid: () => `id-${++n}`, now: '2026-09-20T00:00:00.000Z' });

describe('表格导入', () => {
  it('识别分隔符与表头（中文/葡文）', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(guessField('Fornecedor')).toBe('merchant');
    expect(guessField('Vencimento')).toBe('dueDate');
    expect(guessField('金额 (R$)')).toBe('amount');
    expect(guessField('随便写的')).toBe('skip');
  });
  it('解析带引号和换行的 CSV', () => {
    expect(parseRows('a;b\n"x;1";2\n')).toEqual([['a', 'b'], ['x;1', '2']]);
  });
  it('正常行生成账单，缺到期日时按商家账期算', () => {
    const csv = '商家;单号;开单日期;到期日期;金额\nLOJA EX;A1;01/09/2026;01/10/2026;1.234,56\nLoja Exemplo;A2;05/09/2026;;500,00\n';
    const p = planImport(csv, opts());
    expect(p.okCount).toBe(2);
    expect(p.rows[0].bill?.merchantId).toBe('m1');
    expect(p.rows[0].bill?.totalCents).toBe(123456);
    expect(p.rows[0].bill?.accountLabelSnapshot).toBe('PIX 公司主账户');
    expect(p.rows[1].bill?.dueDate).toBe('2026-10-05');
  });
  it('错误行给出原因，不生成账单', () => {
    const csv = '商家;开单日期;到期日期;金额\n;01/09/2026;01/10/2026;10,00\nLoja Exemplo;01/09/2026;31/02/2026;10,00\nLoja Exemplo;01/09/2026;01/10/2026;abc\nSem Termo;01/09/2026;;10,00\n';
    const p = planImport(csv, { ...opts(), merchants: [...merchants, { ...merchants[1], id: 'm3', name: 'Sem Termo', term: null }] });
    expect(p.okCount).toBe(0);
    expect(p.badCount).toBe(4);
    expect(p.rows[0].issues[0]).toContain('商家');
    expect(p.rows[1].issues.join()).toContain('到期日期');
    expect(p.rows[2].issues.join()).toContain('金额');
    expect(p.rows[3].issues.join()).toContain('固定账期');
  });
  it('新商家会被列出，重复账单被标记', () => {
    const existing = recompute({ id: 'b1', merchantId: 'm1', merchantNameSnapshot: 'Loja Exemplo', orderNumber: 'A1', billDate: '2026-09-01', dueDate: '2026-10-01', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: [{ id: 'i', quantity: 1, description: 'x', unitPriceCents: 123456, subtotalCents: 123456 }], totalCents: 123456, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1 } as Bill);
    const csv = '商家;单号;开单日期;到期日期;金额\nLoja Exemplo;A1;01/09/2026;01/10/2026;1.234,56\nNova Loja;B2;01/09/2026;01/10/2026;10,00\nNova Loja;B2;01/09/2026;01/10/2026;10,00\n';
    const p = planImport(csv, opts([existing]));
    expect(p.rows[0].duplicateOf?.id).toBe('b1');
    expect(p.rows[2].duplicateOf).toBeTruthy(); // 同一批次内也查重
    expect(p.newMerchants).toEqual(['Nova Loja']);
    expect([p.okCount, p.dupCount]).toEqual([1, 2]);
  });
  it('findDuplicate：同商家同单号，或同到期日同金额', () => {
    const x = recompute({ id: 'b1', merchantId: 'm1', merchantNameSnapshot: 'Loja', orderNumber: '77', billDate: '2026-09-01', dueDate: '2026-10-01', accountId: null, accountLabelSnapshot: '', reminderDays: 3, paidAt: null, notes: '', items: [{ id: 'i', quantity: 1, description: 'x', unitPriceCents: 5000, subtotalCents: 5000 }], totalCents: 5000, ocrReview: null, createdAt: '', updatedAt: '', schemaVersion: 1 } as Bill);
    expect(findDuplicate([x], { merchantId: 'm1', merchantNameSnapshot: 'Loja', orderNumber: '77', dueDate: '2026-12-01', totalCents: 1 })?.id).toBe('b1');
    expect(findDuplicate([x], { merchantId: 'm1', merchantNameSnapshot: 'Loja', orderNumber: '', dueDate: '2026-10-01', totalCents: 5000 })?.id).toBe('b1');
    expect(findDuplicate([x], { merchantId: 'm2', merchantNameSnapshot: 'Outra', orderNumber: '77', dueDate: '2026-10-01', totalCents: 5000 })).toBeNull();
    expect(findDuplicate([x], { merchantId: 'm1', merchantNameSnapshot: 'Loja', orderNumber: '77', dueDate: '2026-10-01', totalCents: 5000 }, 'b1')).toBeNull();
  });
});

describe('表格导入：英文格式金额', () => {
  it('整列是 1234.56 / 1,234.56 时按点做小数点读取', () => {
    const csv = 'Fornecedor,Vencimento,Valor\nLoja Exemplo,01/10/2026,1234.56\nLoja Exemplo,02/10/2026,"1,500.00"\nLoja Exemplo,03/10/2026,80\n';
    const p = planImport(csv, opts());
    expect(p.rows.map((r) => r.bill?.totalCents)).toEqual([123456, 150000, 8000]);
  });
  it('巴西格式不受影响', () => {
    const p = planImport('商家;到期日期;金额\nLoja Exemplo;01/10/2026;1.234,56\n', opts());
    expect(p.rows[0].bill?.totalCents).toBe(123456);
  });
});

describe('表格导入：表头与年份', () => {
  it('Data de vencimento 是到期日，Data de emissão 是开单日', () => {
    expect(['Data de emissão', 'Data de vencimento', 'Data venc.', 'Vencimento'].map(guessField)).toEqual(['billDate', 'dueDate', 'dueDate', 'dueDate']);
    expect(guessField('Data de pagamento')).not.toBe('account');
  });
  it('两位年份离今年太远时报错', () => {
    const p = planImport('商家;开单日期;到期日期;金额\nLoja Exemplo;01/09/22;01/10/22;10,00\nLoja Exemplo;01/09/26;01/10/26;10,00\n', opts());
    expect(p.rows[0].issues.join()).toContain('两位年份');
    expect(p.rows[1].bill?.dueDate).toBe('2026-10-01');
  });
});
