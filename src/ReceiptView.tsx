import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, FileCheck2, Link2, LockKeyhole, Printer, ShieldAlert, ShieldCheck } from 'lucide-react';
import { evaluateProposal } from '../shared/policy';
import { MERCHANTS } from '../shared/types';
import type { ReceiptViewModel } from '../shared/receipt';
import { receiptRouteFromSearch } from './navigation';
import './receipt.css';

export interface ReceiptViewProps {
  receipt: ReceiptViewModel;
  /** A URL created by the host app, usually ?receipt=<session UUID>&digest=<receipt digest>. */
  shareUrl?: string;
  expectedDigest?: string;
  onBack?: () => void;
}

type BrowserCheck = { status: 'checking' | 'passed' | 'failed' | 'unavailable'; detail: string };
const statuses = { ready: '未开始', running: '运行中', completed: '已完成', stopped: '已停止', error: '发生错误' };
const checkLabels: Record<string, string> = { stopped: '任务状态', deadline: '授权期限', merchant: '供应商与钱包', duplicate: '重复发票', budget: '含费预算', input: '输入格式' };
const reasons: Record<string, string> = {
  APPROVED: '规则通过，记入模拟账本。', BUDGET_EXCEEDED: '发票加服务费后超出预算。',
  MERCHANT_NOT_ALLOWED: '供应商或钱包与登记不一致。', DUPLICATE_PAYMENT: '这张发票已经记账。',
  EXPIRED: '提案发生时授权已经到期。', SESSION_STOPPED: '用户已停止该会话。',
  INVALID_POLICY: '授权输入无效。', INVALID_CONTEXT: '判断上下文无效。', INVALID_QUOTE: '报价输入无效。', INVALID_AMOUNT: '金额格式或范围无效。',
};
const anchorLabels = { none: '没有链上记录', prepared: '已准备，广播待核查', submitted: '已广播，未验证链上确认', broadcast_unknown: '广播结果未知', confirmed: '交易已确认，摘要关联待核验', reverted: '交易已回滚', unverified: '记录未验证' };
const money = (value: number) => Number.isSafeInteger(value) && value >= 0
  ? (value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : '无效金额';
const time = (value: string) => `${new Date(value).toLocaleString('zh-CN', { timeZone: 'UTC', hour12: false })} UTC`;

/** Mirrors sorted-key JSON used by the server without importing Node crypto into the browser. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

async function sha256(value: unknown) {
  const bytes = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Only the disclosed payload is rechecked; no network, AI, payment, or chain calls occur. */
export async function checkReceiptInBrowser(receipt: ReceiptViewModel, expectedDigest?: string): Promise<BrowserCheck> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    return { status: 'unavailable', detail: '此环境不支持浏览器摘要校验。请在 HTTPS 或本机页面打开；当前未完成校验。' };
  }
  try {
    if (receipt.format !== 'spendproof-receipt-v1' || receipt.sourceCheck !== 'checked_before_redaction'
      || receipt.anchor.kind !== 'evidence_anchor' || receipt.anchor.chainId !== 84532
      || !Object.hasOwn(anchorLabels, receipt.anchor.status)
      || receipt.anchor.matchesSource !== (receipt.anchor.digest !== null && receipt.anchor.digest === receipt.sourceEvidenceDigest)) {
      return { status: 'failed', detail: '收据格式或链上摘要关联声明不一致。' };
    }
    const { digest, ...body } = receipt;
    const { digest: evidenceDigest, ...evidenceBody } = receipt.evidence;
    if (await sha256(body) !== digest || await sha256(evidenceBody) !== evidenceDigest
      || (expectedDigest !== undefined && digest !== expectedDigest)) {
      return { status: 'failed', detail: '内容摘要或链接中的预期摘要不一致，请停止使用这份收据。' };
    }
    let spentMicros = 0;
    const businessIds: string[] = [];
    let stopped = false;
    let lastAt = Date.parse(receipt.evidence.session.createdAt);
    if (!Number.isFinite(lastAt) || !Number.isFinite(Date.parse(receipt.evidence.exportedAt))
      || !Number.isFinite(Date.parse(receipt.evidence.session.policy.expiresAt))
      || new Set(receipt.evidence.session.policy.allowedMerchants).size !== receipt.evidence.session.policy.allowedMerchants.length
      || receipt.evidence.session.usage.some(usage => !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0)) {
      return { status: 'failed', detail: '时间、授权或模型用量记录无效。' };
    }
    const recordIds = new Set<string>();
    for (const record of receipt.evidence.session.records) {
      const decision = evaluateProposal(record.quote, receipt.evidence.session.policy, record.context);
      if (canonical(decision) !== canonical(record.decision) || record.context.spentMicros !== spentMicros
        || canonical([...record.context.paidBusinessIds].sort()) !== canonical([...businessIds].sort())
        || record.status !== (decision.allowed ? 'simulated' : 'blocked') || record.txHash !== undefined
        || recordIds.has(record.id) || record.context.now !== record.createdAt || !Number.isFinite(Date.parse(record.createdAt)) || Date.parse(record.createdAt) < lastAt
        || (stopped && !record.context.stopped)) {
        return { status: 'failed', detail: '规则重算、累计上下文或模拟付款标签不一致。' };
      }
      recordIds.add(record.id);
      stopped ||= record.context.stopped;
      lastAt = Date.parse(record.createdAt);
      if (decision.allowed) { spentMicros += decision.totalMicros; businessIds.push(record.quote.businessId); }
    }
    if (!Number.isSafeInteger(spentMicros) || Date.parse(receipt.evidence.exportedAt) < lastAt) {
      return { status: 'failed', detail: '累计金额或证据时间不一致。' };
    }
    return { status: 'passed', detail: expectedDigest
      ? '本浏览器已重算公开快照的摘要与规则，且摘要与链接一致。未独立核验原始事实、身份或链上回执。'
      : '本浏览器已重算公开快照的摘要与规则。未提供独立可信摘要，不能据此证明来源真实。' };
  } catch {
    return { status: 'failed', detail: '收据无法解析或校验，未得到可信的核验结果。' };
  }
}

function shareLink(input: string | undefined, digest: string): string | null {
  if (!input || typeof window === 'undefined') return null;
  try {
    const url = new URL(input, window.location.origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    if (receiptRouteFromSearch(url.search).kind !== 'receipt') return null;
    if (!/^[a-f0-9]{64}$/.test(digest)) return null;
    url.searchParams.set('digest', digest);
    return url.toString();
  } catch { return null; }
}

/** Only interprets the included server RPC result; callers must also verify receipt integrity. */
export function isReceiptAnchorVerified(receipt: ReceiptViewModel): boolean {
  return receipt.anchor.status === 'confirmed' && receipt.anchor.digestMatched === true
    && receipt.anchor.verificationStatus === 'verified' && receipt.anchor.matchesSource
    && receipt.anchor.digest === receipt.sourceEvidenceDigest && /^0x[a-fA-F0-9]{64}$/.test(receipt.anchor.transactionHash || '');
}

export function ReceiptView({ receipt, shareUrl, expectedDigest, onBack }: ReceiptViewProps) {
  const [check, setCheck] = useState<BrowserCheck>({ status: 'checking', detail: '正在本浏览器重算公开快照的摘要与规则…' });
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [printError, setPrintError] = useState(false);
  const session = receipt.evidence.session;
  const allowed = session.records.filter(record => record.decision.allowed);
  const simulatedSpent = allowed.reduce((sum, record) => sum + record.decision.totalMicros, 0);
  const tokens = session.usage.reduce((sum, usage) => sum + BigInt(usage.inputTokens) + BigInt(usage.outputTokens), 0n);
  const link = useMemo(() => shareLink(shareUrl, receipt.digest), [shareUrl, receipt.digest]);
  const localLink = link ? ['localhost', '127.0.0.1', '[::1]'].includes(new URL(link).hostname) : true;
  const chainVerified = check.status === 'passed' && isReceiptAnchorVerified(receipt);
  useEffect(() => {
    let active = true;
    setCheck({ status: 'checking', detail: '正在本浏览器重算公开快照的摘要与规则…' });
    setCopyState('idle');
    void checkReceiptInBrowser(receipt, expectedDigest).then(result => { if (active) setCheck(result); });
    return () => { active = false; };
  }, [receipt, expectedDigest]);
  const copy = async () => {
    if (!link) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
  };
  const print = () => {
    setPrintError(false);
    try { window.print(); } catch { setPrintError(true); }
  };
  return <div className="sp-receipt">
    <nav className="sp-receipt-toolbar sp-no-print" aria-label="收据操作">
      {onBack ? <button type="button" onClick={onBack}><ArrowLeft size={16} />返回</button> : <span>SPENDPROOF / RECEIPT</span>}
      <div><button type="button" onClick={copy} disabled={!link}><Copy size={16} />{copyState === 'copied' ? '已复制' : '复制链接'}</button><button type="button" onClick={print}><Printer size={16} />保存 PDF</button></div>
    </nav>
    <main className="sp-receipt-paper">
      <header className="sp-receipt-header"><div><p className="sp-receipt-eyebrow">SPENDPROOF · READ-ONLY</p><h1>一份可复核的<br />付款判断。</h1><p>授权、提案、规则、摘要。</p></div><FileCheck2 className="sp-receipt-seal" size={48} strokeWidth={1.2} /></header>
      <div className="sp-receipt-tags"><span>只读</span><span>{statuses[session.status]}</span><span>{session.agentMode === 'fixture' ? '固定发票' : session.usage.length ? 'Kiln · 用量已记录' : 'Kiln · 无用量记录'}</span><strong>付款模拟</strong></div>
      <section className={`sp-receipt-check sp-receipt-check-${check.status}`} aria-live="polite">
        {check.status === 'passed' ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}<div><h2>{check.status === 'passed' ? '浏览器复算通过' : check.status === 'checking' ? '正在复算' : check.status === 'unavailable' ? '尚未校验' : '发现不一致'}</h2><p>{check.detail}</p></div>
      </section>
      <section className="sp-receipt-section" aria-labelledby="receipt-authorization"><div className="sp-receipt-section-heading"><span>01</span><h2 id="receipt-authorization">授权</h2></div><dl className="sp-receipt-facts"><div><dt>含费预算</dt><dd>{money(session.policy.budgetMicros)} <small>USDC</small></dd></div><div><dt>模拟记账</dt><dd>{money(simulatedSpent)} <small>USDC</small></dd></div><div><dt>登记供应商</dt><dd className="sp-receipt-value-text">{session.policy.allowedMerchants.map(id => MERCHANTS.find(merchant => merchant.id === id)?.name || '未登记供应商').join(' / ') || '无'}</dd></div><div><dt>截止时间</dt><dd className="sp-receipt-value-text"><time dateTime={session.policy.expiresAt}>{time(session.policy.expiresAt)}</time></dd></div></dl><p className="sp-receipt-note">任务原文已隐藏。无用户授权签名。</p></section>
      <section className="sp-receipt-section" aria-labelledby="receipt-proposals"><div className="sp-receipt-section-heading"><span>02</span><h2 id="receipt-proposals">付款判断</h2><small>{session.records.length} 条 · {session.records.length - allowed.length} 条拦截</small></div>
        {session.records.length ? session.records.map((record, index) => <article className="sp-receipt-proposal" key={record.id}><div className="sp-receipt-proposal-heading"><div><p className="sp-receipt-eyebrow">INVOICE {String(index + 1).padStart(2, '0')}</p><h3>{record.quote.merchantName}</h3><p><time dateTime={record.createdAt}>{time(record.createdAt)}</time> · {record.quote.businessId}</p></div><span className={`sp-receipt-decision ${record.decision.allowed ? 'is-allowed' : 'is-blocked'}`}>{record.decision.allowed ? '模拟通过' : '已拦截'}</span></div><div className="sp-receipt-amounts"><span>发票金额 <b>{money(record.quote.amountMicros)} USDC</b></span><span>服务费 <b>{money(record.quote.feeMicros)} USDC</b></span><span>此前记账 <b>{money(record.context.spentMicros)} USDC</b></span></div><p className="sp-receipt-reason">{reasons[record.decision.code] || '需要复核。'} <code>{record.decision.code}</code></p><div className="sp-receipt-address"><span>收款地址</span><code>{record.quote.recipient}</code></div><ul className="sp-receipt-rules">{record.decision.checks.map(rule => <li key={rule.key}><span className={rule.passed ? 'is-allowed' : 'is-blocked'}>{rule.passed ? <Check size={14} /> : <ShieldAlert size={14} />}{checkLabels[rule.key] || '规则检查'}</span><p>{rule.detail}</p></li>)}</ul></article>) : <p className="sp-receipt-note">没有付款提案。</p>}
      </section>
      <section className="sp-receipt-section" aria-labelledby="receipt-model"><div className="sp-receipt-section-heading"><span>03</span><h2 id="receipt-model">模型用量</h2><small>{session.usage.length} 条 · {tokens.toLocaleString()} tokens</small></div>{session.usage.length ? <div className="sp-receipt-table-wrap"><table><thead><tr><th>响应</th><th>模型</th><th>输入</th><th>输出</th></tr></thead><tbody>{session.usage.map((usage, index) => <tr key={index}><td>{String(index + 1).padStart(2, '0')}</td><td>{usage.model === 'model-name-hidden' ? '模型名称已隐藏' : usage.model}</td><td>{usage.inputTokens.toLocaleString()}</td><td>{usage.outputTokens.toLocaleString()}</td></tr>)}</tbody></table></div> : <p className="sp-receipt-note">没有用量记录。</p>}<p className="sp-receipt-note">运行记录，不代表硬件或耗电量。</p></section>
      <section className="sp-receipt-section" aria-labelledby="receipt-evidence"><div className="sp-receipt-section-heading"><span>04</span><h2 id="receipt-evidence">摘要与存证</h2></div><dl className="sp-receipt-digests"><div><dt>收据 SHA-256</dt><dd><code>{receipt.digest}</code></dd></div><div><dt>脱敏快照 SHA-256</dt><dd><code>{receipt.evidence.digest}</code></dd></div><div><dt>原始证据 SHA-256</dt><dd><code>{receipt.sourceEvidenceDigest}</code></dd></div></dl><div className="sp-receipt-anchor"><Link2 size={20} /><div><h3>Base Sepolia · {chainVerified ? '已核验' : anchorLabels[receipt.anchor.status]}</h3><p>零金额摘要存证。不是付款。</p>{receipt.anchor.transactionHash && <a href={`https://sepolia.basescan.org/tx/${receipt.anchor.transactionHash}`} target="_blank" rel="noopener noreferrer"><code>{receipt.anchor.transactionHash}</code><ArrowUpRight size={15} /></a>}{receipt.anchor.account && <p>账户：<code>{receipt.anchor.account}</code></p>}{receipt.anchor.blockNumber !== null && <p>区块：<code>{receipt.anchor.blockNumber}</code> · Gas：<code>{receipt.anchor.gasUsed ?? '未知'}</code></p>}{receipt.anchor.status !== 'none' && <p className={chainVerified ? '' : 'sp-receipt-warning'}>{chainVerified ? 'RPC 显示交易成功，内容与原始证据摘要匹配。' : receipt.anchor.verificationStatus === 'unavailable' ? 'RPC 查询未完成。' : receipt.anchor.status === 'reverted' ? '存证交易已回滚。' : !receipt.anchor.matchesSource ? '存证未关联当前原始证据。' : receipt.anchor.digestMatched === false ? '交易内容与摘要不匹配。' : '尚未完成交易与内容核验。'}</p>}</div></div><details className="sp-receipt-disclosure"><summary>验证边界</summary><p>浏览器没有重新查询链上。脱敏收据也不能单独证明隐藏原文；需与另行保存的可信摘要对照。</p></details></section>
      <footer className="sp-receipt-footer"><LockKeyhole size={17} /><div><p>任务正文和日志已隐藏；金额、供应商与地址用于复算。</p><p><time dateTime={receipt.evidence.exportedAt}>{time(receipt.evidence.exportedAt)}</time> · 不是付款凭证或签名授权。</p></div></footer>
    </main>
    <aside className="sp-receipt-share-note sp-no-print"><p>{link ? localLink ? '本机链接。跨设备请保存 PDF。' : '接收方需能访问此服务。' : '暂无分享地址。'}</p>{copyState === 'copied' && <p role="status">链接已复制。</p>}{copyState === 'failed' && <div role="alert"><p>请手动复制。</p><label htmlFor="receipt-manual-link">只读链接</label><textarea id="receipt-manual-link" readOnly value={link || ''} onFocus={event => event.target.select()} /></div>}{printError && <p role="alert">请使用浏览器菜单打印。</p>}<p>保存 PDF：点击“保存 PDF”。</p></aside>
  </div>;
}

export default ReceiptView;
