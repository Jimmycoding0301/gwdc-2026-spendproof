import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  extract: vi.fn(), startRun: vi.fn(), stopRun: vi.fn(), addEvent: vi.fn(),
  putSession: vi.fn(), persistSessions: vi.fn(), persistEvidence: vi.fn(), persistReceipt: vi.fn(),
  anchorEvidence: vi.fn(), getAnchorAccount: vi.fn(), getStoredAnchor: vi.fn(),
}));
vi.mock('../server/authorization.js', async importOriginal => ({
  ...await importOriginal<typeof import('../server/authorization')>(), extractAuthorization: mocks.extract,
}));
vi.mock('../server/config.js', () => ({
  config: { kilnApiKey: 'synthetic-kiln-test-only', testnetPrivateKey: 'synthetic-testnet-test-only', kilnModel: 'qwen3-32b' },
  anchorConfigured: () => false,
}));
vi.mock('../server/runner.js', () => ({ startRun: mocks.startRun, stopRun: mocks.stopRun, addEvent: mocks.addEvent, hasActiveRun: () => false }));
vi.mock('../server/store.js', () => ({
  putSession: mocks.putSession, persistSessions: mocks.persistSessions,
  persistEvidence: mocks.persistEvidence, persistReceipt: mocks.persistReceipt,
  getSession: vi.fn(), listSessions: () => [], readReceipt: vi.fn(),
}));
vi.mock('../server/anchor.js', () => ({ anchorEvidence: mocks.anchorEvidence, getAnchorAccount: mocks.getAnchorAccount, getStoredAnchor: mocks.getStoredAnchor }));
vi.mock('../server/receipt.js', () => ({ createSessionReceipt: vi.fn() }));
import { AuthorizationExtractionError } from '../server/authorization';
import { app } from '../server/app';

let server: Server;
let port: number;
const draft = {
  draft: { task: 'Research only', budgetMicros: 5_000_000 },
  fields: [{ key: 'budgetMicros', label: '预算', value: '5 USDC', confidence: 'high' }],
  warnings: ['确认后仅填入表单，不创建任务、不调用模型、不付款。'], source: 'local-ocr',
};
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral localhost test server.');
  port = address.port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.extract.mockResolvedValue(draft);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Screenshot route must not call an external provider.'); }));
});
afterEach(() => {
  for (const sideEffect of [mocks.startRun, mocks.stopRun, mocks.addEvent, mocks.putSession,
    mocks.persistSessions, mocks.persistEvidence, mocks.persistReceipt,
    mocks.anchorEvidence, mocks.getAnchorAccount, mocks.getStoredAnchor]) {
    expect(sideEffect).not.toHaveBeenCalled();
  }
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function request(body: string, headers: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/authorization/extract', method: 'POST',
      headers: { Host: '127.0.0.1:8787', 'Content-Type': 'application/json', ...headers },
    }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, text, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(body);
  });
}

describe('screenshot route isolation (local HTTP and mocked OCR only)', () => {
  it('runs the actual image validator and field parser through HTTP, while keeping only the native OCR worker stubbed', async () => {
    const { extractAuthorization } = await vi.importActual<typeof import('../server/authorization')>('../server/authorization');
    const ocr = vi.fn(async () => [
      { text: '任务: 购买研究资料', confidence: 0.98 },
      { text: '预算: 5 USDC', confidence: 0.95 },
      { text: '有效期: 15 分钟', confidence: 0.95 },
      { text: '商户: Atlas Data', confidence: 0.96 },
    ]);
    mocks.extract.mockImplementation((body, options) => extractAuthorization(body, { ...options, ocr }));
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
    const response = await request(JSON.stringify({ imageDataUrl }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({ source: 'local-ocr', draft: {
      task: '购买研究资料', budgetMicros: 5_000_000, durationMinutes: 15, allowedMerchants: ['atlas'],
    } });
    expect(ocr).toHaveBeenCalledOnce();
    expect(response.text).not.toContain(imageDataUrl);
  });

  it('rejects spoofed image bytes at the real HTTP endpoint before the OCR worker', async () => {
    const { extractAuthorization } = await vi.importActual<typeof import('../server/authorization')>('../server/authorization');
    const ocr = vi.fn(async () => []);
    mocks.extract.mockImplementation((body, options) => extractAuthorization(body, { ...options, ocr }));
    const imageDataUrl = `data:image/png;base64,${Buffer.from('<script>not an image</script>').toString('base64')}`;
    const response = await request(JSON.stringify({ imageDataUrl }));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ code: 'INVALID_IMAGE' });
    expect(ocr).not.toHaveBeenCalled();
    expect(response.text).not.toContain('script');
  });

  it('returns a no-store draft and passes secret protection server-side without creating any authority or session', async () => {
    const response = await request(JSON.stringify({ imageDataUrl: 'synthetic-image-input' }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual(draft);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mocks.extract).toHaveBeenCalledWith({ imageDataUrl: 'synthetic-image-input' }, {
      protectedValues: ['synthetic-kiln-test-only', 'synthetic-testnet-test-only'],
    });
    expect(response.text).not.toContain('synthetic-kiln');
    expect(response.text).not.toContain('synthetic-testnet');
  });

  it.each([
    { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Host: 'evil.invalid:8787' },
  ])('rejects hostile browser origins and hosts before invoking OCR: %#', async headers => {
    const response = await request('{}', headers);
    expect(response.status).toBe(403);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without echoing raw request content', async () => {
    const response = await request('{"imageDataUrl":"synthetic-private-unclosed-input');
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('synthetic-private');
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('rejects an oversized JSON request before calling OCR', async () => {
    const response = await request(JSON.stringify({ imageDataUrl: 'x'.repeat(2 * 1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('returns only the fixed worker error and never falls back to a fixture draft', async () => {
    mocks.extract.mockRejectedValueOnce(new Error('synthetic-private-image-text-and-secret'));
    const response = await request('{}');
    expect(response.status).toBe(422);
    expect(JSON.parse(response.text)).toMatchObject({ code: 'OCR_FAILED' });
    expect(response.text).not.toContain('synthetic-private');
    expect(response.text).not.toContain('demo-fixture');
    expect(JSON.parse(response.text)).not.toHaveProperty('draft');
  });

  it.each([
    ['IMAGE_TOO_LARGE', 413], ['OCR_UNAVAILABLE', 503], ['OCR_TIMEOUT', 504], ['OCR_BUSY', 429],
  ] as const)('preserves actionable safe error status %s without starting a run', async (code, status) => {
    mocks.extract.mockRejectedValueOnce(new AuthorizationExtractionError(code));
    const response = await request('{}');
    expect(response.status).toBe(status);
    expect(JSON.parse(response.text)).toMatchObject({ code });
    expect(JSON.parse(response.text)).not.toHaveProperty('draft');
  });
});
