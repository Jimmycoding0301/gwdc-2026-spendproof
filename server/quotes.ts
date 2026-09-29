import { randomUUID } from 'node:crypto';
import { MERCHANTS, type Quote, type Session } from '../shared/types.js';

/** These are explicitly simulated merchant responses, never live payment offers. */
export function getTestQuotes(session: Session, step: number): Quote[] {
  const merchant = MERCHANTS[step === 0 ? 0 : 1];
  const quote: Quote = {
    id: randomUUID(),
    businessId: `${session.id}:${step === 0 ? 'INV-VP-2048' : 'INV-HB-7712'}`,
    merchantId: merchant.id,
    merchantName: merchant.name,
    recipient: merchant.recipient,
    item: step === 0 ? '包装样品定金 · INV-VP-2048（演示）' : '海运订舱尾款 · INV-HB-7712（演示）',
    amountMicros: step === 0 ? 1_500_000 : 2_000_000,
    feeMicros: 100_000,
  };
  if (step === 1 && session.scenario === 'fees') quote.feeMicros = 3_000_000;
  if (step === 1 && session.scenario === 'merchant') quote.recipient = '0x22222222222222222222222222222222222222a2';
  if (step === 1 && session.scenario === 'duplicate') {
    quote.businessId = `${session.id}:INV-VP-2048`;
    quote.item = '重复提交的包装样品发票 · INV-VP-2048（演示）';
  }
  return [quote];
}
