import { describe, it, expect } from 'vitest';
import { textToModel } from '../src/lib/ocr/pdfText';
import { bankDV, barcodeToLine } from '../src/lib/boleto';

const T = '2026-10-09';
const line = (() => {
  const body = '0019' + '1590' + '0000030000' + '0000003326293000173088717'.slice(0, 25);
  return barcodeToLine(body.slice(0, 4) + bankDV(body) + body.slice(4))!;
})();

describe('PDF 文字直接读取', () => {
  it('Boleto（会计费）', () => {
    const text = `Recibo do Pagador\n001-9   ${line}\nBeneficiário   Agência / Código do Beneficiário\nESCRITORIO CONTABIL EXEMPLO LTDA   1234-5 / 0000300-X\nNúmero do documento   CPF/CNPJ   Vencimento   Valor documento\n1730887   00.000.000/0001-00   05/10/2026   R$ 300,00\nVr. ref. honorários contábeis do mês de setembro\nData do documento\n01/10/2026`;
    const m = textToModel(text, T)!;
    expect(m.docType).toBe('boleto');
    expect(m.categoryHint).toBe('accounting');
    expect(m.merchant.value).toBe('ESCRITORIO CONTABIL EXEMPLO LTDA');
    expect(m.amountDue?.cents).toBe(30000);
    expect(m.dueDate?.iso).toBe('2026-10-05');
    expect(m.paymentLine).toBe(line);
    expect(m.orderNumber.value).toBe('1730887');
  });
  it('FGTS 缴费单', () => {
    const text = `GFD - Guia do FGTS Digital\nPagar este documento até\nCPF/CNPJ do Empregador   Nome/Razão Social do Empregador\n20/10/2026\nValor a recolher\n1   0000000000000000-0   09/2026 MENSAL   182,19\nTotal da Guia: 182,19`;
    const m = textToModel(text, T)!;
    expect(m.docType).toBe('tax');
    expect(m.categoryHint).toBe('payroll');
    expect(m.merchant.value).toBe('FGTS');
    expect(m.dueDate?.iso).toBe('2026-10-20');
    expect(m.amountDue?.cents).toBe(18219);
  });
  it('工资单：取实发金额', () => {
    const text = `RECIBO DE PAGAMENTO DE SALÁRIO MENSAL   Competência\nSetembro/2026\nNº Reg.   Chapa   Nome\n00001   FUNCIONARIA EXEMPLO\nSALARIO NORMAL 2.000,00\nLÍQUIDO\n1.800,00   150,00   1.500,00   A RECEBER   1.234,00`;
    const m = textToModel(text, T)!;
    expect(m.docType).toBe('payslip');
    expect(m.merchant.value).toBe('FUNCIONARIA EXEMPLO');
    expect(m.amountDue?.cents).toBe(123400);
    expect(m.referenceMonth).toBe('Setembro/2026');
  });
  it('没有可用信息时返回 null', () => {
    expect(textToModel('apenas texto sem valores', T)).toBeNull();
  });
});
describe('PDF 文字排版兼容', () => {
  it('字母间隔排版与连字', () => {
    const text = `RECIBO DE PAGAMENTO DE SALÁRIO MENSAL Setembro/2026\nNº Reg. Chapa Nome\n00001 FUNCIONARIA EXEMPLO\nBase Cál. F.G.T.S L Í Q U I D O\nA R E C E B E R 1.159,00\n2.277,46 182,19`;
    expect(textToModel(text, T)!.amountDue?.cents).toBe(115900);
    const b = textToModel(`Beneﬁciário\nLOJA EXEMPLO LTDA\nVencimento 05/10/2026 Valor documento R$ 10,00`, T)!;
    expect(b.merchant.value).toBe('LOJA EXEMPLO LTDA');
  });
});
