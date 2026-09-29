import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { dashboardTabFromHash, receiptRouteFromSearch } from '../src/navigation';
import { anchorStatusText, isAnchorFreshlyVerified } from '../src/anchor-status';
import type { EvidenceAnchor } from '../shared/types';

const id = '6e8e8890-b1ac-4ffc-a4e0-78c60fdfd10d';
const digest = 'a'.repeat(64);
function location(search = '', hash = '') {
  vi.stubGlobal('window', { location: { search, hash, pathname: '/', origin: 'http://localhost:5173' } });
}
afterEach(() => vi.unstubAllGlobals());

describe('dashboard and receipt routing', () => {
  it('renders the release gate from a direct hash without fetching or requiring a selected session', () => {
    location('', '#release');
    const fetch = vi.fn(() => { throw new Error('Static routing must not request data.'); });
    vi.stubGlobal('fetch', fetch);
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="规则闸门" aria-current="page"');
    expect(html).toContain('运行故障候选');
    expect(html).toContain('应用正确规则并重跑');
    expect(html).toContain('先选择一份已有采购提案的运行记录');
    expect(html).not.toContain('创建授权');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves every valid dashboard tab on reload and falls back safely for an unknown hash', () => {
    const pages = { workspace: '创建授权', release: '运行故障候选', replay: '暂无记录', evidence: 'CI 回归', settings: '暂无记录' };
    for (const [tab, text] of Object.entries(pages)) {
      location('', `#${tab}`);
      expect(renderToStaticMarkup(createElement(App))).toContain(text);
    }
    expect(dashboardTabFromHash('#unknown')).toBe('workspace');
    expect(dashboardTabFromHash('')).toBe('workspace');
  });

  it('gives the validated receipt query priority over a dashboard hash', () => {
    const search = `?receipt=${id}&digest=${digest}`;
    expect(receiptRouteFromSearch(search)).toEqual({ kind: 'receipt', id, expectedDigest: digest });
    expect(receiptRouteFromSearch(`?receipt=${id}`)).toEqual({ kind: 'receipt', id });
    location(search, '#release');
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('正在核验收据');
    expect(html).not.toContain('运行故障候选');
  });

  it('rejects empty, duplicate, malformed and path-like receipt parameters before a request', () => {
    const invalid = ['?receipt=', `?digest=${digest}`, '?receipt=..%2Fhealth', `?receipt=${id}&receipt=${id}`,
      `?receipt=${id}&digest=`, `?receipt=${id}&digest=wrong`, `?receipt=${id}&digest=${digest}&digest=${digest}`,
      `?receipt=${id}&extra=unexpected`, `?receipt=${'a'.repeat(64)}`];
    for (const search of invalid) {
      expect(receiptRouteFromSearch(search).kind).toBe('invalid');
      location(search, '#release');
      const html = renderToStaticMarkup(createElement(App));
      expect(html).toContain('无法打开这份收据');
      expect(html).not.toContain('正在核验收据');
      expect(html).not.toContain('运行故障候选');
    }
  });
});

describe('anchor verification status labels', () => {
  const confirmed: EvidenceAnchor = {
    version: '1', kind: 'evidence_anchor', sessionId: id, chainId: 84532, network: 'Base Sepolia', digest,
    exportedAt: '2026-09-28T00:00:00.000Z', account: `0x${'1'.repeat(40)}`, transactionHash: `0x${'2'.repeat(64)}`,
    explorerUrl: `https://sepolia.basescan.org/tx/0x${'2'.repeat(64)}`, status: 'confirmed', digestMatched: true, note: '',
  };
  it('requires a fresh successful RPC check for a green confirmation, including old saved records', () => {
    expect(isAnchorFreshlyVerified(confirmed)).toBe(false);
    expect(isAnchorFreshlyVerified({ ...confirmed, verificationStatus: 'verified' })).toBe(true);
    expect(isAnchorFreshlyVerified({ ...confirmed, verificationStatus: 'verified', digestMatched: false })).toBe(false);
    expect(isAnchorFreshlyVerified({ ...confirmed, verificationStatus: 'verified', status: 'submitted' })).toBe(false);
    const unavailable: EvidenceAnchor = { ...confirmed, verificationStatus: 'unavailable' };
    expect(isAnchorFreshlyVerified(unavailable)).toBe(false);
    expect(anchorStatusText(unavailable)).toBe('历史已确认，本次 RPC 未刷新');
    expect(anchorStatusText({ ...unavailable, status: 'submitted' })).toBe('本次 RPC 未刷新');
    expect(anchorStatusText(confirmed)).toBe('历史已确认 · 待 RPC 核验');
  });
});
