import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateBoundaryCases, runBoundaryCases } from '../shared/boundaries';
import type { BoundarySeed, PolicyEvaluator } from '../shared/boundaries';
import { evaluateProposal } from '../shared/policy';
import { createSpendProof, runHistoricalRegression } from '../sdk/index';
import type { HistoricalInput } from '../sdk/index';
import type { Decision, PaymentRecord } from '../shared/types';
import { childTestEnv } from './helpers/child-env';

function seed(): BoundarySeed {
  return {
    recordId: 'incident-2',
    quote: { id: 'quote-2', businessId: 'research-2', merchantId: 'atlas', merchantName: 'Atlas Data',
      recipient: '0x1111111111111111111111111111111111111111', item: 'Synthetic report', amountMicros: 2_000_000, feeMicros: 3_000_000 },
    policy: { task: 'Test fee incident', budgetMicros: 5_000_000, allowedMerchants: ['atlas'], expiresAt: '2026-09-28T13:00:00.000Z' },
    context: { spentMicros: 1_600_000, paidBusinessIds: ['research-1'], stopped: false, now: '2026-09-28T12:00:01.000Z' },
  };
}

const omitFees: PolicyEvaluator = (quote, policy, context) => ({
  ...evaluateProposal({ ...quote, feeMicros: 0 }, policy, context), totalMicros: quote.amountMicros + quote.feeMicros,
});

function expected(code: 'APPROVED' | 'BUDGET_EXCEEDED', totalMicros: number): Decision {
  return {
    allowed: code === 'APPROVED', code, totalMicros, reason: 'Frozen reviewed expectation.',
    checks: (['stopped', 'deadline', 'merchant', 'duplicate', 'budget'] as const).map(key => ({
      key, label: key, passed: !(key === 'budget' && code === 'BUDGET_EXCEEDED'), detail: 'Frozen check.',
    })),
  };
}

function history(): HistoricalInput {
  const source = seed();
  const first: PaymentRecord = {
    id: 'incident-1', quote: { ...source.quote, id: 'quote-1', businessId: 'research-1', amountMicros: 1_500_000, feeMicros: 100_000 },
    context: { spentMicros: 0, paidBusinessIds: [], stopped: false, now: '2026-09-28T12:00:00.000Z' },
    createdAt: '2026-09-28T12:00:00.000Z', status: 'simulated', decision: expected('APPROVED', 1_600_000),
  };
  const second: PaymentRecord = { id: 'incident-2', quote: source.quote, context: source.context,
    createdAt: source.context.now, status: 'blocked', decision: expected('BUDGET_EXCEEDED', 5_000_000) };
  return { policy: source.policy, records: [first, second] };
}

describe('deterministic synthetic boundary generation', () => {
  it('generates nine explicit contracts without changing the source incident', () => {
    const source = seed();
    const original = structuredClone(source);
    const cases = generateBoundaryCases(source);
    expect(cases).toEqual(generateBoundaryCases(source));
    expect(source).toEqual(original);
    expect(cases).toHaveLength(9);
    expect(cases.every(item => item.synthetic && item.normalization.length > 0 && item.recordId === 'incident-2')).toBe(true);
    expect(cases.map(item => [item.kind, item.expected.code])).toEqual([
      ['budget_exact', 'APPROVED'], ['budget_short_one', 'BUDGET_EXCEEDED'],
      ['deadline_before', 'APPROVED'], ['deadline_exact', 'EXPIRED'], ['deadline_after', 'EXPIRED'],
      ['recipient_changed', 'MERCHANT_NOT_ALLOWED'], ['merchant_removed', 'MERCHANT_NOT_ALLOWED'],
      ['duplicate_business', 'DUPLICATE_PAYMENT'], ['owner_stopped', 'SESSION_STOPPED'],
    ]);
    expect(runBoundaryCases(cases)).toMatchObject({ passed: true, total: 9, failed: 0, llmCalls: 0, paymentCalls: 0 });
  });

  it('includes historical spending and fees in the exact and one-micro-short budgets', () => {
    const cases = generateBoundaryCases(seed());
    expect(cases.find(item => item.kind === 'budget_exact')!.policy.budgetMicros).toBe(6_600_000);
    expect(cases.find(item => item.kind === 'budget_short_one')!.policy.budgetMicros).toBe(6_599_999);
    const smallest = seed();
    smallest.quote.amountMicros = 1; smallest.quote.feeMicros = 0; smallest.context.spentMicros = 0;
    const tiny = generateBoundaryCases(smallest);
    expect(tiny.find(item => item.kind === 'budget_short_one')!.policy.budgetMicros).toBe(0);
    expect(runBoundaryCases(tiny).passed).toBe(true);
  });

  it('uses the recorded expiry, including offsets and microseconds, rather than the wall clock', () => {
    const source = seed();
    source.policy.expiresAt = '2026-09-28T22:00:00.123456+09:00';
    const cases = generateBoundaryCases(source);
    const expiry = Date.parse(source.policy.expiresAt);
    for (const [kind, delta] of [['deadline_before', -1000], ['deadline_exact', 0], ['deadline_after', 1000]] as const) {
      expect(Date.parse(cases.find(item => item.kind === kind)!.context.now) - expiry).toBe(delta);
    }
    expect(runBoundaryCases(cases).passed).toBe(true);
  });

  it('preserves merchant identity during address substitution and tests business IDs across new quote IDs', () => {
    const source = seed();
    const cases = generateBoundaryCases(source);
    const changed = cases.find(item => item.kind === 'recipient_changed')!;
    expect(changed.quote.merchantId).toBe(source.quote.merchantId);
    expect(changed.quote.merchantName).toBe(source.quote.merchantName);
    expect(changed.quote.recipient).not.toBe(source.quote.recipient);
    const retry = cases.find(item => item.kind === 'duplicate_business')!;
    expect(retry.quote.id).not.toBe(source.quote.id);
    expect(retry.quote.businessId).toBe(source.quote.businessId);
    expect(retry.context.paidBusinessIds).toContain(source.quote.businessId);
  });

  it('discloses a normalized baseline for stopped, expired, address-replaced or duplicate source incidents', () => {
    const source = seed();
    source.context.stopped = true;
    source.context.now = '2026-09-28T14:00:00.000Z';
    source.context.paidBusinessIds.push(source.quote.businessId);
    source.policy.allowedMerchants = [];
    source.quote.recipient = '0x3333333333333333333333333333333333333333';
    const original = structuredClone(source);
    const cases = generateBoundaryCases(source);
    expect(runBoundaryCases(cases).passed).toBe(true);
    expect(source).toEqual(original);
    expect(cases[0].quote.recipient).toBe('0x1111111111111111111111111111111111111111');
    expect(cases[0].normalization.join(' ')).toContain('合成基线');
  });

  it.each([
    ['budget_short_one', omitFees],
    ['deadline_after', ((q, p, c) => evaluateProposal(q, p, { ...c, now: new Date(Date.parse(p.expiresAt) - 1000).toISOString() })) as PolicyEvaluator],
    ['recipient_changed', ((q, p, c) => evaluateProposal({ ...q, recipient: '0x1111111111111111111111111111111111111111' }, p, c)) as PolicyEvaluator],
    ['duplicate_business', ((q, p, c) => evaluateProposal(q, p, { ...c, paidBusinessIds: [] })) as PolicyEvaluator],
    ['owner_stopped', ((q, p, c) => evaluateProposal(q, p, { ...c, stopped: false })) as PolicyEvaluator],
  ])('detects a candidate that bypasses %s without deriving expectations from that candidate', (kind, evaluator) => {
    const report = runBoundaryCases(generateBoundaryCases(seed()), evaluator);
    expect(report.passed).toBe(false);
    expect(report.results.find(item => item.kind === kind)!.passed).toBe(false);
  });

  it('contains candidate mutations/exceptions and never treats empty or duplicate cases as a green suite', () => {
    const cases = generateBoundaryCases(seed());
    const original = structuredClone(cases);
    runBoundaryCases(cases, (q, p, c) => { q.amountMicros = 1; p.budgetMicros = 0; c.paidBusinessIds.push('mutation'); return evaluateProposal(q, p, c); });
    expect(cases).toEqual(original);
    const crashed = runBoundaryCases(cases, () => { throw new Error('synthetic-sensitive-error'); });
    expect(crashed.failed).toBe(9);
    expect(JSON.stringify(crashed)).not.toContain('synthetic-sensitive-error');
    expect(runBoundaryCases([]).passed).toBe(false);
    expect(runBoundaryCases([cases[0], cases[0]]).issues).toContain('Boundary case IDs must be unique.');
  });

  it('rejects unusable seeds and unsafe money rather than inventing valid-looking cases', () => {
    const bad = seed();
    bad.quote.amountMicros = Number.MAX_SAFE_INTEGER;
    expect(() => generateBoundaryCases(bad)).toThrow('safe integer');
    expect(() => generateBoundaryCases({ ...seed(), quote: { ...seed().quote, merchantId: 'unknown' } })).toThrow('demo registry');
    expect(() => generateBoundaryCases({ ...seed(), policy: { ...seed().policy, expiresAt: 'not-a-time' } })).toThrow();
  });
});

describe('source TypeScript SDK and historical regression', () => {
  it('offers evaluation, boundaries and history checks with no server or credentials', () => {
    const client = createSpendProof();
    expect(client.evaluate(seed()).code).toBe('BUDGET_EXCEEDED');
    expect(client.generateBoundaries(seed())).toHaveLength(9);
    expect(client.checkBoundaries(seed()).passed).toBe(true);
    expect(client.checkHistory(history())).toMatchObject({ passed: true, total: 2, failed: 0, llmCalls: 0, paymentCalls: 0 });
    const broken = createSpendProof(omitFees).checkHistory(history());
    expect(broken.passed).toBe(false);
    expect(broken.results[1]).toMatchObject({ expected: { code: 'BUDGET_EXCEEDED' }, actual: { code: 'APPROVED' }, passed: false });
  });

  it('uses original contexts and expectations even after an earlier candidate decision changes', () => {
    const captured = history();
    const original = structuredClone(captured);
    const observedSpent: number[] = [];
    const report = runHistoricalRegression(captured, (q, p, c) => {
      observedSpent.push(c.spentMicros);
      if (q.businessId === 'research-1') c.stopped = true;
      const result = evaluateProposal(q, p, c);
      p.budgetMicros = 0; c.paidBusinessIds.push('candidate-only');
      return result;
    });
    expect(observedSpent).toEqual([0, 1_600_000]);
    expect(report.results.map(item => item.passed)).toEqual([false, true]);
    expect(captured).toEqual(original);
  });

  it('fails for inconsistent saved history, empty input and candidate exceptions', () => {
    const captured = history();
    captured.records[1].context.spentMicros = 0;
    expect(runHistoricalRegression(captured).issues.join(' ')).toContain('prior spending');
    expect(runHistoricalRegression({ policy: seed().policy, records: [] }).passed).toBe(false);
    const report = runHistoricalRegression(history(), () => { throw new Error('synthetic-sensitive-error'); });
    expect(report.failed).toBe(2);
    expect(JSON.stringify(report)).not.toContain('synthetic-sensitive-error');
  });

  it('runs the SDK example green and returns a nonzero exit for deliberately broken fee enforcement', () => {
    const path = fileURLToPath(new URL('../examples/sdk-regression.ts', import.meta.url));
    const current = spawnSync(process.execPath, ['--import', 'tsx', path], { encoding: 'utf8', env: childTestEnv() });
    expect(current.status, current.stderr).toBe(0);
    expect(JSON.parse(current.stdout)).toMatchObject({ boundaryCases: { passed: true, total: 9 }, historicalRecords: { passed: true, total: 2 }, llmCalls: 0, paymentCalls: 0 });
    const broken = spawnSync(process.execPath, ['--import', 'tsx', path, '--unsafe-omit-fees'], { encoding: 'utf8', env: childTestEnv() });
    expect(broken.status, broken.stderr).toBe(1);
    expect(JSON.parse(broken.stdout)).toMatchObject({ boundaryCases: { passed: false }, historicalRecords: { passed: false } });
    expect(JSON.parse(broken.stdout).failedCases).toContain('budget_short_one');
  });
});
