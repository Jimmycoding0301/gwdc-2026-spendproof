import { z } from 'zod';
import { evaluateProposal } from './policy';
import { MERCHANTS } from './types';
import type { Decision, EvaluationContext, Policy, Quote } from './types';

export type PolicyEvaluator = (quote: Quote, policy: Policy, context: EvaluationContext) => Decision;
export interface BoundarySeed { quote: Quote; policy: Policy; context: EvaluationContext; recordId?: string }
export type BoundaryKind = 'budget_exact' | 'budget_short_one' | 'deadline_before' | 'deadline_exact'
  | 'deadline_after' | 'recipient_changed' | 'merchant_removed' | 'duplicate_business' | 'owner_stopped';
type CheckKey = Decision['checks'][number]['key'];

export interface BoundaryExpectation {
  allowed: boolean;
  code: string;
  totalMicros: number;
  checks: Partial<Record<CheckKey, boolean>>;
}

export interface BoundaryCase extends BoundarySeed {
  id: string;
  kind: BoundaryKind;
  label: string;
  description: string;
  /** These are synthetic cases, never additional historical payment records. */
  synthetic: true;
  normalization: string[];
  expected: BoundaryExpectation;
}

export interface BoundaryResult {
  caseId: string;
  kind: BoundaryKind;
  label: string;
  expected: BoundaryExpectation;
  actual: Decision | null;
  passed: boolean;
  error?: string;
}

export interface BoundaryReport {
  passed: boolean;
  total: number;
  failed: number;
  results: BoundaryResult[];
  issues: string[];
  llmCalls: 0;
  paymentCalls: 0;
}

const text = z.string().refine(value => value.trim().length > 0, 'Expected nonempty text.');
const money = z.number().int().safe().nonnegative();
const seedSchema = z.object({
  quote: z.object({
    id: text, businessId: text, merchantId: text, merchantName: text, item: text,
    recipient: z.string().regex(/^0x[0-9a-fA-F]{40}$/), amountMicros: money.positive(), feeMicros: money,
  }),
  policy: z.object({
    task: text, budgetMicros: money, allowedMerchants: z.array(text),
    expiresAt: z.iso.datetime({ offset: true }),
  }),
  context: z.object({ spentMicros: money, paidBusinessIds: z.array(text), stopped: z.boolean(), now: z.iso.datetime({ offset: true }) }),
  recordId: text.optional(),
});

/**
 * Create an independent one-variable-at-a-time contract from captured values.
 * Restore a disclosed, synthetic allowed baseline, even when the source incident
 * was blocked. Expected outcomes are explicit contracts, not candidate outputs.
 */
export function generateBoundaryCases(input: BoundarySeed): BoundaryCase[] {
  const seed = seedSchema.parse(input);
  const merchant = MERCHANTS.find(item => item.id === seed.quote.merchantId);
  if (!merchant) throw new Error('Boundary cases require a merchant in the demo registry.');
  const totalMicros = seed.quote.amountMicros + seed.quote.feeMicros;
  const exactBudget = seed.context.spentMicros + totalMicros;
  if (!Number.isSafeInteger(totalMicros) || !Number.isSafeInteger(exactBudget)) {
    throw new Error('Boundary amounts exceed safe integer micro-USDC precision.');
  }
  const expiry = Date.parse(seed.policy.expiresAt);
  const adjacent = (offset: number) => {
    const value = new Date(expiry + offset).toISOString();
    if (!/^\d{4}-/.test(value)) throw new Error('Deadline has no supported adjacent timestamp.');
    return value;
  };
  const before = adjacent(-1000);
  const at = adjacent(0);
  const after = adjacent(1000);
  const baseline: BoundarySeed = {
    quote: { ...seed.quote, recipient: merchant.recipient },
    policy: { ...seed.policy, budgetMicros: exactBudget, allowedMerchants: [...new Set([...seed.policy.allowedMerchants, merchant.id])] },
    context: { ...seed.context, now: before, stopped: false, paidBusinessIds: [...new Set(seed.context.paidBusinessIds.filter(id => id !== seed.quote.businessId))] },
    ...(seed.recordId ? { recordId: seed.recordId } : {}),
  };
  const normalization = [
    '合成基线：使用供应商登记地址与许可状态。',
    '保留发票金额、服务费和历史累计；预算设为三者之和。',
    '时间设为截止前一秒，清除停止状态与当前发票的已付标记。',
    '每例独立，不写回，不付款。',
  ];
  const kinds: Array<{ kind: BoundaryKind; label: string; description: string; code: string; failed?: CheckKey; change?: (value: BoundarySeed) => void }> = [
    { kind: 'budget_exact', label: '预算恰好足够', description: '历史累计＋发票＋服务费等于预算，应允许。', code: 'APPROVED' },
    { kind: 'budget_short_one', label: '预算少 1 micro-USDC', description: '总预算比所需金额少最小单位，应拦截。', code: 'BUDGET_EXCEEDED', failed: 'budget', change: value => { value.policy.budgetMicros--; } },
    { kind: 'deadline_before', label: '截止前 1 秒', description: '请求在授权到期前一秒，应允许。', code: 'APPROVED' },
    { kind: 'deadline_exact', label: '恰好到期', description: '到期瞬间已经失效，应拦截。', code: 'EXPIRED', failed: 'deadline', change: value => { value.context.now = at; } },
    { kind: 'deadline_after', label: '截止后 1 秒', description: '请求在授权到期后一秒，应拦截。', code: 'EXPIRED', failed: 'deadline', change: value => { value.context.now = after; } },
    { kind: 'recipient_changed', label: '同名供应商换钱包', description: '名称与 ID 不变，仅换地址，应拦截。', code: 'MERCHANT_NOT_ALLOWED', failed: 'merchant', change: value => {
      const last = value.quote.recipient.at(-1)?.toLowerCase();
      value.quote.recipient = `${value.quote.recipient.slice(0, -1)}${last === '0' ? '1' : '0'}`;
    } },
    { kind: 'merchant_removed', label: '供应商移出名单', description: '地址匹配，但供应商不再获准，应拦截。', code: 'MERCHANT_NOT_ALLOWED', failed: 'merchant', change: value => { value.policy.allowedMerchants = value.policy.allowedMerchants.filter(id => id !== value.quote.merchantId); } },
    { kind: 'duplicate_business', label: '同一发票再次付款', description: '换报价 ID，发票编号不变，应拦截。', code: 'DUPLICATE_PAYMENT', failed: 'duplicate', change: value => {
      value.quote.id = `${value.quote.id}:boundary-retry`;
      value.context.paidBusinessIds.push(value.quote.businessId);
    } },
    { kind: 'owner_stopped', label: '任务停止后继续', description: '发票合规，但任务已停止，应拦截。', code: 'SESSION_STOPPED', failed: 'stopped', change: value => { value.context.stopped = true; } },
  ];
  return kinds.map(({ kind, label, description, code, failed, change }) => {
    const value = structuredClone(baseline);
    change?.(value);
    const checks: BoundaryExpectation['checks'] = { stopped: true, deadline: true, merchant: true, duplicate: true, budget: true };
    if (failed) checks[failed] = false;
    return {
      ...value, id: `${seed.recordId || seed.quote.id}:${kind}`, kind, label, description,
      synthetic: true, normalization: [...normalization],
      expected: { allowed: code === 'APPROVED', code, totalMicros, checks },
    };
  });
}

/** Evaluate trusted local code against frozen contracts; no external side effects are provided. */
export function runBoundaryCases(cases: readonly BoundaryCase[], evaluator: PolicyEvaluator = evaluateProposal): BoundaryReport {
  const results = cases.map((item): BoundaryResult => {
    const expected = structuredClone(item.expected);
    try {
      const actual = structuredClone(evaluator(structuredClone(item.quote), structuredClone(item.policy), structuredClone(item.context)));
      const passed = actual.allowed === expected.allowed && actual.code === expected.code && actual.totalMicros === expected.totalMicros
        && Object.entries(expected.checks).every(([key, value]) => actual.checks.filter(check => check.key === key).length === 1
          && actual.checks.find(check => check.key === key)!.passed === value);
      return { caseId: item.id, kind: item.kind, label: item.label, expected, actual, passed };
    } catch {
      return { caseId: item.id, kind: item.kind, label: item.label, expected, actual: null, passed: false, error: 'Candidate evaluator failed to return a usable decision.' };
    }
  });
  const issues = cases.length ? [] : ['No boundary cases were supplied.'];
  if (new Set(cases.map(item => item.id)).size !== cases.length) issues.push('Boundary case IDs must be unique.');
  const failed = results.filter(item => !item.passed).length;
  return { passed: failed === 0 && issues.length === 0, total: results.length, failed, results, issues, llmCalls: 0, paymentCalls: 0 };
}
