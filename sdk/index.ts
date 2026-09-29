import { evaluateProposal } from '../shared/policy';
import { generateBoundaryCases, runBoundaryCases } from '../shared/boundaries';
import type { BoundarySeed, PolicyEvaluator } from '../shared/boundaries';
import type { Decision, PaymentRecord, Policy } from '../shared/types';

export { evaluateProposal, generateBoundaryCases, runBoundaryCases };
export type { BoundarySeed, BoundaryCase, BoundaryExpectation, BoundaryKind, BoundaryReport, BoundaryResult, PolicyEvaluator } from '../shared/boundaries';
export type { Decision, EvaluationContext, PaymentRecord, Policy, Quote } from '../shared/types';

export interface HistoricalInput { policy: Policy; records: readonly PaymentRecord[] }
export interface HistoricalResult { recordId: string; expected: Decision; actual: Decision | null; passed: boolean; error?: string }
export interface HistoricalReport {
  passed: boolean;
  total: number;
  failed: number;
  results: HistoricalResult[];
  issues: string[];
  /** Calls initiated by this SDK. Custom evaluators must be trusted pure code. */
  llmCalls: 0;
  paymentCalls: 0;
}

function equivalent(actual: Decision, expected: Decision): boolean {
  if (actual.allowed !== expected.allowed || actual.code !== expected.code || actual.totalMicros !== expected.totalMicros) return false;
  if (actual.checks.length !== expected.checks.length) return false;
  const actualChecks = new Map(actual.checks.map(check => [check.key, check.passed]));
  const expectedChecks = new Map(expected.checks.map(check => [check.key, check.passed]));
  return actualChecks.size === actual.checks.length && expectedChecks.size === expected.checks.length
    && [...expectedChecks].every(([key, passed]) => actualChecks.get(key) === passed);
}

/**
 * Replay each historical input against its saved decision, without rewriting
 * expectations or accumulating a candidate's hypothetical decisions. Validate
 * saved context continuity separately. This is not signature/digest verification.
 */
export function runHistoricalRegression(history: HistoricalInput, evaluator: PolicyEvaluator = evaluateProposal): HistoricalReport {
  const issues: string[] = history.records.length ? [] : ['No historical records were supplied.'];
  const ids = new Set<string>();
  const paid = new Set<string>();
  let spent = 0;
  let stopped = false;
  let previousTime = -Infinity;
  const results = history.records.map((record): HistoricalResult => {
    if (ids.has(record.id)) issues.push(`Record ${record.id}: duplicate record ID.`);
    ids.add(record.id);
    const context = record.context;
    const expected = structuredClone(record.decision);
    if (context.spentMicros !== spent) issues.push(`Record ${record.id}: prior spending differs from saved history.`);
    if (context.paidBusinessIds.length !== paid.size || new Set(context.paidBusinessIds).size !== paid.size
      || context.paidBusinessIds.some(id => !paid.has(id))) issues.push(`Record ${record.id}: prior business IDs differ from saved history.`);
    if (stopped && !context.stopped) issues.push(`Record ${record.id}: stopped history was resumed.`);
    stopped ||= context.stopped;
    const time = Date.parse(record.createdAt);
    if (!Number.isFinite(time) || time < previousTime || record.createdAt !== context.now) issues.push(`Record ${record.id}: inconsistent recorded time.`);
    previousTime = time;
    if (record.status !== (expected.allowed ? 'simulated' : 'blocked') || record.txHash !== undefined) {
      issues.push(`Record ${record.id}: status must match its decision and must not claim a payment transaction.`);
    }
    // The saved ledger defines each case's context. Candidate outputs never change it.
    if (expected.allowed) {
      spent += expected.totalMicros;
      if (!Number.isSafeInteger(spent) || spent < 0 || paid.has(record.quote.businessId)) issues.push(`Record ${record.id}: invalid saved ledger.`);
      paid.add(record.quote.businessId);
    }
    try {
      const actual = structuredClone(evaluator(structuredClone(record.quote), structuredClone(history.policy), structuredClone(context)));
      return { recordId: record.id, expected, actual, passed: equivalent(actual, expected) };
    } catch {
      return { recordId: record.id, expected, actual: null, passed: false, error: 'Candidate evaluator failed to return a usable decision.' };
    }
  });
  const failed = results.filter(result => !result.passed).length;
  return { passed: failed === 0 && issues.length === 0, total: results.length, failed, results, issues, llmCalls: 0, paymentCalls: 0 };
}

/** Source-level SDK for Node/TypeScript projects; no server, wallet, env or browser dependency. */
export function createSpendProof(evaluator: PolicyEvaluator = evaluateProposal) {
  return {
    evaluate(input: BoundarySeed): Decision {
      return evaluator(structuredClone(input.quote), structuredClone(input.policy), structuredClone(input.context));
    },
    generateBoundaries: generateBoundaryCases,
    checkBoundaries(input: BoundarySeed) { return runBoundaryCases(generateBoundaryCases(input), evaluator); },
    checkHistory(history: HistoricalInput) { return runHistoricalRegression(history, evaluator); },
  };
}
