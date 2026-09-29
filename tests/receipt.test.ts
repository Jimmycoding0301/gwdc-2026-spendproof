import { webcrypto } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvidence, evidenceDigest } from '../shared/evidence';
import { evaluateProposal } from '../shared/policy';
import { createReceiptView, receiptDigest, verifyReceiptView } from '../shared/receipt';
import { MERCHANTS } from '../shared/types';
import type { EvaluationContext, PaymentRecord, Quote, Session } from '../shared/types';
import { checkReceiptInBrowser, isReceiptAnchorVerified, ReceiptView } from '../src/ReceiptView';
import { syntheticSecrets } from './helpers/synthetic-secrets';

const { storedAnchor } = vi.hoisted(() => ({ storedAnchor: vi.fn() }));
vi.mock('../server/anchor.js', () => ({ getStoredAnchor: storedAnchor }));
vi.mock('../server/config.js', () => ({ config: { kilnApiKey: 'synthetic-kiln-key', testnetPrivateKey: 'synthetic-private-key' } }));
import { createSessionReceipt } from '../server/receipt';

const now = '2026-09-28T12:00:00.000Z';
const finished = '2026-09-28T12:00:03.000Z';
const txHash = `0x${'a'.repeat(64)}`;
function session(): Session {
  const value: Session = {
    id: '6e8e8890-b1ac-4ffc-a4e0-78c60fdfd10d', title: 'Private client research', createdAt: now,
    policy: { budgetMicros: 10_000_000, allowedMerchants: ['atlas'], expiresAt: '2026-09-28T13:00:00.000Z', task: 'Private research instructions' },
    scenario: 'fees', agentMode: 'kiln', status: 'completed', records: [],
    events: [{ id: 'private-event', at: finished, kind: 'complete', title: 'Private event', detail: 'Private detail' }],
    usage: [{ flow: 'private-flow', inputTokens: 477, outputTokens: 20, model: 'qwen3-32b' }],
  };
  addRecord(value);
  addRecord(value, { businessId: 'customer-private-2', amountMicros: 4_000_000 });
  return value;
}
function addRecord(value: Session, changes: Partial<Quote> = {}, overrides: Partial<EvaluationContext> = {}) {
  const quote: Quote = {
    id: `private-quote-${value.records.length}`, businessId: 'customer-private-1', merchantId: 'atlas',
    merchantName: 'Atlas Data', recipient: MERCHANTS[0].recipient, item: 'Private report description',
    amountMicros: 6_000_000, feeMicros: 500_000, ...changes,
  };
  const allowed = value.records.filter(record => record.decision.allowed);
  const context: EvaluationContext = {
    spentMicros: allowed.reduce((sum, record) => sum + record.decision.totalMicros, 0),
    paidBusinessIds: allowed.map(record => record.quote.businessId), stopped: false,
    now: `2026-09-28T12:00:0${value.records.length}.000Z`, ...overrides,
  };
  const decision = evaluateProposal(quote, value.policy, context);
  const record: PaymentRecord = { id: `private-record-${value.records.length}`, quote, context, decision, createdAt: context.now, status: decision.allowed ? 'simulated' : 'blocked' };
  value.records.push(record);
}
function source(value = session()) { return createEvidence(value, finished); }
function withBrowser() { vi.stubGlobal('window', { crypto: webcrypto, location: { origin: 'http://localhost:5173' } }); }
function anchor(digest: string, status = 'confirmed', digestMatched = true) {
  return { kind: 'evidence_anchor', chainId: 84532, status, digest, transactionHash: txHash,
    account: MERCHANTS[0].recipient, blockNumber: '12345678', gasUsed: '24100', digestMatched,
    verificationStatus: 'verified', lastCheckedAt: finished };
}
afterEach(() => { vi.unstubAllGlobals(); storedAnchor.mockReset(); });

describe('read-only receipt privacy and consistency', () => {
  it('exports a separately verifiable snapshot without source free text, IDs, events or error details', () => {
    const value = session();
    const secret = syntheticSecrets.KILN_API_KEY;
    value.title = secret; value.policy.task = secret; value.error = secret;
    value.events[0].detail = secret; value.usage[0].flow = secret;
    value.records[0].quote.item = secret; value.records[0].quote.merchantName = secret;
    const original = source(value);
    const before = JSON.stringify(original);
    const receipt = createReceiptView(original, { sensitiveValues: Object.values(syntheticSecrets) });
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain('customer-private');
    expect(JSON.stringify(receipt)).not.toContain('private-record');
    expect(receipt.evidence.session.events).toEqual([]);
    expect(receipt.evidence.session.error).toBeUndefined();
    expect(receipt.evidence.digest).not.toBe(original.digest);
    expect(receipt.sourceEvidenceDigest).toBe(original.digest);
    expect(verifyReceiptView(receipt, receipt.digest)).toMatchObject({ valid: true, digestMatches: true, evidenceValid: true, disclosureValid: true, trustedDigestMatches: true });
    expect(receipt.evidence.session.records.map(record => record.decision.code)).toEqual(['APPROVED', 'BUDGET_EXCEEDED']);
  });

  it('keeps duplicate identity relationships after replacing business IDs', () => {
    const value = session(); value.records = [value.records[0]];
    addRecord(value, { businessId: value.records[0].quote.businessId });
    const receipt = createReceiptView(source(value));
    expect(receipt.evidence.session.records[1].decision.code).toBe('DUPLICATE_PAYMENT');
    expect(receipt.evidence.session.records[1].context.paidBusinessIds).toEqual([receipt.evidence.session.records[0].quote.businessId]);
    expect(verifyReceiptView(receipt).valid).toBe(true);
  });

  it('redacts unknown merchant and model names, preserving merchant and invalid-address rejections', () => {
    const value = session(); value.records = [];
    value.policy.allowedMerchants.push(syntheticSecrets.GASFREE_API_KEY);
    value.usage[0].model = syntheticSecrets.KILN_API_KEY;
    addRecord(value, { merchantId: syntheticSecrets.GASFREE_API_KEY });
    addRecord(value, { recipient: syntheticSecrets.TESTNET_PRIVATE_KEY });
    const receipt = createReceiptView(source(value));
    for (const secret of Object.values(syntheticSecrets)) expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(receipt.evidence.session.usage[0].model).toBe('model-name-hidden');
    expect(receipt.evidence.session.records.map(record => record.decision.code)).toEqual(['MERCHANT_NOT_ALLOWED', 'INVALID_QUOTE']);
    expect(verifyReceiptView(receipt).valid).toBe(true);
  });

  it('preserves stop and deadline decisions without granting a new authorization', () => {
    const value = session(); value.records = [];
    value.policy.expiresAt = now;
    addRecord(value);
    addRecord(value, {}, { stopped: true });
    const receipt = createReceiptView(source(value));
    expect(receipt.evidence.session.records.map(record => record.decision.code)).toEqual(['EXPIRED', 'SESSION_STOPPED']);
    expect(verifyReceiptView(receipt).valid).toBe(true);
  });

  it('refuses inconsistent source decisions or fake payment transaction hashes before sharing', () => {
    const original = source(); original.session.records[0].decision.allowed = false;
    original.digest = evidenceDigest(original);
    expect(() => createReceiptView(original)).toThrow('Source evidence');
    const fake = source(); fake.session.records[0].txHash = txHash; fake.digest = evidenceDigest(fake);
    expect(() => createReceiptView(fake)).toThrow('Source evidence');
  });

  it('rejects receipt tampering, forged rules and additional disclosed text even after new hashes', () => {
    const receipt = createReceiptView(source());
    receipt.evidence.session.records[0].quote.feeMicros += 1;
    expect(verifyReceiptView(receipt).digestMatches).toBe(false);
    receipt.evidence.digest = evidenceDigest(receipt.evidence); receipt.digest = receiptDigest(receipt);
    expect(verifyReceiptView(receipt)).toMatchObject({ valid: false, digestMatches: true, evidenceValid: false });
    const injected = createReceiptView(source()); injected.evidence.session.title = 'Private customer identifier';
    injected.evidence.digest = evidenceDigest(injected.evidence); injected.digest = receiptDigest(injected);
    expect(verifyReceiptView(injected)).toMatchObject({ valid: false, evidenceValid: true, disclosureValid: false });
    expect(verifyReceiptView({ ...createReceiptView(source()), secret: 'never allowed' }).valid).toBe(false);
  });

  it('requires an expected digest to match and never claims a matching digest proves original facts', () => {
    const receipt = createReceiptView(source());
    expect(verifyReceiptView(receipt, '0'.repeat(64))).toMatchObject({ valid: false, trustedDigestMatches: false });
    const html = renderToStaticMarkup(createElement(ReceiptView, { receipt }));
    expect(html).toContain('用户授权签名');
    expect(html).toContain('不能单独证明');
    expect(html).toContain('付款模拟');
    expect(html).toContain('保存 PDF');
  });
});

describe('public chain anchor presentation', () => {
  it('only shows verified chain language for a successful matching current-source RPC result', () => {
    const original = source();
    const receipt = createReceiptView(original, { anchor: anchor(original.digest) });
    expect(receipt.anchor).toMatchObject({ status: 'confirmed', digestMatched: true, matchesSource: true, blockNumber: '12345678', gasUsed: '24100', account: MERCHANTS[0].recipient });
    const html = renderToStaticMarkup(createElement(ReceiptView, { receipt }));
    expect(isReceiptAnchorVerified(receipt)).toBe(true);
    // A static render has not run browser integrity checks yet and must not claim verification.
    expect(html).not.toContain('链上已核验');
    expect(html).toContain('不是付款');
    expect(html).toContain('sepolia.basescan.org/tx/');
    for (const candidate of [anchor(original.digest, 'submitted'), anchor(original.digest, 'broadcast_unknown'), anchor(original.digest, 'reverted'), anchor(original.digest, 'confirmed', false), anchor('0'.repeat(64))]) {
      const view = createReceiptView(original, { anchor: candidate });
      expect(isReceiptAnchorVerified(view)).toBe(false);
      expect(renderToStaticMarkup(createElement(ReceiptView, { receipt: view }))).not.toContain('链上已核验');
    }
  });

  it('uses only whitelisted chain fields and refuses a protected value even in a syntactically valid hash', () => {
    const original = source();
    const view = createReceiptView(original, { anchor: { ...anchor(original.digest), explorerUrl: 'javascript:alert(1)', note: syntheticSecrets.TESTNET_PRIVATE_KEY, privateKey: syntheticSecrets.KILN_API_KEY } });
    expect(JSON.stringify(view)).not.toContain('javascript:');
    expect(JSON.stringify(view)).not.toContain(syntheticSecrets.TESTNET_PRIVATE_KEY);
    expect(JSON.stringify(view)).not.toContain(syntheticSecrets.KILN_API_KEY);
    expect(() => createReceiptView(original, { anchor: anchor(original.digest), sensitiveValues: [txHash] })).toThrow('protected value');
    const wrongChain = createReceiptView(original, { anchor: { ...anchor(original.digest), chainId: 1 } });
    expect(wrongChain.anchor).toMatchObject({ status: 'unverified', transactionHash: null, account: null });
    const absent = createReceiptView(original);
    expect(absent.anchor).toMatchObject({ status: 'none', transactionHash: null, digestMatched: null });
    expect(absent.evidence.session.records.every(record => record.txHash === undefined)).toBe(true);
  });

  it('keeps historical confirmation separate from a failed or absent latest RPC verification', () => {
    const original = source();
    for (const verificationStatus of ['unavailable', undefined]) {
      const receipt = createReceiptView(original, { anchor: { ...anchor(original.digest), verificationStatus } });
      expect(receipt.anchor.status).toBe('confirmed');
      expect(receipt.anchor.digestMatched).toBe(true);
      expect(isReceiptAnchorVerified(receipt)).toBe(false);
      expect(verifyReceiptView(receipt).valid).toBe(true);
    }
  });

  it('rejects contradictory anchor claims in a recomputed receipt', () => {
    const receipt = createReceiptView(source());
    receipt.anchor.matchesSource = true; receipt.digest = receiptDigest(receipt);
    expect(verifyReceiptView(receipt).valid).toBe(false);
    const missingHash = createReceiptView(source()); missingHash.anchor.status = 'confirmed'; missingHash.digest = receiptDigest(missingHash);
    expect(verifyReceiptView(missingHash).valid).toBe(false);
  });
});

describe('browser and server receipt boundaries', () => {
  it('recomputes hashes and deterministic history in the browser without network calls', async () => {
    withBrowser();
    const fetch = vi.fn(() => { throw new Error('Receipt verification must not use the network.'); });
    vi.stubGlobal('fetch', fetch);
    const receipt = createReceiptView(source());
    expect((await checkReceiptInBrowser(receipt, receipt.digest)).status).toBe('passed');
    expect((await checkReceiptInBrowser(receipt, '0'.repeat(64))).status).toBe('failed');
    receipt.evidence.session.records[1].context.spentMicros = 0;
    receipt.evidence.session.records[1].decision = evaluateProposal(receipt.evidence.session.records[1].quote, receipt.evidence.session.policy, receipt.evidence.session.records[1].context);
    receipt.evidence.digest = evidenceDigest(receipt.evidence); receipt.digest = receiptDigest(receipt);
    expect((await checkReceiptInBrowser(receipt)).status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports unavailable crypto and accepts only clean HTTP receipt links', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    const receipt = createReceiptView(source());
    expect((await checkReceiptInBrowser(receipt)).status).toBe('unavailable');
    const valid = renderToStaticMarkup(createElement(ReceiptView, { receipt, shareUrl: `/?receipt=${session().id}` }));
    expect(valid).toContain('本机链接');
    for (const shareUrl of [`/?receipt=${session().id}&api_key=synthetic`, `javascript:alert(1)`, `https://user:pass@example.com/?receipt=${session().id}`]) {
      const html = renderToStaticMarkup(createElement(ReceiptView, { receipt, shareUrl }));
      expect(html).toContain('暂无分享地址');
      expect(html).not.toContain('api_key=synthetic');
      expect(html).not.toContain('user:pass');
    }
  });

  it('refreshes stored anchor status for a stable terminal session and uses a stable export timestamp', async () => {
    const value = session();
    const original = source(value);
    storedAnchor.mockResolvedValue(anchor(original.digest));
    const result = await createSessionReceipt(value);
    expect(storedAnchor).toHaveBeenCalledWith(value.id);
    expect(result.sourceEvidenceDigest).toBe(original.digest);
    expect(result.anchor).toMatchObject({ status: 'confirmed', matchesSource: true });
    expect(result.evidence.exportedAt).toBe(finished);
    expect(await createSessionReceipt(value)).toEqual(result);
  });

  it('rejects active sessions and invalid identifiers before accessing an anchor', async () => {
    await expect(createSessionReceipt({ ...session(), status: 'running' })).rejects.toThrow('Finish or stop');
    await expect(createSessionReceipt({ ...session(), id: '../private' })).rejects.toThrow('Invalid session ID');
    expect(storedAnchor).not.toHaveBeenCalled();
  });
});
