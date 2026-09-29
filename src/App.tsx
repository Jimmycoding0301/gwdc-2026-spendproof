import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleHelp, Cpu, FileCheck2, FileJson, FlaskConical, Gauge, History, Layers3, Link2, LoaderCircle, Play, Plus, Radio, ReceiptText, RotateCcw, Settings2, ShieldCheck, ShieldX, Square, Terminal, Timer, Wallet, X } from 'lucide-react';
import { MERCHANTS } from '../shared/types';
import type { Decision, Evidence, EvidenceAnchor, EvidenceVerification, PaymentRecord, Scenario, Session } from '../shared/types';
import type { ReceiptViewModel } from '../shared/receipt';
import { api, download, post } from './api';
import ReceiptView from './ReceiptView';
import ReleaseGate from './ReleaseGate';
import { dashboardTabFromHash, receiptRouteFromSearch } from './navigation';
import type { DashboardTab as Tab } from './navigation';
import { anchorStatusText, isAnchorFreshlyVerified } from './anchor-status';
import ScreenshotAuthorization from './ScreenshotAuthorization';

type Health = { kilnConfigured: boolean; model: string; anchorConfigured: boolean; chainId: number; paymentMode: string };
type AnchorAccount = { configured: boolean; chainId: 84532; network: 'Base Sepolia'; account?: string; balanceWei?: string };
type Replay = { results: { recordId: string; original: Decision; replayed: Decision }[]; llmCalls: number; paymentCalls: number };

const scenarios: { id: Scenario; label: string; description: string; icon: typeof ShieldCheck }[] = [
  { id: 'normal', label: '正常发票', description: '两张登记供应商发票', icon: CheckCheck },
  { id: 'fees', label: '含费超支', description: '服务费让总额超过授权', icon: Wallet },
  { id: 'merchant', label: '新钱包', description: '名称相同，地址已变化', icon: ShieldX },
  { id: 'duplicate', label: '重复发票', description: '同一发票编号再次付款', icon: RotateCcw },
];
const tabs: { id: Tab; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'workspace', label: '付款授权', icon: Layers3 },
  { id: 'release', label: '规则闸门', icon: Gauge },
  { id: 'replay', label: '事故重放', icon: History },
  { id: 'evidence', label: '验证收据', icon: FileCheck2 },
  { id: 'settings', label: '接入状态', icon: Settings2 },
];
const statuses = { ready: '等待运行', running: '运行中', completed: '已完成', stopped: '已停止', error: '运行失败' };
const money = (value: number) => (value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const micros = (value: string) => Math.round(Number(value) * 1_000_000);
const eth = (value?: string) => {
  try { return `${(Number(BigInt(value || '0')) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 8 })} ETH`; }
  catch { return '余额未知'; }
};
const checkLabels: Record<string, string> = { stopped: '任务状态', deadline: '授权期限', merchant: '供应商与钱包', duplicate: '重复发票', budget: '含费预算', input: '输入有效性' };
function explain(decision: Decision) {
  return ({ APPROVED: '规则通过。', SESSION_STOPPED: '授权已停止。', EXPIRED: '授权已过期。', MERCHANT_NOT_ALLOWED: '供应商或钱包不匹配。', DUPLICATE_PAYMENT: '发票已记账。', BUDGET_EXCEEDED: '发票加服务费超出余额。' } as Record<string, string>)[decision.code] || decision.reason;
}

function Empty({ icon: Icon = Activity, title, children }: { icon?: typeof Activity; title: string; children: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={28} strokeWidth={1.5} /></div><h3>{title}</h3><p>{children}</p></div>;
}

function AddressValue({ value, compare }: { value: string; compare?: string }) {
  return <code title={value} className="address-value">{[...value].map((character, index) => compare && compare[index]?.toLowerCase() !== character.toLowerCase()
    ? <mark key={index}>{character}</mark> : <span key={index}>{character}</span>)}</code>;
}

function RecordCard({ record, index }: { record: PaymentRecord; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const supplier = MERCHANTS.find(item => item.id === record.quote.merchantId);
  const changedAddress = Boolean(supplier && supplier.recipient.toLowerCase() !== record.quote.recipient.toLowerCase());
  return <article className={`record ${record.decision.allowed ? 'allowed' : 'blocked'}`}>
    <button className="record-main" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className={`record-symbol ${record.decision.allowed ? 'green' : 'amber'}`}>{record.decision.allowed ? <Check size={18} /> : <ShieldX size={18} />}</span>
      <span className="record-label"><strong>{record.quote.item}</strong><span>{record.quote.merchantName} <span className="inline-dot">·</span> 请求 {String(index + 1).padStart(2, '0')}</span></span>
      <span className="record-amount"><strong>{money(record.decision.totalMicros)} <small>USDC</small></strong><span className={`badge ${record.decision.allowed ? 'green' : 'amber'}`}>{record.decision.allowed ? '模拟通过' : '已拦截'}</span></span>
      <ChevronRight size={16} className={expanded ? 'rotate' : ''} />
    </button>
    {!record.decision.allowed && <p className="record-reason"><ShieldCheck size={14} />{explain(record.decision)}</p>}
    {expanded && <div className="record-detail">
      <div className="quote-fields"><span>发票金额 <b>{money(record.quote.amountMicros)}</b></span><span>服务费 <b>{money(record.quote.feeMicros)}</b></span><span>已用预算 <b>{money(record.context.spentMicros)}</b></span><span>收款地址 <code title={record.quote.recipient}>{short(record.quote.recipient)}</code></span></div>
      {changedAddress && supplier && <div className="address-change"><ShieldX size={16} /><div><strong>地址变化</strong><span>登记地址</span><AddressValue value={supplier.recipient} compare={record.quote.recipient} /><span>发票地址</span><AddressValue value={record.quote.recipient} compare={supplier.recipient} /></div></div>}
      {record.decision.checks.map(check => <div key={check.key} className={`check-row ${check.passed ? '' : 'check-failed'}`}>{check.passed ? <Check size={15} /> : <X size={15} />}<strong>{checkLabels[check.key] || check.label}</strong><span>{check.detail}</span></div>)}
    </div>}
  </article>;
}

function SharedReceiptPage({ id, expectedDigest }: { id: string; expectedDigest?: string }) {
  const [receipt, setReceipt] = useState<ReceiptViewModel | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setReceipt(null); setError('');
    api<ReceiptViewModel>(`/sessions/${encodeURIComponent(id)}/receipt${expectedDigest ? `?digest=${encodeURIComponent(expectedDigest)}` : ''}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setReceipt(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '收据暂时无法读取。'); });
    return () => controller.abort();
  }, [id, expectedDigest]);
  if (error) return <ReceiptRouteError message={error} />;
  if (!receipt) return <div className="sp-receipt"><main className="sp-receipt-paper"><div className="empty" role="status"><LoaderCircle className="spin" size={30} aria-hidden="true" /><h1>正在核验收据</h1><p>读取脱敏快照并重新计算摘要与规则。</p></div></main></div>;
  const shareUrl = `${window.location.origin}${window.location.pathname}?receipt=${encodeURIComponent(id)}&digest=${receipt.digest}`;
  return <ReceiptView receipt={receipt} shareUrl={shareUrl} expectedDigest={expectedDigest} onBack={() => { window.location.href = window.location.pathname; }} />;
}

function ReceiptRouteError({ message }: { message: string }) {
  return <div className="sp-receipt"><main className="sp-receipt-paper"><div className="empty" role="alert"><ShieldX size={30} aria-hidden="true" /><h1>无法打开这份收据</h1><p>{message}</p><a className="button secondary" href={window.location.pathname}>返回工作台</a></div></main></div>;
}

export default function App() {
  const route = receiptRouteFromSearch(window.location.search);
  if (route.kind === 'invalid') return <ReceiptRouteError message={route.message} />;
  if (route.kind === 'receipt') return <SharedReceiptPage id={route.id} expectedDigest={route.expectedDigest} />;
  return <Dashboard />;
}

function Dashboard() {
  const [tab, setActiveTab] = useState<Tab>(() => dashboardTabFromHash(window.location.hash));
  const [health, setHealth] = useState<Health | null>(null);
  const [anchorAccount, setAnchorAccount] = useState<AnchorAccount | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [task, setTask] = useState('核对 VinaPack 包装样品发票与 HanBridge 物流尾款；换地址、重复发票或含费超支时停止。');
  const [budget, setBudget] = useState('5.00');
  const [merchants, setMerchants] = useState(['atlas', 'orbit']);
  const [duration, setDuration] = useState('60');
  const [scenario, setScenario] = useState<Scenario>('fees');
  const [mode, setMode] = useState<'fixture' | 'kiln'>('fixture');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [replayBudget, setReplayBudget] = useState('8.00');
  const [replayMerchant, setReplayMerchant] = useState('original');
  const [replayExpired, setReplayExpired] = useState(false);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [verification, setVerification] = useState<EvidenceVerification | null>(null);
  const [verificationSource, setVerificationSource] = useState('');
  const [anchor, setAnchor] = useState<EvidenceAnchor | null>(null);
  const inputFile = useRef<HTMLInputElement>(null);
  const selectedId = useRef<string | undefined>(undefined);

  function navigateTab(next: Tab) {
    if (window.location.hash !== `#${next}`) window.history.pushState(null, '', `#${next}`);
    setActiveTab(next); setError('');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  useEffect(() => {
    function restoreTab() {
      setActiveTab(dashboardTabFromHash(window.location.hash));
      setError('');
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    window.addEventListener('hashchange', restoreTab);
    window.addEventListener('popstate', restoreTab);
    return () => {
      window.removeEventListener('hashchange', restoreTab);
      window.removeEventListener('popstate', restoreTab);
    };
  }, []);

  function selectSession(next: Session | null) {
    selectedId.current = next?.id;
    setSession(next);
    setReplay(null);
    setEvidence(null);
    setVerification(null);
    setVerificationSource('');
    setAnchor(null);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<Health>('/health'), api<Session[]>('/sessions')]).then(([config, history]) => {
      if (cancelled) return;
      setHealth(config);
      setMode(config.kilnConfigured ? 'kiln' : 'fixture');
      setSessions(history);
      if (history.length) { selectedId.current = history[0].id; setSession(history[0]); }
    }).catch(e => { if (!cancelled) setError(`本地服务尚未连接：${e.message}`); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!health) return;
    let active = true;
    api<AnchorAccount>('/anchor/account').then(value => { if (active) setAnchorAccount(value); })
      .catch(() => { if (active) setAnchorAccount({ configured: false, chainId: 84532, network: 'Base Sepolia' }); });
    return () => { active = false; };
  }, [health?.anchorConfigured]);

  useEffect(() => {
    if (!session || session.status === 'ready' || session.status === 'running') return;
    let active = true;
    const id = session.id;
    api<{ anchor: EvidenceAnchor | null }>(`/sessions/${id}/anchor`).then(value => {
      if (active && selectedId.current === id) setAnchor(value.anchor);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [session?.id, session?.status]);

  useEffect(() => {
    if (!session || session.status !== 'running') return;
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const updated = await api<Session>(`/sessions/${session!.id}`);
        if (disposed || selectedId.current !== updated.id) return;
        setSession(updated);
        setSessions(previous => previous.map(item => item.id === updated.id ? updated : item));
        if (updated.status === 'running') timeout = setTimeout(poll, 550);
      } catch (e) {
        if (!disposed) { setError((e as Error).message); timeout = setTimeout(poll, 1800); }
      }
    }
    timeout = setTimeout(poll, 350);
    return () => { disposed = true; clearTimeout(timeout); };
  }, [session?.id, session?.status]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function start() {
    if (!task.trim() || !Number.isFinite(Number(budget)) || Number(budget) <= 0 || !merchants.length) { setError('填写任务、预算和供应商。'); return; }
    setBusy(true); setError('');
    try {
      const created = await post<Session>('/sessions', { policy: { task: task.trim(), budgetMicros: micros(budget), allowedMerchants: merchants, expiresAt: new Date(Date.now() + Number(duration) * 60_000).toISOString() }, scenario, agentMode: mode });
      selectSession(created);
      setSessions(previous => [created, ...previous]);
      const running = await post<Session>(`/sessions/${created.id}/run`);
      if (selectedId.current === created.id) setSession(running);
      setSessions(previous => previous.map(item => item.id === running.id ? running : item));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function stop() {
    if (!session) return;
    setBusy(true);
    try {
      const stopped = await post<Session>(`/sessions/${session.id}/stop`);
      if (selectedId.current === stopped.id) setSession(stopped);
      setSessions(previous => previous.map(item => item.id === stopped.id ? stopped : item));
      setNotice('已停止。记录已保留。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function runReplay() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const result = await post<Replay>(`/sessions/${session.id}/replay`, {
        budgetMicros: micros(replayBudget),
        allowedMerchants: replayMerchant === 'original' ? session.policy.allowedMerchants : [replayMerchant],
        expiresAt: replayExpired ? new Date(new Date(session.records[0]?.context.now || session.createdAt).getTime() - 1000).toISOString() : session.policy.expiresAt,
      });
      setReplay(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function getEvidence() {
    if (!session) throw new Error('请先运行一个任务。');
    const data = await api<Evidence>(`/sessions/${session.id}/evidence`);
    setEvidence(data);
    return data;
  }

  async function exportEvidence() {
    setBusy(true); setError('');
    try { const data = await getEvidence(); download(JSON.stringify(data, null, 2), `spendproof-${data.session.id}.json`); setNotice('证据包已导出。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verify(input?: unknown) {
    setBusy(true); setError(''); setVerification(null); setVerificationSource('');
    try {
      const current = input === undefined;
      const data = current ? await getEvidence() : input;
      const result = await post<EvidenceVerification>('/verify', data);
      const digest = data && typeof data === 'object' && 'digest' in data && typeof data.digest === 'string' ? short(data.digest) : '无有效摘要';
      setVerification(result);
      setVerificationSource(`${current ? '当前运行' : '导入文件'} · ${digest}`);
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function regression() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/sessions/${session.id}/regression`);
      if (!response.ok) throw new Error('测试导出失败，请先完成一次运行。');
      download(await response.text(), `spendproof-${session.id}.test.mjs`, 'text/javascript');
      setNotice('回归测试已导出。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function openReceipt() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const receipt = await api<ReceiptViewModel>(`/sessions/${session.id}/receipt`);
      const params = new URLSearchParams({ receipt: session.id, digest: receipt.digest });
      window.location.href = `${window.location.pathname}?${params.toString()}`;
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function anchorEvidence() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const result = await post<EvidenceAnchor>(`/sessions/${session.id}/anchor`);
      setAnchor(result);
      await getEvidence();
      setNotice(result.verificationStatus === 'unavailable' ? anchorStatusText(result)
        : isAnchorFreshlyVerified(result) ? 'Base Sepolia 已确认，交易内容与证据摘要匹配。'
        : result.status === 'reverted' ? '存证交易已回滚，请检查测试网状态。'
          : result.status === 'submitted' ? '已广播测试网存证交易，尚待链上确认。'
            : result.status === 'broadcast_unknown' ? '广播结果未知，可刷新同一哈希；系统只会重播同一笔签名交易。'
              : '交易已签名并保存，尚未确认是否广播。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function refreshAnchor() {
    if (!session) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ anchor: EvidenceAnchor | null }>(`/sessions/${session.id}/anchor`);
      setAnchor(result.anchor);
      setNotice(result.anchor?.verificationStatus === 'unavailable' ? anchorStatusText(result.anchor)
        : isAnchorFreshlyVerified(result.anchor)
        ? '已从 Base Sepolia 重新核对成功回执和证据摘要。'
        : result.anchor ? '已刷新这笔交易的链上状态。' : '当前运行还没有链上存证。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const running = session?.status === 'running';
  const terminal = !!session && !running && session.status !== 'ready';
  const records = session?.records || [];
  const paid = records.filter(record => record.decision.allowed).reduce((sum, record) => sum + record.decision.totalMicros, 0);
  const blocked = records.filter(record => !record.decision.allowed).length;
  const tokens = session?.usage.reduce((sum, usage) => sum + usage.inputTokens + usage.outputTokens, 0) || 0;
  const kilnVerified = Boolean(session?.agentMode === 'kiln' && session.usage.length > 0);
  const anchorVerified = isAnchorFreshlyVerified(anchor);
  const pageCopy: Record<Tab, { eyebrow: string; title: string; description: string }> = {
    workspace: { eyebrow: 'SUPPLIER PAYMENTS', title: 'AI 读发票，\u200B规则管付款。', description: '拦截换地址、重复发票和含费超支。' },
    release: { eyebrow: 'RULE RELEASE', title: '规则改了，\u200B旧事故再跑一遍。', description: '红灯修复，绿灯发布。' },
    replay: { eyebrow: 'INCIDENT REPLAY', title: '换条件，\u200B重算原提案。', description: '0 次模型调用，0 次付款。' },
    evidence: { eyebrow: 'VERIFIABLE RECEIPT', title: '每个判断，\u200B都能复核。', description: '导出、验证、分享。' },
    settings: { eyebrow: 'STACK STATUS', title: '真实和模拟，\u200B一眼分清。', description: '模型、存证、付款分别标记。' },
  };
  const copy = pageCopy[tab];

  return <div className="app-shell">
    <div className="signal-strip" role="status"><span><i className={health ? 'online' : ''} />SPENDPROOF</span><span>KILN · {health?.model || 'QWEN3-32B'}</span><span>PAYMENT SIMULATED · PROOF LIVE</span></div>
    <header className="site-header">
      <a href="#workspace" className="brand" onClick={e => { e.preventDefault(); navigateTab('workspace'); }} aria-label="SpendProof 首页"><span className="brand-mark">S</span><span>SpendProof<span className="brand-sub">AI payment rule CI</span></span></a>
      <nav aria-label="主导航">{tabs.map(({ id, label, icon: Icon }) => <button type="button" aria-controls="dashboard-content" key={id} className={`nav-item ${tab === id ? 'active' : ''}`} aria-label={label} aria-current={tab === id ? 'page' : undefined} onClick={() => { navigateTab(id); setError(''); }}><Icon size={16} /><span>{label}</span>{id === 'replay' && blocked > 0 && <span className="nav-count">{blocked}</span>}</button>)}</nav>
      <div className="header-actions"><span className="badge neutral"><FlaskConical size={13} />付款模拟</span><button className="button header-cta" aria-label="查看接入状态" onClick={() => navigateTab('settings')}>VERIFY STACK <ArrowUpRight size={14} /></button></div>
    </header>
    <div className="session-bar">
      <div className="session-picker"><span className={`history-dot ${session?.status || 'ready'}`} /><label htmlFor="sessionSelect">当前记录</label><select id="sessionSelect" value={session?.id || ''} disabled={busy || running} onChange={e => { const next = sessions.find(item => item.id === e.target.value) || null; selectSession(next); navigateTab('workspace'); }}><option value="">新任务 · 尚未选择记录</option>{sessions.slice(0, 12).map(item => <option key={item.id} value={item.id}>{scenarios.find(s => s.id === item.scenario)?.label || item.title} · {new Date(item.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} {time(item.createdAt)}</option>)}</select></div>
      <div className="session-meta"><span>{session?.agentMode === 'kiln' && session.usage.length ? '真实 Qwen 记录' : session ? '演示记录' : '准备新运行'}</span><span>{session ? short(session.id) : 'LOCAL WORKSPACE'}</span><button className="new-run" disabled={busy || running} onClick={() => { selectSession(null); navigateTab('workspace'); }}><Plus size={15} />新建运行</button></div>
    </div>

    <div className="main-shell">
      <main id="dashboard-content" aria-labelledby="dashboard-title">
        <div className="page-heading"><div className="hero-copy"><div className="eyebrow"><span />{copy.eyebrow}</div><h1 id="dashboard-title">{copy.title}</h1><p>{copy.description}</p></div><div className="heading-actions"><span className={`proof-chip ${health?.kilnConfigured ? 'verified' : ''}`}><Cpu size={15} />{health?.kilnConfigured ? `${health.model} READY` : 'FIXTURE READY'}</span><span className="proof-chip"><ShieldCheck size={15} />CODE ENFORCED</span></div></div>

        {error && <div className="alert error" role="alert"><ShieldX size={18} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="toast" role="status"><Check size={17} />{notice}</div>}

        {tab === 'workspace' && <>
        <div className="stats-grid"><Stat label="含费上限" value={`${money(session?.policy.budgetMicros || micros(budget) || 0)}`} unit="USDC" icon={<Wallet size={19} />} sub="当前授权" /><Stat label="模拟记账" value={money(paid)} unit="USDC" icon={<ArrowUpRight size={19} />} sub="无真实转账" /><Stat label="已拦截" value={String(blocked).padStart(2, '0')} icon={<ShieldCheck size={19} />} sub={blocked ? '规则生效' : '等待检查'} accent={blocked > 0} /><Stat label="模型 Tokens" value={session?.agentMode === 'kiln' && session.usage.length ? tokens.toLocaleString() : '—'} unit={session?.usage.length ? 'tokens' : ''} icon={<Cpu size={19} />} sub={session?.agentMode === 'kiln' ? 'API 返回' : '本地样例'} /></div>
          <div className="work-grid"><section className="panel setup-panel"><div className="panel-heading"><span className="section-number">01</span><h2>创建授权</h2><span className="subtle">下一次运行</span></div>
            <div className="form-body"><ScreenshotAuthorization value={{ task, budget, duration, merchants }} disabled={busy || running} onApply={draft => { setTask(draft.task); setBudget(draft.budget); setDuration(draft.duration); setMerchants(draft.merchants); }} /><label htmlFor="task">付款任务</label><textarea id="task" value={task} onChange={e => setTask(e.target.value)} rows={3} maxLength={1000} />
              <div className="form-pair"><div><label htmlFor="budget">总预算</label><div className="unit-input"><input id="budget" type="number" min="0.01" step="0.01" max="100000" value={budget} onChange={e => setBudget(e.target.value)} /><span>USDC</span></div></div><div><label htmlFor="duration">授权有效期</label><select id="duration" value={duration} onChange={e => setDuration(e.target.value)}><option value="15">15 分钟</option><option value="60">1 小时</option><option value="1440">24 小时</option></select></div></div>
              <fieldset className="merchant-field"><legend>登记供应商 <span>固定演示地址</span></legend>{MERCHANTS.map(merchant => <label key={merchant.id} className="merchant"><input type="checkbox" checked={merchants.includes(merchant.id)} onChange={e => setMerchants(previous => e.target.checked ? [...previous, merchant.id] : previous.filter(id => id !== merchant.id))} /><span className={`merchant-avatar ${merchant.id}`}>{merchant.name[0]}</span><span>{merchant.name}<small>地址已登记</small></span><ShieldCheck size={15} /></label>)}</fieldset>
              <div className="divider" />
              <fieldset className="scenario-field"><legend>事故样例</legend><div className="scenario-grid">{scenarios.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={`scenario ${scenario === id ? 'chosen' : ''}`} aria-pressed={scenario === id} onClick={() => setScenario(id)}><Icon size={16} /><span>{label}</span></button>)}</div><p className="field-hint">{scenarios.find(item => item.id === scenario)?.description}</p></fieldset>
              <label htmlFor="agentMode">提案方式</label><select id="agentMode" value={mode} onChange={e => setMode(e.target.value as 'fixture' | 'kiln')}><option value="fixture">固定发票 · 本地</option><option value="kiln" disabled={!health?.kilnConfigured}>Kiln / {health?.model || 'qwen3-32b'}{!health?.kilnConfigured ? ' · 未配置' : kilnVerified ? ' · 已验证' : ' · 待验证'}</option></select>
              <button className="button primary start-button" disabled={busy || running || !health} onClick={start}>{busy || running ? <LoaderCircle size={17} className="spin" /> : <Play size={17} fill="currentColor" />}{running ? '任务正在运行' : '创建并运行'}<ArrowRight size={17} /></button>
              <p className="form-footer"><FlaskConical size={13} />模型可真实调用；供应商付款为模拟。</p>
            </div></section>

            <div className="run-column"><section className="panel execution-panel"><div className="panel-heading"><span className="section-number">02</span><h2>当前记录</h2>{session && <span className={`badge ${running ? 'blue' : session.status === 'error' ? 'amber' : 'neutral'}`}>{running && <Radio size={12} />}{statuses[session.status]}</span>}{running && <button className="button small stop" disabled={busy} onClick={stop}><Square size={12} fill="currentColor" />停止</button>}</div>
              {session ? <><div className="run-summary"><div><span className="subtle">{short(session.id)}</span><h3>{session.policy.task}</h3></div><div className="run-mode-badges"><span className="badge neutral">{session.agentMode === 'kiln' ? session.usage.length ? 'Qwen 真实推理' : 'Kiln 模式' : 'Fixture 提案'}</span><span className="badge neutral">付款模拟</span></div></div><div className="budget-track"><div style={{ width: `${Math.min(100, paid / session.policy.budgetMicros * 100)}%` }} /></div><div className="budget-caption"><span>已记账 {money(paid)} USDC</span><span>剩余 {money(Math.max(0, session.policy.budgetMicros - paid))} USDC</span></div><div className="records">{records.length ? records.map((record, index) => <RecordCard key={record.id} record={record} index={index} />) : <div className="pending-record">{running ? <><LoaderCircle className="spin" size={18} />正在读发票…</> : '没有付款提案。'}</div>}</div>{session.error && <p className="session-error" role="alert">{session.error}</p>}{terminal && records.length > 0 && <div className="run-actions"><span><Check size={15} />记录已保存</span><button className="text-button" onClick={() => navigateTab('release')}>检查发布规则 <ArrowRight size={15} /></button></div>}</> : <Empty title="新建付款授权">设置预算，选择事故样例。</Empty>}
            </section>
            <section className="panel timeline-panel"><div className="panel-heading"><h2><Activity size={17} />运行时间线</h2><span className="subtle">{session?.events.length || 0} 条事件</span></div>{session?.events.length ? <ol className="timeline">{session.events.map((event, index) => <li key={event.id}><span className={`timeline-node ${index === session.events.length - 1 ? 'latest' : ''}`} /><div><strong>{event.title}</strong><p>{event.detail}</p></div><time dateTime={event.at}>{time(event.at)}</time></li>)}</ol> : <div className="timeline-empty"><span className="timeline-node" /><span>授权 → 提案 → 规则 → 模拟记账</span></div>}</section>
            <div className="boundary-note"><ShieldCheck size={18} /><p><strong>模型提案。代码决定。</strong>预算、钱包、期限、去重由规则执行。</p></div>
            </div></div>
        </>}

        {tab === 'release' && <ReleaseGate session={session} />}

        {tab === 'replay' && <>
          <div className="info-banner"><RotateCcw size={20} /><div><strong>原提案，换条件。</strong><p>不调模型，不付款。</p></div><span className="badge blue">0 推理 · 0 付款</span></div>
          {!session?.records.length ? <section className="panel"><Empty icon={History} title="暂无记录">先完成一次运行。</Empty></section> : <div className="replay-layout"><section className="panel"><div className="panel-heading"><h2>调整条件</h2></div><div className="form-body"><label htmlFor="replayBudget">预算上限</label><div className="unit-input"><input id="replayBudget" type="number" min="0.01" max="100000" step="0.01" value={replayBudget} onChange={e => { setReplayBudget(e.target.value); setReplay(null); }} /><span>USDC</span></div><p className="field-hint">原始 {money(session.policy.budgetMicros)} USDC</p><label htmlFor="replayMerchant">供应商</label><select id="replayMerchant" value={replayMerchant} onChange={e => { setReplayMerchant(e.target.value); setReplay(null); }}><option value="original">原始授权</option><option value="atlas">仅 VinaPack Packaging</option><option value="orbit">仅 HanBridge Logistics</option></select><label className="checkbox-label"><input type="checkbox" checked={replayExpired} onChange={e => { setReplayExpired(e.target.checked); setReplay(null); }} />设为已过期</label><button className="button primary" disabled={busy || running} onClick={runReplay}>{busy ? <LoaderCircle className="spin" size={17} /> : <RotateCcw size={17} />}重放全部提案</button><div className="mini-note"><Timer size={15} /><span>保留原时间与顺序。</span></div></div></section><section className="panel"><div className="panel-heading"><h2>前后对比</h2><span className="subtle">{session.records.length} 笔</span></div>{replay ? <div className="replay-results">{replay.results.map((result, index) => { const record = session.records.find(r => r.id === result.recordId); return <div className="replay-result" key={result.recordId}><div className="replay-result-title"><span className="section-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{record?.quote.item || result.recordId}</strong><small>{record?.quote.merchantName} · {money(result.replayed.totalMicros)} USDC</small></div></div><div className="decision-comparison"><div><span>原规则</span><strong className={result.original.allowed ? 'green-text' : 'amber-text'}>{result.original.allowed ? '允许' : '拦截'}</strong></div><ArrowRight size={20} /><div><span>新规则</span><strong className={result.replayed.allowed ? 'green-text' : 'amber-text'}>{result.replayed.allowed ? '允许' : '拦截'}</strong></div><span className={`badge ${result.original.allowed === result.replayed.allowed ? 'neutral' : 'blue'}`}>{result.original.allowed === result.replayed.allowed ? '一致' : '已改变'}</span></div><p>{explain(result.replayed)}</p></div>; })}<div className="replay-footer"><CheckCheck size={16} />完成 · {replay.llmCalls} 模型 · {replay.paymentCalls} 付款</div></div> : <Empty icon={RotateCcw} title="换一个条件">查看判断怎样变化。</Empty>}</section></div>}
        </>}

        {tab === 'evidence' && <>
          <div className="evidence-grid"><section className="panel evidence-card"><span className="feature-icon"><FileJson size={25} /></span><h2>证据包</h2><p>授权、发票、判断、日志。</p><button className="button secondary" disabled={!terminal || busy} onClick={exportEvidence}><ArrowDownToLine size={16} />导出 JSON</button></section><section className="panel evidence-card"><span className="feature-icon"><ShieldCheck size={25} /></span><h2>独立校验</h2><p>重算摘要和规则。</p><div className="button-pair"><button className="button secondary" disabled={!terminal || busy} onClick={() => verify()}><CheckCheck size={16} />立即校验</button><button className="icon-button bordered" title="导入证据包" aria-label="导入证据包进行校验" disabled={busy} onClick={() => inputFile.current?.click()}><Plus size={18} /></button></div><input ref={inputFile} type="file" accept=".json,application/json" hidden onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { if (file.size > 2_000_000) throw new Error('证据包不能超过 2 MB。'); await verify(JSON.parse(await file.text())); } catch (err) { setError((err as Error).message); } e.target.value = ''; }} /></section><section className="panel evidence-card"><span className="feature-icon"><Terminal size={25} /></span><h2>CI 回归</h2><p>把这次事故变成测试。</p><button className="button secondary" disabled={!terminal || busy} onClick={regression}><ArrowDownToLine size={16} />导出测试</button></section><section className="panel evidence-card"><span className="feature-icon"><ReceiptText size={25} /></span><h2>验证收据</h2><p>一页交给财务和安全。</p><button className="button secondary" disabled={!terminal || busy} onClick={openReceipt}><ReceiptText size={16} />打开收据</button></section></div>
          {verification && <section className="panel verification-panel"><div className="panel-heading"><h2>{verification.valid ? <CheckCheck size={18} /> : <ShieldX size={18} />}证据校验结果</h2><span className={`badge ${verification.valid ? 'green' : 'amber'}`}>{verification.valid ? '一致性检查通过' : '发现不一致'}</span></div><div className="verification-body"><p className="verification-source">{verificationSource}</p>{verification.checks.map(check => <div key={check.key} className={`check-row ${check.passed ? '' : 'check-failed'}`}>{check.passed ? <Check size={16} /> : <X size={16} />}<strong>{check.label}</strong><span>{check.detail}</span></div>)}{verification.issues.map((issue, index) => <p className="session-error" key={index}>{issue}</p>)}</div></section>}
          <section className="panel anchor-panel"><div className="panel-heading"><h2><Link2 size={18} />测试网存证</h2><span className={`badge ${anchorVerified ? 'green' : anchor?.verificationStatus === 'unavailable' || anchor?.status === 'reverted' || anchor?.digestMatched === false ? 'amber' : health?.anchorConfigured ? 'blue' : 'neutral'}`}>{anchor ? anchorStatusText(anchor) : health?.anchorConfigured ? '已配置 · 待验证' : '尚未配置'}</span></div><div className="anchor-body"><div><h3>把摘要写到 Base Sepolia</h3><p>零金额存证。付款仍为模拟。</p>{(evidence?.digest || anchor?.digest) && <div className="digest"><span>SHA-256</span><code>{evidence?.digest || anchor?.digest}</code></div>}{anchor && <div className="anchor-result"><a href={anchor.explorerUrl} target="_blank" rel="noreferrer">核查交易 {short(anchor.transactionHash)} <ArrowUpRight size={14} /></a><span>{anchorVerified && anchor.blockNumber ? `${anchorStatusText(anchor)} · 区块 ${anchor.blockNumber}` : anchorStatusText(anchor)}</span>{anchor.account && <span>发送账户 {short(anchor.account)}</span>}</div>}</div><button className="button secondary" disabled={!terminal || busy || (!anchor && !health?.anchorConfigured)} onClick={anchor && !['prepared', 'broadcast_unknown'].includes(anchor.status) ? refreshAnchor : anchorEvidence}>{busy ? <LoaderCircle className="spin" size={16} /> : <Link2 size={16} />}{!anchor ? '提交存证' : ['prepared', 'broadcast_unknown'].includes(anchor.status) ? '继续同一交易' : '刷新回执'}</button></div></section>
          <div className="boundary-note"><CircleHelp size={18} /><p>摘要能发现改动。生产环境仍需签名授权。</p></div>
          <div className="command-panel"><Terminal size={17} /><div><strong>用导出的案例检查当前规则代码（项目根目录）</strong><code>SPENDPROOF_ENGINE=./shared/policy.ts node --import tsx --test spendproof-*.test.mjs</code></div><span>只检查规则，不调用模型或付款接口</span></div>
        </>}

        {tab === 'settings' && <div className="settings-grid"><section className="panel"><div className="panel-heading"><h2><Cpu size={18} />模型</h2><span className={`badge ${health?.kilnConfigured ? 'blue' : 'neutral'}`}>{kilnVerified ? '真实调用已验证' : health?.kilnConfigured ? '已配置 · 待调用' : '尚未配置'}</span></div><div className="settings-body"><h3>Kiln · {health?.model || 'qwen3-32b'}</h3><p>{kilnVerified ? '真实模型响应。付款模拟。' : '无密钥也可运行全部本地规则。'}</p><div className="code-block"><code>KILN_API_KEY=你的密钥<br />KILN_BASE_URL=https://api.bricksum.com/v1<br />KILN_MODEL=qwen3-32b</code></div><p className="field-hint">写入 .env，重启服务。密钥仅在服务端。</p><a className="text-button" href="https://kiln.bricksum.com/docs/en" target="_blank" rel="noreferrer">Kiln 文档 <ArrowUpRight size={15} /></a></div></section><section className="panel"><div className="panel-heading"><h2><Link2 size={18} />存证</h2><span className={`badge ${anchorVerified ? 'green' : anchor?.verificationStatus === 'unavailable' ? 'amber' : health?.anchorConfigured ? 'blue' : 'neutral'}`}>{anchorVerified ? '真实交易已核验' : anchor?.verificationStatus === 'unavailable' ? anchorStatusText(anchor) : health?.anchorConfigured ? anchorAccount?.balanceWei === '0' ? '钱包缺测试 ETH' : '钱包已配置' : '尚未配置'}</span></div><div className="settings-body"><h3>Base Sepolia</h3><p>把证据摘要写入测试网。</p>{anchorAccount?.account && <div className="code-block"><code>Chain ID · {anchorAccount.chainId}<br />Account · {anchorAccount.account}<br />Balance · {eth(anchorAccount.balanceWei)}</code></div>}<p className="field-hint">零金额自转。私钥仅在本地。</p>{anchorAccount?.balanceWei === '0' && <a className="text-button" href="https://faucet.quicknode.com/base/sepolia" target="_blank" rel="noreferrer">领取测试 ETH <ArrowUpRight size={15} /></a>}</div></section><section className="panel usage-panel"><div className="panel-heading"><h2><Activity size={18} />模型用量</h2></div>{session?.usage.length ? <div className="table-wrap"><table><thead><tr><th>流程</th><th>模型</th><th>输入</th><th>输出</th></tr></thead><tbody>{session.usage.map((usage, index) => <tr key={index}><td>{usage.flow}</td><td>{usage.model}</td><td>{usage.inputTokens.toLocaleString()}</td><td>{usage.outputTokens.toLocaleString()}</td></tr>)}</tbody></table></div> : <Empty icon={Cpu} title="暂无记录">运行 Kiln 后显示。</Empty>}<div className="usage-note">Token 不等于耗电量。</div></section></div>}
        <footer className="page-footer"><span>SpendProof <span>·</span> AI 付款规则 CI</span><span>GWDC 2026 KOREA</span></footer>
      </main>
    </div>
  </div>;
}

function Stat({ label, value, unit, icon, sub, accent }: { label: string; value: string; unit?: string; icon: ReactNode; sub: string; accent?: boolean }) {
  return <div className={`stat-card ${accent ? 'stat-accent' : ''}`}><div className="stat-label">{label}<span>{icon}</span></div><div className="stat-value">{value}{unit && <small>{unit}</small>}</div><div className="stat-sub">{sub}</div></div>;
}
