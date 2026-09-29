import { MERCHANTS } from './types';
import type { Decision, EvaluationContext, Merchant, Policy, Quote } from './types';

/**
 * Keep this implementation self-contained: the regression exporter embeds this
 * exact function, not a second implementation of the financial rules.
 */
export function evaluatePolicyWithRegistry(
  quote: Quote,
  policy: Policy,
  context: EvaluationContext,
  merchants: readonly Merchant[],
): Decision {
  const checks: Decision['checks'] = [];
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const money = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  // Require real ISO timestamps with an explicit timezone, rejecting rollover
  // dates (e.g. February 30) rather than accepting Date.parse normalization.
  const instant = (value: unknown): number | null => {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, , zone] = match;
    const y = Number(year), m = Number(month), d = Number(day);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (m < 1 || m > 12 || d < 1 || d > monthDays[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
    const result = Date.parse(value);
    return Number.isFinite(result) ? result : null;
  };
  const format = (value: number) => `${(value / 1_000_000).toFixed(6)} USDC`;
  const invalid = (code: string, reason: string): Decision => ({
    allowed: false, code, reason, totalMicros: 0,
    checks: [{ key: 'input', label: 'Valid input', passed: false, detail: reason }],
  });
  if (!object(policy) || !money(policy.budgetMicros) || !Array.isArray(policy.allowedMerchants)
    || !policy.allowedMerchants.every(text) || new Set(policy.allowedMerchants).size !== policy.allowedMerchants.length
    || !text(policy.task) || instant(policy.expiresAt) === null) {
    return invalid('INVALID_POLICY', 'Policy must contain an integer budget, merchant IDs, a task and a valid ISO expiry.');
  }
  if (!object(context) || !money(context.spentMicros) || !Array.isArray(context.paidBusinessIds)
    || !context.paidBusinessIds.every(text) || new Set(context.paidBusinessIds).size !== context.paidBusinessIds.length
    || typeof context.stopped !== 'boolean' || instant(context.now) === null) {
    return invalid('INVALID_CONTEXT', 'Payment context is invalid; no payment can be authorized.');
  }
  if (!object(quote) || !text(quote.id) || !text(quote.businessId) || !text(quote.merchantId)
    || !text(quote.merchantName) || !text(quote.item) || typeof quote.recipient !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(quote.recipient)) {
    return invalid('INVALID_QUOTE', 'Quote identifiers, item and EVM recipient must be valid.');
  }
  if (!money(quote.amountMicros) || quote.amountMicros === 0 || !money(quote.feeMicros)
    || !Number.isSafeInteger(quote.amountMicros + quote.feeMicros)
    || !Number.isSafeInteger(context.spentMicros + quote.amountMicros + quote.feeMicros)) {
    return invalid('INVALID_AMOUNT', 'Amounts must be safe integer micro-USDC; purchase amount must be positive and fees non-negative.');
  }
  const totalMicros = quote.amountMicros + quote.feeMicros;
  const merchant = merchants.find((entry) => entry.id === quote.merchantId);
  const failures: { code: string; reason: string }[] = [];
  const add = (key: string, label: string, passed: boolean, detail: string, code: string, reason: string) => {
    checks.push({ key, label, passed, detail });
    if (!passed) failures.push({ code, reason });
  };
  add('stopped', 'Session active', !context.stopped,
    context.stopped ? 'The owner has stopped this session.' : 'The session is active.',
    'SESSION_STOPPED', 'Session stopped by the owner.');
  add('deadline', 'Authorization deadline', instant(context.now)! < instant(policy.expiresAt)!,
    `Request: ${context.now}; deadline: ${policy.expiresAt}.`,
    'EXPIRED', 'The authorization has expired.');
  add('merchant', 'Merchant and recipient', !!merchant && policy.allowedMerchants.includes(quote.merchantId)
    && merchant.recipient.toLowerCase() === quote.recipient.toLowerCase(),
    `Merchant: ${quote.merchantId}; recipient: ${quote.recipient}; expected: ${merchant?.recipient ?? 'unknown merchant'}.`,
    'MERCHANT_NOT_ALLOWED', 'Merchant or recipient does not match the authorized merchant identity.');
  add('duplicate', 'Business payment unique', !context.paidBusinessIds.includes(quote.businessId),
    `Business ID: ${quote.businessId}; ${context.paidBusinessIds.includes(quote.businessId) ? 'already paid' : 'not yet paid'}.`,
    'DUPLICATE_PAYMENT', 'This business request was already paid.');
  add('budget', 'Budget includes all fees', context.spentMicros + totalMicros <= policy.budgetMicros,
    `${format(context.spentMicros)} spent + ${format(quote.amountMicros)} price + ${format(quote.feeMicros)} fee / ${format(policy.budgetMicros)} budget.`,
    'BUDGET_EXCEEDED', 'Purchase plus fees would exceed the remaining session budget.');
  return {
    allowed: failures.length === 0,
    code: failures[0]?.code ?? 'APPROVED',
    reason: failures[0]?.reason ?? 'All deterministic checks passed. This local prototype simulates the payment.',
    checks,
    totalMicros,
  };
}

export function evaluateProposal(quote: Quote, policy: Policy, context: EvaluationContext): Decision {
  return evaluatePolicyWithRegistry(quote, policy, context, MERCHANTS);
}
