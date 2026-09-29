import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app } from '../../server/app.js';
import { initializeStore, persistSessions } from '../../server/store.js';
import type { Session } from '../../shared/types.js';
import { syntheticSecrets } from '../helpers/synthetic-secrets.js';

const mode = process.argv[2];
const secrets = Object.values(syntheticSecrets);
const reflected = secrets.join(' / ');
const assertClean = (text: string) => {
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'Synthetic credential escaped its server-only boundary.');
};

// Only explicitly injected fake values may reach this child; no .env is loaded.
for (const [name, expected] of Object.entries(syntheticSecrets)) assert.equal(process.env[name], expected);
assert.equal(process.env.ENABLE_TESTNET_ANCHOR, 'false');
const nativeFetch = globalThis.fetch;
let modelCalls = 0;
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'http://127.0.0.1:9/chat/completions');
  assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${syntheticSecrets.KILN_API_KEY}`);
  modelCalls++;
  if (mode === 'network-error') throw new Error(`Synthetic transport failure: ${reflected}`);
  if (mode === 'http-error') return new Response(reflected, { status: 401 });
  if (mode === 'malformed') return new Response(`invalid json ${reflected}`, { status: 200 });
  if (mode === 'body-error') return new Response(new ReadableStream({
    start(controller) { controller.error(new Error(`Synthetic body failure: ${reflected}`)); },
  }), { status: 200 });
  assert.ok(mode === 'success' || mode === 'model-reflection');
  const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
  const toolResult = [...body.messages].reverse().find(message => message.role === 'tool');
  const quoteId = toolResult ? JSON.parse(toolResult.content).quotes[0].id : undefined;
  return Response.json({
    model: mode === 'model-reflection' ? syntheticSecrets.KILN_API_KEY : 'synthetic-test-model', usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: {
      // Even a provider that reflects credentials in free text must not persist it.
      content: reflected,
      tool_calls: [{ id: `synthetic-call-${modelCalls}`, type: 'function', function: {
        name: quoteId ? 'propose_purchase' : 'get_quotes',
        arguments: quoteId ? JSON.stringify({ quoteId }) : '{}',
      } }],
    } }],
  });
};

await initializeStore();
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const address = server.address();
assert.ok(address && typeof address === 'object');
const port = address.port;
async function request(path: string, body?: unknown) {
  // node:http preserves the expected Host while the test uses an ephemeral port.
  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: '127.0.0.1:8787', 'Content-Type': 'application/json' },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const text = response.text;
  assertClean(text);
  assert.ok(response.status >= 200 && response.status < 300, `Unexpected API status ${response.status}.`);
  return text;
}

try {
  const health = JSON.parse(await request('/health'));
  assert.equal(health.kilnConfigured, true);
  assert.equal(health.anchorConfigured, false);
  const created = JSON.parse(await request('/sessions', {
    policy: { budgetMicros: 5_000_000, allowedMerchants: ['atlas', 'orbit'], expiresAt: new Date(Date.now() + 60_000).toISOString(), task: 'Run synthetic credential boundary test' },
    scenario: 'normal', agentMode: 'kiln',
  })) as Session;
  await request(`/sessions/${created.id}/run`, {});
  let session: Session = created;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    session = JSON.parse(await request(`/sessions/${created.id}`)) as Session;
    if (['completed', 'error'].includes(session.status)) break;
    await delay(25);
  }
  const completes = mode === 'success' || mode === 'model-reflection';
  assert.equal(session.status, completes ? 'completed' : 'error');
  assert.equal(session.records.length, completes ? 2 : 0);
  assert.equal(modelCalls, completes ? 4 : 1);
  if (mode === 'model-reflection') assert.ok(session.usage.every(usage => usage.model === 'model-name-hidden'));
  await request('/sessions');
  const evidence = JSON.parse(await request(`/sessions/${created.id}/evidence`));
  assert.equal(evidence.session.id, created.id);
  await request(`/sessions/${created.id}/regression`);
  await persistSessions();
  for (const file of await readdir('.data')) assertClean(await readFile(join('.data', file), 'utf8'));
  process.stdout.write(`Synthetic secret checks passed: ${mode}\n`);
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  globalThis.fetch = nativeFetch;
}
