import { describe, expect, it } from 'vitest';
import { createImpactDemoScenarios, evaluateCandidateRule, evaluateRedGreen, evaluateRuleImpact } from '../shared/impact';
import type { CandidateRule, ImpactScenario } from '../shared/impact';
import { evaluateProposal } from '../shared/policy';
import type { EvaluationContext, PaymentRecord, Quote } from '../shared/types';

function recordChain(scenario: ImpactScenario, quotes: Quote[]): ImpactScenario {
  let spentMicros = 0;
  const paidBusinessIds: string[] = [];
  const records = quotes.map((quote, index): PaymentRecord => {
    const context: EvaluationContext = { spentMicros, paidBusinessIds: [...paidBusinessIds], stopped: false, now: `2026-09-28T12:00:0${index}.000Z` };
    const decision = evaluateProposal(quote, scenario.policy, context);
    if (decision.allowed) { spentMicros += decision.totalMicros; paidBusinessIds.push(quote.businessId); }
    return { id: `record-${index}`, quote, decision, context, createdAt: context.now, status: decision.allowed ? 'simulated' : 'blocked' };
  });
  return { ...scenario, records };
}

describe('offline rule-change impact reports', () => {
  it('turns a fee omission red and the current/correct engine green over the same four scenarios', () => {
    const scenarios = createImpactDemoScenarios();
    const { red, green } = evaluateRedGreen(scenarios);
    expect(red.verdict).toBe('fail');
    expect(red.summary).toMatchObject({ scenarios: 4, total: 8, eligible: 8, skipped: 0,
      falseAllow: 1, falseBlock: 0, unchanged: 7, affectedScenarios: 1, falseAllowMicros: 5_000_000 });
    const missedFee = red.items.find(item => item.classification === 'falseAllow')!;
    expect(missedFee.scenario).toBe('fees');
    expect(missedFee.expected.code).toBe('BUDGET_EXCEEDED');
    expect(missedFee.actual).toMatchObject({ code: 'APPROVED', totalMicros: 5_000_000 });
    expect(missedFee.changedChecks).toEqual([expect.objectContaining({ key: 'budget', expectedPassed: false, actualPassed: true })]);
    expect(missedFee.reason).toContain('误放行');
    expect(green.verdict).toBe('pass');
    expect(green.summary).toMatchObject({ total: 8, eligible: 8, falseAllow: 0, falseBlock: 0, unchanged: 8 });
    expect(evaluateRuleImpact(scenarios, 'correct').items).toEqual(green.items);
    expect(red.items.every(item => item.source === 'fixture')).toBe(true);
    expect([red.llmCalls, red.paymentCalls, green.llmCalls, green.paymentCalls]).toEqual([0, 0, 0, 0]);
  });

  it('rebuilds the candidate ledger so an earlier false allow can cause a later false block', () => {
    const base = createImpactDemoScenarios()[0];
    base.policy.budgetMicros = 10_000_000;
    const scenario = recordChain(base, [
      { ...base.records[0].quote, amountMicros: 8_000_000, feeMicros: 3_000_000 },
      { ...base.records[1].quote, amountMicros: 1_000_000, feeMicros: 0 },
    ]);
    const report = evaluateRuleImpact([scenario], 'ignore-fees');
    expect(report.summary).toMatchObject({ falseAllow: 1, falseBlock: 1, unchanged: 0, falseAllowMicros: 11_000_000 });
    expect(report.items.map(item => item.classification)).toEqual(['falseAllow', 'falseBlock']);
    expect(report.items[1].originalContext.spentMicros).toBe(0);
    expect(report.items[1].candidateContext?.spentMicros).toBe(11_000_000);
    expect(report.items[1].actual?.code).toBe('BUDGET_EXCEEDED');
    expect(report.items[1].reason).toContain('误拦截');
  });

  it('keeps ledgers separate between scenarios even when business IDs are identical', () => {
    const base = createImpactDemoScenarios()[0];
    const first = recordChain(base, [{ ...base.records[0].quote, businessId: 'shared-business-id' }]);
    const second = { ...structuredClone(first), id: 'another-scenario', source: 'history' as const };
    const report = evaluateRuleImpact([first, second], 'ignore-fees');
    expect(report.verdict).toBe('pass');
    expect(report.items.map(item => item.candidateContext?.spentMicros)).toEqual([0, 0]);
    expect(report.items.map(item => item.actual?.code)).toEqual(['APPROVED', 'APPROVED']);
    expect(report.items[1].source).toBe('history');
  });

  it('quarantines an unreproducible legacy ledger while retaining every row outside the release gate', () => {
    const [old, fees] = createImpactDemoScenarios();
    old.records[0].decision = { allowed: false, code: 'INVALID_POLICY', reason: 'Old timestamp parser rejected this policy.', totalMicros: 0, checks: [] };
    old.records[0].status = 'blocked';
    const { red, green } = evaluateRedGreen([old, fees]);
    expect(red.summary).toMatchObject({ total: 4, eligible: 2, skipped: 2, falseAllow: 1, unchanged: 1, skippedScenarios: 1 });
    expect(green.summary).toMatchObject({ total: 4, eligible: 2, skipped: 2, unchanged: 2 });
    expect(green.verdict).toBe('pass');
    expect(green.baselineIssues[0].issues.join(' ')).toContain('INVALID_POLICY');
    expect(green.items.filter(item => item.classification === 'skipped')).toHaveLength(2);
    expect(green.items[0]).toMatchObject({ actual: null, candidateContext: null });
    expect(green.items[0].baselineIssues.length).toBeGreaterThan(0);
    expect(evaluateRuleImpact([old], 'current').verdict).toBe('empty');
  });

  it('quarantines forged cumulative context instead of treating it as a genuine regression case', () => {
    const scenario = createImpactDemoScenarios()[1];
    scenario.records[1].context.spentMicros = 0;
    const report = evaluateRuleImpact([scenario], 'current');
    expect(report.summary).toMatchObject({ eligible: 0, skipped: 2, falseAllow: 0, falseBlock: 0 });
    expect(report.verdict).toBe('empty');
    expect(report.baselineIssues[0].issues.join(' ')).toContain('原始累计支出');
  });

  it('does not let the fault bypass invalid amounts, merchant binding, expiry, duplicate or stop checks', () => {
    const scenario = createImpactDemoScenarios()[0];
    const { quote, context } = scenario.records[0];
    const run = (q = quote, c = context) => evaluateCandidateRule('ignore-fees', q, scenario.policy, c);
    expect(run({ ...quote, feeMicros: -1 }).code).toBe('INVALID_AMOUNT');
    expect(run({ ...quote, amountMicros: Number.MAX_SAFE_INTEGER, feeMicros: 1 }).code).toBe('INVALID_AMOUNT');
    expect(run({ ...quote, recipient: '0x3333333333333333333333333333333333333333' }).code).toBe('MERCHANT_NOT_ALLOWED');
    expect(run(quote, { ...context, now: scenario.policy.expiresAt }).code).toBe('EXPIRED');
    expect(run(quote, { ...context, paidBusinessIds: [quote.businessId] }).code).toBe('DUPLICATE_PAYMENT');
    expect(run(quote, { ...context, stopped: true }).code).toBe('SESSION_STOPPED');
  });

  it('keeps inputs and both report snapshots independent', () => {
    const scenarios = createImpactDemoScenarios();
    const before = JSON.stringify(scenarios);
    const { red, green } = evaluateRedGreen(scenarios);
    expect(JSON.stringify(scenarios)).toBe(before);
    red.items[0].quote.feeMicros = 999;
    red.items[0].expected.checks[0].detail = 'changed report';
    red.items[0].originalContext.paidBusinessIds.push('changed report');
    expect(JSON.stringify(scenarios)).toBe(before);
    expect(green.items[0].quote.feeMicros).toBe(100_000);
    expect(green.items[0].expected.checks[0].detail).not.toBe('changed report');
  });

  it('never shows a passing gate without eligible records or for an unknown candidate', () => {
    expect(evaluateRuleImpact([]).verdict).toBe('empty');
    const empty = { ...createImpactDemoScenarios()[0], records: [] };
    expect(evaluateRuleImpact([empty]).summary).toMatchObject({ total: 0, eligible: 0, emptyScenarios: 1 });
    expect(() => evaluateRuleImpact([], 'invented-rule' as CandidateRule)).toThrow('Unknown candidate');
    expect(() => evaluateRuleImpact([empty, empty])).toThrow('Scenario IDs must be unique');
  });
});
