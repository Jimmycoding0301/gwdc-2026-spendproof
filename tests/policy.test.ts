import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEvidence, evidenceDigest, verifyEvidence } from '../shared/evidence';
import { evaluateProposal } from '../shared/policy';
import { generateRegressionTest } from '../shared/regression';
import { MERCHANTS } from '../shared/types';
import type { EvaluationContext, Evidence, PaymentRecord, Policy, Quote, Session } from '../shared/types';
import { childTestEnv } from './helpers/child-env';

const now = '2026-09-28T12:00:00.000Z';
const policy: Policy = {
  budgetMicros: 10_000_000, allowedMerchants: ['atlas'],
  expiresAt: '2026-09-28T13:00:00.000Z', task: 'Buy one research report',
};
const quote: Quote = {
  id: 'quote-1', businessId: 'report-1', merchantId: 'atlas', merchantName: 'Atlas Data',
  recipient: MERCHANTS[0].recipient, item: 'Research report', amountMicros: 6_000_000, feeMicros: 500_000,
};
const context: EvaluationContext = { spentMicros: 0, paidBusinessIds: [], stopped: false, now };

function makeRecord(q = quote, c = context, id = 'record-1'): PaymentRecord {
  const decision = evaluateProposal(q, policy, c);
  return {
    id, quote: structuredClone(q), context: structuredClone(c), decision,
    createdAt: c.now, status: decision.allowed ? 'simulated' : 'blocked',
  };
}
function makeSession(): Session {
  return {
    id: 'session-1', title: 'Report purchase', createdAt: now, policy: structuredClone(policy),
    scenario: 'normal', agentMode: 'fixture', status: 'completed',
    records: [makeRecord()], events: [], usage: [],
  };
}
function signAgain(evidence: Evidence): Evidence {
  evidence.digest = evidenceDigest(evidence);
  return evidence;
}

describe('payment authorization rules', () => {
  it('includes prior spending and fees, approving the exact boundary and rejecting one micro-USDC over', () => {
    expect(evaluateProposal(quote, policy, { ...context, spentMicros: 3_500_000 }).allowed).toBe(true);
    const blocked = evaluateProposal(quote, policy, { ...context, spentMicros: 3_500_001 });
    expect(blocked).toMatchObject({ allowed: false, code: 'BUDGET_EXCEEDED', totalMicros: 6_500_000 });
    expect(blocked.checks.find((item) => item.key === 'budget')?.passed).toBe(false);
  });

  it('binds an allowed merchant ID to its registered payment address', () => {
    expect(evaluateProposal({ ...quote, recipient: MERCHANTS[1].recipient }, policy, context).code).toBe('MERCHANT_NOT_ALLOWED');
    expect(evaluateProposal({ ...quote, merchantId: 'orbit', recipient: MERCHANTS[1].recipient }, policy, context).allowed).toBe(false);
    expect(evaluateProposal({ ...quote, merchantId: 'unregistered' }, { ...policy, allowedMerchants: ['unregistered'] }, context).allowed).toBe(false);
  });

  it('stops at the expiry instant and never substitutes the current wall clock', () => {
    expect(evaluateProposal(quote, policy, { ...context, now: policy.expiresAt }).code).toBe('EXPIRED');
    expect(evaluateProposal(quote, policy, { ...context, now: '2026-09-28T12:59:59.999Z' }).allowed).toBe(true);
    expect(evaluateProposal(quote, { ...policy, expiresAt: '2026-09-28T13:00:00.123456+00:00' }, context).allowed).toBe(true);
    expect(evaluateProposal(quote, { ...policy, expiresAt: '2026-02-30T12:00:00.000Z' }, context).code).toBe('INVALID_POLICY');
    expect(evaluateProposal(quote, policy, { ...context, now: '2026-09-28T12:00:00' }).code).toBe('INVALID_CONTEXT');
  });

  it('rejects retries of the same business request even when the quote ID changes', () => {
    const retry = { ...quote, id: 'quote-retry' };
    expect(evaluateProposal(retry, policy, { ...context, paidBusinessIds: ['report-1'] }).code).toBe('DUPLICATE_PAYMENT');
    expect(evaluateProposal(quote, policy, { ...context, stopped: true }).code).toBe('SESSION_STOPPED');
  });

  it('fails closed for nulls, non-integers, negative fees and unsafe integer sums', () => {
    for (const amount of [NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(evaluateProposal({ ...quote, amountMicros: amount }, policy, context).code).toBe('INVALID_AMOUNT');
    }
    expect(evaluateProposal({ ...quote, feeMicros: -1 }, policy, context).code).toBe('INVALID_AMOUNT');
    expect(evaluateProposal({ ...quote, amountMicros: Number.MAX_SAFE_INTEGER, feeMicros: 1 }, policy, context).code).toBe('INVALID_AMOUNT');
    expect(evaluateProposal(quote, policy, { ...context, spentMicros: Number.MAX_SAFE_INTEGER }).code).toBe('INVALID_AMOUNT');
    expect(evaluateProposal(null as unknown as Quote, policy, context).code).toBe('INVALID_QUOTE');
    expect(evaluateProposal(quote, null as unknown as Policy, context).code).toBe('INVALID_POLICY');
    expect(evaluateProposal(quote, policy, null as unknown as EvaluationContext).code).toBe('INVALID_CONTEXT');
  });

  it('replays changed policies without modifying original proposals, contexts or records', () => {
    const session = makeSession();
    const snapshot = JSON.stringify(session);
    const { quote: q, context: c } = session.records[0];
    expect(evaluateProposal(q, { ...session.policy, budgetMicros: 1_000_000 }, c).allowed).toBe(false);
    expect(evaluateProposal(q, session.policy, c).allowed).toBe(true);
    expect(JSON.stringify(session)).toBe(snapshot);
  });
});

describe('portable evidence verification', () => {
  it('snapshots the source and validates a successful purchase followed by a blocked duplicate', () => {
    const session = makeSession();
    session.records.push(makeRecord({ ...quote, id: 'quote-2' }, {
      ...context, spentMicros: 6_500_000, paidBusinessIds: ['report-1'], now: '2026-09-28T12:00:01.000Z',
    }, 'record-2'));
    const evidence = createEvidence(session, '2026-09-28T12:00:02.000Z');
    expect(verifyEvidence(evidence).valid).toBe(true);
    session.records[0].quote.feeMicros = 9_000_000;
    expect(evidence.session.records[0].quote.feeMicros).toBe(500_000);
    const reordered = { exportedAt: evidence.exportedAt, digest: evidence.digest, session: evidence.session, version: evidence.version };
    expect(verifyEvidence(reordered).valid).toBe(true);
  });

  it('detects content tampering and decision forgery even when the forger recomputes the digest', () => {
    const evidence = createEvidence(makeSession(), now);
    evidence.session.records[0].quote.feeMicros = 5_000_000;
    expect(verifyEvidence(evidence).digestMatches).toBe(false);
    const forged = verifyEvidence(signAgain(evidence));
    expect(forged.digestMatches).toBe(true);
    expect(forged.valid).toBe(false);
    expect(forged.checks.find((item) => item.key === 'decisions')?.passed).toBe(false);
  });

  it('rejects a forged accumulated-spend context despite an internally matching decision and fresh digest', () => {
    const session = makeSession();
    session.records.push(makeRecord({ ...quote, id: 'quote-2', businessId: 'report-2' }, {
      ...context, now: '2026-09-28T12:00:01.000Z',
    }, 'record-2'));
    const result = verifyEvidence(createEvidence(session, '2026-09-28T12:00:02.000Z'));
    expect(result.digestMatches).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toContain('prior spending');
    expect(result.issues.join(' ')).toContain('prior business IDs');
  });

  it('rejects a resumed stopped context and fake transaction hashes on simulated payments', () => {
    const session = makeSession();
    session.records = [makeRecord(quote, { ...context, stopped: true }),
      makeRecord(quote, { ...context, now: '2026-09-28T12:00:01.000Z' }, 'record-2')];
    expect(verifyEvidence(createEvidence(session, '2026-09-28T12:00:02.000Z')).valid).toBe(false);
    const normal = makeSession();
    normal.records[0].txHash = `0x${'a'.repeat(64)}`;
    expect(verifyEvidence(createEvidence(normal, now)).valid).toBe(false);
    expect(verifyEvidence(null).valid).toBe(false);
  });

  it('exports executable tests using the real rule code, and the tests fail on changed captured input', () => {
    const evidence = createEvidence(makeSession(), now);
    const directory = mkdtempSync(join(tmpdir(), 'spendproof-test-'));
    const path = join(directory, 'regression.mjs');
    try {
      writeFileSync(path, generateRegressionTest(evidence));
      expect(() => execFileSync(process.execPath, ['--test', path], { stdio: 'pipe', env: childTestEnv() })).not.toThrow();
      evidence.session.records[0].quote.feeMicros = 10_000_000;
      writeFileSync(path, generateRegressionTest(evidence));
      const result = spawnSync(process.execPath, ['--test', path], { encoding: 'utf8', env: childTestEnv() });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain('not ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs exported regressions against the current TypeScript engine and fails for a broken or missing engine', () => {
    const directory = mkdtempSync(join(tmpdir(), 'spendproof-engine-test-'));
    const path = join(directory, 'regression.test.mjs');
    try {
      writeFileSync(path, generateRegressionTest(createEvidence(makeSession(), now)));
      const current = execFileSync(process.execPath, ['--import', 'tsx', '--test', path], {
        encoding: 'utf8', env: childTestEnv({ SPENDPROOF_ENGINE: './shared/policy.ts' }),
      });
      expect(current).toContain('SpendProof mode: current engine');

      const brokenPath = join(directory, 'broken-engine.mjs');
      writeFileSync(brokenPath, 'export function evaluateProposal() { return { allowed: false, code: "BROKEN", totalMicros: 0 }; }');
      const broken = spawnSync(process.execPath, ['--test', path], {
        encoding: 'utf8', env: childTestEnv({ SPENDPROOF_ENGINE: brokenPath }),
      });
      expect(broken.status).not.toBe(0);
      expect(broken.stdout).toContain('SpendProof mode: current engine');
      expect(broken.stdout).toContain('not ok');

      const missing = spawnSync(process.execPath, ['--test', path], {
        encoding: 'utf8', env: childTestEnv({ SPENDPROOF_ENGINE: join(directory, 'missing-engine.mjs') }),
      });
      expect(missing.status).not.toBe(0);
      expect(missing.stdout + missing.stderr).toContain('ERR_MODULE_NOT_FOUND');
      expect(missing.stdout + missing.stderr).not.toContain('SpendProof mode: embedded snapshot');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
