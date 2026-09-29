import { evaluatePolicyWithRegistry } from './policy';
import { MERCHANTS } from './types';
import type { Evidence } from './types';

/** Test the current engine when provided, or replay a portable offline snapshot. */
export function generateRegressionTest(evidence: Evidence): string {
  const fixture = JSON.stringify({ policy: evidence.session.policy, records: evidence.session.records }, null, 2);
  return `// SpendProof captured payment regression tests.
// Current engine: SPENDPROOF_ENGINE=./shared/policy.ts node --import tsx --test spendproof-*.test.mjs
// Offline snapshot only: node --test spendproof-*.test.mjs
// Local simulated records only. Passing tests do not prove real payment or authorization.
// Source evidence digest: ${evidence.digest}
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// tsx/esbuild may preserve helper names in Function#toString output.
const __name = (value) => value;
const registry = ${JSON.stringify(MERCHANTS)};
const evaluateSnapshot = ${evaluatePolicyWithRegistry.toString()};
const fixture = ${fixture};

let evaluate;
if (process.env.SPENDPROOF_ENGINE !== undefined) {
  const enginePath = process.env.SPENDPROOF_ENGINE.trim();
  if (!enginePath) throw new Error('SPENDPROOF_ENGINE is set but empty. Supply a module path or unset it for snapshot replay.');
  const modulePath = resolve(enginePath);
  // Import and export errors deliberately fail the test run. Never fall back.
  const currentEngine = await import(pathToFileURL(modulePath).href);
  if (typeof currentEngine.evaluateProposal !== 'function') {
    throw new Error('SPENDPROOF_ENGINE must export evaluateProposal(quote, policy, context).');
  }
  evaluate = currentEngine.evaluateProposal;
  console.info('SpendProof mode: current engine — ' + modulePath);
} else {
  evaluate = (quote, policy, context) => evaluateSnapshot(quote, policy, context, registry);
  console.info('SpendProof mode: embedded snapshot only. Set SPENDPROOF_ENGINE to test the current implementation.');
}

test('export contains recorded payment proposals', () => {
  assert.ok(fixture.records.length > 0, 'Run a session before exporting a regression test.');
});

for (const record of fixture.records) {
  test(record.id + ': ' + record.decision.code, () => {
    const actual = evaluate(record.quote, fixture.policy, record.context);
    assert.deepEqual(actual, record.decision);
  });
}

test('recorded cumulative spend and duplicate protection remain consistent', () => {
  let spent = 0;
  const paid = [];
  let stopped = false;
  for (const record of fixture.records) {
    assert.equal(record.context.spentMicros, spent);
    assert.deepEqual([...record.context.paidBusinessIds].sort(), [...paid].sort());
    assert.ok(!stopped || record.context.stopped, 'A stopped session cannot resume.');
    stopped ||= record.context.stopped;
    const decision = evaluate(record.quote, fixture.policy, record.context);
    assert.equal(record.status, decision.allowed ? 'simulated' : 'blocked');
    if (decision.allowed) {
      spent += decision.totalMicros;
      paid.push(record.quote.businessId);
    }
  }
});
`;
}
