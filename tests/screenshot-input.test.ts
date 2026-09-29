import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScreenshotAuthorization from '../src/ScreenshotAuthorization';
import { SCREENSHOT_MAX_BYTES, applyAuthorizationDraft, clipboardImageFiles, microsToFormBudget, parseAuthorizationExtraction, recognizedAuthorizationKeys, sameAuthorizationForm, screenshotFileError } from '../src/screenshot-input';
import type { AuthorizationFormValues } from '../src/screenshot-input';
import type { AuthorizationExtraction } from '../shared/authorization';

const current: AuthorizationFormValues = { task: '原始任务', budget: '5.00', duration: '60', merchants: ['atlas', 'orbit'] };
const extraction: AuthorizationExtraction = {
  draft: { task: '研究报告', budgetMicros: 7_250_001, allowedMerchants: ['atlas'] },
  fields: [
    { key: 'task', label: '任务', value: '研究报告', confidence: 'high', evidence: '任务：研究报告' },
    { key: 'budgetMicros', label: '预算', value: '7.250001 USDC', confidence: 'medium', evidence: '预算：7.250001 USDC' },
    { key: 'allowedMerchants', label: '商户', value: 'Atlas Data', confidence: 'low', evidence: '允许商户：Atlas Data' },
  ], warnings: ['时长未识别，请确认当前值。'], source: 'local-ocr',
};
afterEach(() => vi.unstubAllGlobals());

describe('screenshot authorization input boundaries', () => {
  it('accepts only one nonempty PNG or JPEG within the backend size limit', () => {
    expect(screenshotFileError([{ type: 'image/png', size: SCREENSHOT_MAX_BYTES }])).toBeNull();
    expect(screenshotFileError([{ type: 'image/jpeg', size: 20 }])).toBeNull();
    for (const type of ['image/webp', 'image/svg+xml', 'application/pdf', 'text/plain', '']) {
      expect(screenshotFileError([{ type, size: 20 }])).toContain('PNG');
    }
    expect(screenshotFileError([{ type: 'image/png', size: SCREENSHOT_MAX_BYTES + 1 }])).toContain('超过');
    expect(screenshotFileError([{ type: 'image/png', size: 0 }])).toContain('空文件');
    expect(screenshotFileError([])).toContain('一张');
    expect(screenshotFileError([{ type: 'image/png', size: 20 }, { type: 'image/jpeg', size: 20 }])).toContain('一张');
  });

  it('leaves ordinary text and nonimage clipboard contents alone, including inside text inputs', () => {
    const png = new File(['synthetic'], 'authorization.png', { type: 'image/png' });
    const text = new File(['plain text'], 'notes.txt', { type: 'text/plain' });
    const clipboard = (files: File[], items: unknown[] = []) => ({ files, items }) as unknown as Pick<DataTransfer, 'files' | 'items'>;
    expect(clipboardImageFiles(null)).toEqual([]);
    expect(clipboardImageFiles(clipboard([text], [{ kind: 'string', type: 'text/plain' }]))).toEqual([]);
    expect(clipboardImageFiles(clipboard([png, text]))).toEqual([png]);
    expect(clipboardImageFiles(clipboard([], [{ kind: 'file', type: 'image/png', getAsFile: () => png }]))).toEqual([png]);
  });

  it('rejects invalid amounts, new merchants, unsupported durations and malformed extraction responses', () => {
    const unsafeDrafts = [{ budgetMicros: -1 }, { budgetMicros: 1.5 }, { budgetMicros: NaN }, { budgetMicros: 100_000_000_001 },
      { allowedMerchants: ['unregistered'] }, { allowedMerchants: ['atlas', 'atlas'] }, { durationMinutes: 30 },
      { task: '' }, { recipient: `0x${'f'.repeat(40)}` }];
    for (const draft of unsafeDrafts) expect(() => parseAuthorizationExtraction({ ...extraction, draft })).toThrow('未填入');
    for (const value of [null, {}, { ...extraction, source: 'kiln' }, { ...extraction, warnings: 'bad' }, { ...extraction, fields: [{ key: 'task', label: 'Task', value: 42, confidence: 'high' }] }]) {
      expect(() => parseAuthorizationExtraction(value)).toThrow('格式无效');
    }
  });

  it('keeps recognition separate from applying, preserves every missing field, and changes no caller-owned arrays', () => {
    const before = structuredClone(current);
    const parsed = parseAuthorizationExtraction(extraction);
    expect(current).toEqual(before);
    expect(recognizedAuthorizationKeys(parsed.draft)).toEqual(['task', 'budgetMicros', 'allowedMerchants']);
    const next = applyAuthorizationDraft(current, parsed.draft);
    expect(next).toEqual({ task: '研究报告', budget: '7.250001', duration: '60', merchants: ['atlas'] });
    expect(current).toEqual(before);
    next.merchants.push('orbit');
    expect(parsed.draft.allowedMerchants).toEqual(['atlas']);
    expect(extraction.draft.allowedMerchants).toEqual(['atlas']);
    const empty = parseAuthorizationExtraction({ draft: {}, fields: [], warnings: ['未识别'], source: 'local-ocr' });
    expect(recognizedAuthorizationKeys(empty.draft)).toEqual([]);
    expect(applyAuthorizationDraft(current, empty.draft)).toEqual(current);
  });

  it('preserves micro-USDC precision and invalidates undo when a user edits the resulting form', () => {
    expect(microsToFormBudget(1)).toBe('0.000001');
    expect(microsToFormBudget(1_000_000)).toBe('1.00');
    expect(microsToFormBudget(100_000_000_000)).toBe('100000.00');
    const after = applyAuthorizationDraft(current, extraction.draft);
    expect(sameAuthorizationForm(after, structuredClone(after))).toBe(true);
    expect(sameAuthorizationForm(after, { ...after, budget: '8.00' })).toBe(false);
    expect(sameAuthorizationForm(after, { ...after, merchants: ['orbit'] })).toBe(false);
  });

  it('renders a manual preview-first flow with no extraction, form mutation or purchase on initial display', () => {
    const onApply = vi.fn();
    const fetch = vi.fn(() => { throw new Error('Initial screenshot UI must not call a server.'); });
    vi.stubGlobal('fetch', fetch);
    const html = renderToStaticMarkup(createElement(ScreenshotAuthorization, { value: current, onApply }));
    expect(html).toContain('发票截图');
    expect(html).toContain('本机 OCR');
    expect(html).toContain('最大 1 MB');
    expect(html).toContain('拖入或粘贴发票截图');
    expect(html).not.toContain('一键填入授权');
    expect(html).not.toContain('创建并运行');
    expect(onApply).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
