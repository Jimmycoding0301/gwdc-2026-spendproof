import { readFileSync, statSync, existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAuthorizationText } from '../shared/authorization';
import { AuthorizationExtractionError, extractAuthorization, runLocalOcr, validateAuthorizationImage } from '../server/authorization';
import { syntheticSecrets } from './helpers/synthetic-secrets';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execute }));
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=';
const body = () => ({ imageDataUrl: `data:image/png;base64,${tinyPng}` });
afterEach(() => { vi.unstubAllGlobals(); execute.mockReset(); });

describe('local authorization OCR draft', () => {
  it('extracts explicit fields including split label/value OCR lines with decimal integer precision', async () => {
    const ocr = vi.fn(async () => [
      { text: '任务：核对两张供应商发票', confidence: 0.95 },
      { text: '总额：', confidence: 0.98 }, { text: '5.000001 USDC', confidence: 0.96 },
      { text: '有效期：1 小时', confidence: 0.88 },
      { text: '允许商户：VinaPack Packaging、HanBridge Logistics', confidence: 0.94 },
      { text: '服务费：0.000001 USDC', confidence: 0.99 },
    ]);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await extractAuthorization(body(), { ocr });
    expect(ocr).toHaveBeenCalledOnce();
    expect(result.draft).toEqual({ task: '核对两张供应商发票', budgetMicros: 5_000_001, durationMinutes: 60, allowedMerchants: ['atlas', 'orbit'] });
    expect(result.fields.find(field => field.key === 'budgetMicros')).toMatchObject({ confidence: 'high', evidence: '总额: 5.000001 USDC' });
    expect(result.warnings.join(' ')).toContain('未另行自动加费');
    expect(result.source).toBe('local-ocr');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes validated bytes and dimensions to the local OCR runner and preserves no raw OCR envelope', async () => {
    let received: unknown;
    const result = await extractAuthorization(body(), { ocr: async image => { received = image; return [{ text: 'Budget: 5 USDC' }, { text: 'An unrelated private customer note' }]; } });
    expect(received).toMatchObject({ mime: 'image/png', width: 1, height: 1, bytes: Buffer.from(tinyPng, 'base64') });
    expect(JSON.stringify(result)).not.toContain('private customer');
    expect(Object.keys(result).sort()).toEqual(['draft', 'fields', 'source', 'warnings']);
  });

  it('does not infer budgets from totals in USD, USDT or unspecified currencies', () => {
    for (const amount of ['5 USD', '$5', '5 USDT', '5', '0 USDC', '100000.000001 USDC', '1.0000001 USDC']) {
      const result = parseAuthorizationText(`Total: ${amount}`);
      expect(result.draft.budgetMicros).toBeUndefined();
      expect(result.warnings.length).toBeGreaterThan(0);
    }
    expect(parseAuthorizationText('Budget: 100,000 USDC').draft.budgetMicros).toBe(100_000_000_000);
  });

  it('withholds known merchant authorization when the adjacent address contradicts its registry', () => {
    const result = parseAuthorizationText('Merchants: Atlas Data\nRecipient: 0x9999999999999999999999999999999999999999\nBudget: 5 USDC');
    expect(result.draft.allowedMerchants).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('收款地址不匹配');
    expect(result.draft.budgetMicros).toBe(5_000_000);
    expect(JSON.stringify(result)).not.toContain('0x9999999999999999999999999999999999999999');
  });

  it('drops credential lines, standalone credential values and protected task content', () => {
    const secret = syntheticSecrets.KILN_API_KEY;
    const result = parseAuthorizationText([
      { text: `Task: ${secret}` }, { text: 'API key:' }, { text: 'not-a-real-secret' },
      { text: 'Budget: 5 USDC' }, { text: 'Merchants: Atlas Data' },
    ], [secret]);
    expect(result.draft.task).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('not-a-real-secret');
    expect(result.fields.map(field => field.key)).toEqual(['budgetMicros', 'allowedMerchants']);
  });

  it('reports low confidence and missing fields without silently inventing defaults', () => {
    const result = parseAuthorizationText([{ text: 'Budget: 5 USDC', confidence: 0.2 }]);
    expect(result.fields[0].confidence).toBe('low');
    expect(result.draft).toEqual({ budgetMicros: 5_000_000 });
    expect(result.warnings.join(' ')).toContain('置信度较低');
    expect(parseAuthorizationText('unrelated text').draft).toEqual({});
  });

  it('rejects invalid OCR output and masks worker exceptions without leaking exception text', async () => {
    const secret = syntheticSecrets.TESTNET_PRIVATE_KEY;
    for (const ocr of [async () => { throw new Error(secret); }, async () => [{ text: 'Budget: 5 USDC', confidence: 2 }]]) {
      const result = await extractAuthorization(body(), { ocr }).catch(error => error);
      expect(result).toBeInstanceOf(AuthorizationExtractionError);
      expect(result.code).toBe('OCR_FAILED');
      expect(result.message).not.toContain(secret);
      expect(result.status).toBe(422);
    }
  });

  it('does not invoke OCR after malformed request validation fails and preserves fixed availability errors', async () => {
    const ocr = vi.fn(async () => []);
    await expect(extractAuthorization({ imageDataUrl: 'https://example.invalid/private.png' }, { ocr })).rejects.toMatchObject({ status: 400, code: 'INVALID_IMAGE' });
    expect(ocr).not.toHaveBeenCalled();
    await expect(extractAuthorization(body(), { ocr: async () => { throw new AuthorizationExtractionError('OCR_UNAVAILABLE'); } })).rejects.toMatchObject({ status: 503, code: 'OCR_UNAVAILABLE' });
  });

  it.runIf(process.platform !== 'darwin')('returns an explicit manual fallback on non-macOS without starting a process', async () => {
    await expect(runLocalOcr(validateAuthorizationImage(body()))).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE', status: 503 });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe.runIf(process.platform === 'darwin')('Apple Vision worker isolation', () => {
  it('uses an absolute executable, bounded output/time, stripped environment and private temporary files, then cleans up', async () => {
    let imagePath = '';
    execute.mockImplementation((file, args, options, callback) => {
      imagePath = args.at(-1);
      expect(file).toBe('/usr/bin/swift');
      expect(args).toHaveLength(4);
      expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 131_072, killSignal: 'SIGKILL' });
      expect(Object.keys(options.env).sort()).toEqual(['LANG', 'PATH', 'TMPDIR']);
      expect(statSync(imagePath).mode & 0o777).toBe(0o600);
      expect(statSync(options.env.TMPDIR).mode & 0o777).toBe(0o700);
      expect(readFileSync(imagePath)).toEqual(Buffer.from(tinyPng, 'base64'));
      callback(null, JSON.stringify({ lines: [{ text: 'Budget: 5 USDC', confidence: 1 }] }), '');
    });
    expect(await runLocalOcr(validateAuthorizationImage(body()))).toEqual([{ text: 'Budget: 5 USDC', confidence: 1 }]);
    expect(existsSync(imagePath)).toBe(false);
  });

  it('cleans temporary images on timeout, marks only fixed timeout text and releases the busy slot', async () => {
    let imagePath = '';
    execute.mockImplementation((_file, args, _options, callback) => {
      imagePath = args.at(-1);
      callback(Object.assign(new Error(syntheticSecrets.KILN_API_KEY), { killed: true }), '', 'secret stderr');
    });
    await expect(runLocalOcr(validateAuthorizationImage(body()))).rejects.toMatchObject({ code: 'OCR_TIMEOUT', status: 504 });
    expect(existsSync(imagePath)).toBe(false);
    execute.mockImplementation((_file, _args, _options, callback) => callback(null, '{"lines":[]}', ''));
    expect(await runLocalOcr(validateAuthorizationImage(body()))).toEqual([]);
  });

  it('limits concurrent OCR work and still removes the first image after completion', async () => {
    let done: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    let imagePath = '';
    execute.mockImplementation((_file, args, _options, callback) => { imagePath = args.at(-1); done = callback; });
    const first = runLocalOcr(validateAuthorizationImage(body()));
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    await expect(runLocalOcr(validateAuthorizationImage(body()))).rejects.toMatchObject({ code: 'OCR_BUSY', status: 429 });
    done!(null, '{"lines":[]}', '');
    expect(await first).toEqual([]);
    expect(existsSync(imagePath)).toBe(false);
  });
});
