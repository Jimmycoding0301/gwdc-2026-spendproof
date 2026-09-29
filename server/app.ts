import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Evidence, EvaluationContext, Policy, Session } from '../shared/types.js';
import { evaluateProposal } from '../shared/policy.js';
import { createEvidence, verifyEvidence } from '../shared/evidence.js';
import { generateRegressionTest } from '../shared/regression.js';
import { generateBoundaryCases, runBoundaryCases } from '../shared/boundaries.js';
import { createImpactDemoScenarios, evaluateRedGreen, evaluateRuleImpact } from '../shared/impact.js';
import { config, anchorConfigured } from './config.js';
import { getSession, listSessions, persistEvidence, persistReceipt, persistSessions, putSession, readReceipt } from './store.js';
import { addEvent, hasActiveRun, startRun, stopRun } from './runner.js';
import { anchorEvidence, getAnchorAccount, getStoredAnchor } from './anchor.js';
import { createSessionReceipt } from './receipt.js';
import { AuthorizationExtractionError, extractAuthorization } from './authorization.js';

const micros = z.number().int().safe().nonnegative().max(1_000_000_000_000);
const allowedMerchants = z.array(z.enum(['atlas', 'orbit'])).max(2).refine(items => new Set(items).size === items.length, 'Duplicate merchant IDs are not allowed.');
const policySchema = z.object({ budgetMicros: micros, allowedMerchants, expiresAt: z.iso.datetime({ offset: true }), task: z.string().trim().min(1).max(2000) }).strict();
const createSchema = z.object({ policy: policySchema, scenario: z.enum(['normal', 'fees', 'merchant', 'duplicate']), agentMode: z.enum(['fixture', 'kiln']) }).strict();
const replaySchema = z.object({ budgetMicros: micros, allowedMerchants: allowedMerchants.optional(), expiresAt: z.iso.datetime({ offset: true }).optional() }).strict();
const boundarySchema = z.object({ recordId: z.string().min(1).max(200).optional() }).strict();
const impactSchema = z.object({ candidate: z.enum(['current', 'correct', 'ignore-fees']).optional() }).strict();
const receiptDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const app = express();
app.disable('x-powered-by');
app.use((request, response, next) => {
  // Bind to loopback and reject unexpected Host/Origin values, including DNS rebinding.
  const host = request.get('host') || '';
  if (!/^(localhost|127\.0\.0\.1):(8787|5173)$/.test(host)) return response.status(403).json({ error: 'Local host only.' });
  const origin = request.get('origin');
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):(5173|8787)$/.test(origin)) return response.status(403).json({ error: 'Origin is not allowed.' });
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '2mb', strict: false }));

function sessionFor(id: string, response: express.Response): Session | undefined {
  if (!z.string().uuid().safeParse(id).success) { response.status(400).json({ error: 'Invalid session ID.' }); return; }
  const session = getSession(id);
  if (!session) { response.status(404).json({ error: 'Session not found.' }); return; }
  return session;
}

async function evidenceFor(session: Session): Promise<Evidence> {
  // A repeat export of the same snapshot is byte-stable, including its timestamp.
  const snapshot = structuredClone(session);
  const exportedAt = snapshot.events.at(-1)?.at || snapshot.createdAt;
  const evidence = createEvidence(snapshot, exportedAt);
  await persistEvidence(evidence);
  return evidence;
}

app.get('/api/health', (_request, response) => response.json({ kilnConfigured: Boolean(config.kilnApiKey), model: config.kilnModel, anchorConfigured: anchorConfigured(), paymentMode: 'simulation', chainId: 84532 }));
app.post('/api/authorization/extract', async (request, response) => {
  try {
    response.json(await extractAuthorization(request.body, { protectedValues: [config.kilnApiKey, config.testnetPrivateKey] }));
  } catch (error) {
    if (error instanceof AuthorizationExtractionError) return response.status(error.status).json({ error: error.message, code: error.code });
    response.status(422).json({ error: '本地无法识别这张图片，请换用清晰截图或手动填写授权。', code: 'OCR_FAILED' });
  }
});
app.get('/api/anchor/account', async (_request, response) => {
  try { response.json(await getAnchorAccount()); }
  catch { response.status(502).json({ error: 'Could not read the Base Sepolia RPC. Check the configured endpoint and chain ID.' }); }
});
app.get('/api/sessions', (_request, response) => response.json(listSessions()));
app.post('/api/impact', (request, response) => {
  const input = impactSchema.parse(request.body);
  const history = listSessions().filter(session => session.records.length > 0);
  const scenarios = history.length > 0 ? history : createImpactDemoScenarios();
  const source = history.length > 0 ? 'history' : 'fixture';
  response.json(input.candidate
    ? { source, report: evaluateRuleImpact(scenarios, input.candidate) }
    : { source, ...evaluateRedGreen(scenarios) });
});
app.post('/api/sessions', async (request, response) => {
  const input = createSchema.parse(request.body);
  if (input.agentMode === 'kiln' && !config.kilnApiKey) return response.status(409).json({ error: 'KILN_API_KEY is not configured. Select fixture mode or configure the server.' });
  const session: Session = {
    id: randomUUID(), title: input.policy.task.slice(0, 72), createdAt: new Date().toISOString(),
    policy: input.policy, scenario: input.scenario, agentMode: input.agentMode,
    status: 'ready', records: [], events: [], usage: [],
  };
  addEvent(session, 'created', '会话已创建', '预算与授权仅适用于本会话。报价和付款为模拟；无真实商家或USDC转账。');
  putSession(session);
  await persistSessions();
  response.status(201).json(session);
});
app.get('/api/sessions/:id', (request, response) => { const session = sessionFor(request.params.id, response); if (session) response.json(session); });
app.post('/api/sessions/:id/run', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  if (session.status !== 'ready' || hasActiveRun(session.id)) return response.status(409).json({ error: 'A session can run only once; create a new session for another run.' });
  if (session.agentMode === 'kiln' && !config.kilnApiKey) return response.status(409).json({ error: 'Kiln is not configured.' });
  await startRun(session);
  response.status(202).json(session);
});
app.post('/api/sessions/:id/stop', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  await stopRun(session);
  response.json(session);
});
app.post('/api/sessions/:id/replay', (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  const input = replaySchema.parse(request.body);
  const policy: Policy = { ...session.policy, ...input };
  const context: EvaluationContext = { spentMicros: 0, paidBusinessIds: [], stopped: false, now: session.createdAt };
  const results = session.records.map(record => {
    context.now = record.context.now;
    context.stopped = record.context.stopped;
    const replayed = evaluateProposal(record.quote, policy, structuredClone(context));
    if (replayed.allowed) { context.spentMicros += replayed.totalMicros; context.paidBusinessIds.push(record.quote.businessId); }
    return { recordId: record.id, original: record.decision, replayed };
  });
  response.json({ results, llmCalls: 0, paymentCalls: 0, replayedSpentMicros: context.spentMicros, scope: 'Recorded proposals only; does not predict how the model would change its plan.' });
});
app.get('/api/sessions/:id/evidence', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  response.setHeader('Content-Disposition', `attachment; filename="spendproof-${session.id}.json"`);
  response.json(await evidenceFor(session));
});
app.post('/api/verify', (request, response) => response.json(verifyEvidence(request.body)));
app.get('/api/sessions/:id/regression', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  const evidence = await evidenceFor(session);
  response.type('text/javascript').setHeader('Content-Disposition', `attachment; filename="spendproof-${session.id}.test.mjs"`);
  response.send(generateRegressionTest(evidence));
});
app.post('/api/sessions/:id/boundaries', (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  const input = boundarySchema.parse(request.body);
  const source = input.recordId
    ? session.records.find(record => record.id === input.recordId)
    : session.records.find(record => !record.decision.allowed) ?? session.records[0];
  if (input.recordId && !source) return response.status(404).json({ error: 'Source proposal not found.' });
  if (!source) return response.status(409).json({ error: 'This session has no proposal to turn into boundary cases.' });
  try {
    const cases = generateBoundaryCases({ quote: source.quote, policy: session.policy, context: source.context, recordId: source.id });
    response.json({ sourceRecordId: source.id, cases, report: runBoundaryCases(cases) });
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : 'Boundary generation failed.' });
  }
});
app.get('/api/sessions/:id/receipt', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  const requestedDigest = request.query.digest === undefined ? undefined : receiptDigestSchema.parse(request.query.digest);
  try {
    if (requestedDigest) {
      const cached = await readReceipt(session.id, requestedDigest);
      if (cached) return response.json(cached);
    }
    const receipt = await createSessionReceipt(session);
    await persistReceipt(session.id, receipt);
    if (requestedDigest && receipt.digest !== requestedDigest) {
      return response.status(409).json({ error: 'This receipt snapshot changed after the link was created and the requested fixed snapshot is unavailable.' });
    }
    response.json(receipt);
  }
  catch (error) { response.status(409).json({ error: error instanceof Error ? error.message : 'Receipt generation failed.' }); }
});
app.get('/api/sessions/:id/anchor', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  try { response.json({ anchor: await getStoredAnchor(session.id) ?? null }); }
  catch { response.status(502).json({ error: 'Could not verify this anchor against Base Sepolia.' }); }
});
app.post('/api/sessions/:id/anchor', async (request, response) => {
  const session = sessionFor(request.params.id, response); if (!session) return;
  if (!['completed', 'stopped', 'error'].includes(session.status) || hasActiveRun(session.id)) return response.status(409).json({ error: 'Finish or stop this run before anchoring its stable evidence.' });
  if (!anchorConfigured()) return response.status(409).json({ error: 'Testnet anchoring is not configured. No transaction was sent.' });
  const evidence = await evidenceFor(session);
  const verified = verifyEvidence(evidence);
  if (!verified.valid) return response.status(409).json({ error: 'Evidence verification failed. No transaction was sent.', verification: verified });
  try { response.json(await anchorEvidence(evidence)); }
  catch (error) {
    const message = error instanceof Error && /Fund 0x[0-9a-fA-F]{40}/.test(error.message)
      ? error.message
      : 'Testnet anchoring failed. Check RPC chain ID 84532, test ETH balance, and testnet configuration. No merchant payment is implemented.';
    response.status(502).json({ error: message });
  }
});
app.use('/api', (_request, response) => response.status(404).json({ error: 'Unknown API route.' }));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return response.status(400).json({ error: 'Invalid request.', issues: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return response.status(413).json({ error: 'Request body too large.' });
  if (error instanceof SyntaxError) return response.status(400).json({ error: 'Malformed JSON.' });
  console.error('API request failed. No credentials or request bodies are logged.');
  response.status(500).json({ error: 'The local server could not complete this request.' });
});
