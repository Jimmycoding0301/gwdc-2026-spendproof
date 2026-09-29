# SpendProof TypeScript SDK

This source-level SDK evaluates local spending rules, derives synthetic boundary cases from a captured proposal, and checks a candidate rule engine against saved incidents. It has no browser, server, wallet, credential or model dependency. It is part of this repository, not a published npm package.

Run from the repository root with Node 22+:

```sh
npm ci
node --import tsx examples/sdk-regression.ts
```

The reviewed example checks 9 generated boundary cases and 2 historical records. A successful run exits 0. To demonstrate a broken candidate that excludes fees from budget enforcement:

```sh
node --import tsx examples/sdk-regression.ts --unsafe-omit-fees
```

That command intentionally exits 1: a budget that is one micro-USDC short is incorrectly allowed, and a saved fee incident no longer reproduces. No model requests, payments, or chain transactions occur. Do not use this deliberately broken candidate for execution.

## Integration

```ts
import { createSpendProof } from './sdk/index';
import type { BoundarySeed, HistoricalInput } from './sdk/index';

const proof = createSpendProof();

function inspectProposal(input: BoundarySeed) {
  const decision = proof.evaluate(input);
  const boundaryReport = proof.checkBoundaries(input);
  return { decision, boundaryReport };
}

function verifyRuleChange(captured: HistoricalInput) {
  const report = proof.checkHistory(captured);
  if (!report.passed) process.exitCode = 1;
  return report;
}
```

`BoundarySeed` contains `{quote, policy, context, recordId?}`. A complete example with integer amounts, timestamps, merchant addresses and reviewed history lives in [`examples/sdk-regression.ts`](../examples/sdk-regression.ts). Copy or import these source modules in a TypeScript project; the generator's runtime validation uses the repository's `zod` dependency.

| API | Purpose |
| --- | --- |
| `createSpendProof(evaluator?)` | Bind a trusted synchronous rule evaluator; defaults to the current `evaluateProposal`. |
| `client.evaluate(seed)` | Return a rule decision; it never executes or records a payment. |
| `client.generateBoundaries(seed)` | Derive deterministic synthetic inputs and explicit expected outcomes. |
| `client.checkBoundaries(seed)` | Generate and run those cases against the bound evaluator. |
| `client.checkHistory({policy, records})` | Compare saved decisions with candidate results at their original contexts. |
| `runBoundaryCases(cases, evaluator?)` | Run previously generated, reviewable boundary contracts. |
| `runHistoricalRegression(history, evaluator?)` | Standalone historical regression function. |

Inputs are cloned before passing them to an evaluator, so a candidate cannot mutate the saved case or the next case's context through its arguments. Candidate exceptions fail the report and use a fixed error message. Empty suites and duplicate boundary IDs are not reported as passing. The built-in methods do not initiate external calls; custom evaluators must be trusted pure code. This SDK is not a sandbox for arbitrary third-party JavaScript.

## Generated contracts

The generator preserves captured item amount, fees, merchant name/ID and prior spending, then creates a **synthetic allowed baseline**. It restores the registered address, allows that merchant, sets the exact required budget, moves time to one second before expiry, and clears the current business ID's duplicate mark and stop state. Every generated case carries `synthetic: true` and a `normalization` explanation. The original incident is untouched.

| Case | Independent expected result |
| --- | --- |
| Prior spending + item + fee exactly equals budget | `APPROVED` |
| Budget is 1 micro-USDC below that total | `BUDGET_EXCEEDED` |
| One second before expiry | `APPROVED` |
| Exactly at expiry / one second after expiry | `EXPIRED` |
| Same merchant name and ID, different recipient | `MERCHANT_NOT_ALLOWED` |
| Registered merchant removed from authorization | `MERCHANT_NOT_ALLOWED` |
| Already paid business ID submitted with a new quote ID | `DUPLICATE_PAYMENT` |
| Owner has stopped the session | `SESSION_STOPPED` |

Expectations are explicit contracts, not calculated by the candidate evaluator. Cases compare the allowed flag, code, total including fees, and each relevant check result. Invalid timestamps, unknown demo merchants and unsafe integer sums are rejected. Supported deadline inputs include UTC offsets and fractional seconds; the underlying rule engine compares JavaScript millisecond timestamps.

These finite boundary checks are not exhaustive fuzzing or a proof of financial safety. They are synthesized tests, not new user authorizations, original transaction evidence, or proof that payment occurred. Amounts use integer micro-USDC; 1 micro-USDC = 0.000001 USDC.

## Historical regression is different from policy replay

Historical regression compares a candidate against **saved expected decisions** using each record's original policy and context. Candidate outcomes never update the next case's cumulative balance. It also checks the recorded ledger's cumulative spending, business IDs, stop continuity, chronological order and simulation statuses. Provide the complete captured session, starting with zero prior spending.

Comparison covers allowed/code/total/check results, while allowing harmless changes to explanatory text. Do not regenerate expectations from the candidate or overwrite history to make CI green. If product policy intentionally changes, review and version the expected change separately. Use the application's counterfactual replay for a new policy's hypothetical cumulative outcome.

This SDK does not verify an evidence digest, identity, signature or chain receipt. Use the application's separate evidence verifier for the exported envelope's consistency, and independently compare trusted signatures or chain anchors when available. The built-in merchant registry still contains only `atlas` and `orbit` demo addresses; it is not a production merchant directory.

## CI

[`.github/workflows/spendproof-regression.yml`](../.github/workflows/spendproof-regression.yml) installs locked dependencies, runs all root tests, type-checks the project and SDK example, runs the example, and performs a production build without loading `.env`. Tests include the deliberately broken candidate and require its nonzero exit. The workflow requests read-only repository permissions, disables persistent checkout credentials, and does not inject integration secrets.

The workflow runs after the code is committed and pushed to GitHub, or can be manually dispatched there. A local pass is not a claim that GitHub Actions has already run. Workflow actions are pinned to verified commit SHAs; their setup follows the official [checkout](https://github.com/actions/checkout) and [setup-node](https://github.com/actions/setup-node) documentation.

The SDK has no payment executor or atomic wallet ledger. A future real payment integration must enforce authorization at its own commit boundary, handle settlement results and deduplication, and protect private keys independently. A returned `allowed: true` only describes the checked input and context.
