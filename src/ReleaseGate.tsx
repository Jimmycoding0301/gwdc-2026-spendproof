import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, FlaskConical, GitCompareArrows, LoaderCircle, Play, RotateCcw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type { BoundaryCase, BoundaryReport } from '../shared/boundaries';
import type { ImpactClassification, ImpactItem, ImpactReport } from '../shared/impact';
import { MERCHANTS } from '../shared/types';
import type { Session } from '../shared/types';
import { api } from './api';
import './release.css';

export interface ReleaseGateProps { session: Session | null }
type ImpactResponse = { source: 'history' | 'fixture'; red: ImpactReport; green: ImpactReport };
type BoundaryResponse = { sourceRecordId: string; cases: BoundaryCase[]; report: BoundaryReport };
type DisplayedBoundaries = BoundaryResponse & { sessionId: string };
type ResultFilter = 'all' | 'changed' | 'skipped';
type ImpactRun = 'fault' | 'correct' | null;

const classifications: Record<ImpactClassification, string> = {
  falseAllow: '误放行', falseBlock: '误拦截', unchanged: '结论一致', skipped: '基准已隔离',
};
const scenarioLabels = { normal: '正常发票', fees: '含费超预算', merchant: '供应商换钱包', duplicate: '重复发票' };
const checkLabels: Record<string, string> = { stopped: '任务状态', deadline: '授权期限', merchant: '供应商与钱包', duplicate: '重复发票', budget: '含费预算', input: '输入有效性' };
const money = (value: number) => (value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const short = (value: string) => value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
const legacyQuote = /Atlas Data|Orbit Research|研究|market data|Merchant acceptance/i;

/** Compare captured inputs, never candidate outputs, before calling this a red/green pair. */
function corpusSignature(report: ImpactReport) {
  return JSON.stringify(report.items.map(item => ({ scenarioId: item.scenarioId, recordId: item.recordId,
    quote: item.quote, expected: item.expected, context: item.originalContext, baselineIssues: item.baselineIssues,
  })).sort((a, b) => `${a.scenarioId}/${a.recordId}`.localeCompare(`${b.scenarioId}/${b.recordId}`)));
}

function verdictLabel(report: ImpactReport) {
  return report.verdict === 'fail' ? '发布闸门未通过' : report.verdict === 'pass' ? '本次事故集通过' : '没有可判定的案例';
}

function ImpactRow({ item }: { item: ImpactItem }) {
  const changed = item.classification === 'falseAllow' || item.classification === 'falseBlock';
  const supplier = MERCHANTS.find(merchant => merchant.id === item.quote.merchantId)?.name || item.quote.merchantName;
  const invoice = legacyQuote.test(`${item.quote.item} ${item.quote.merchantName}`) ? `历史供应商发票 · ${short(item.quote.businessId)}` : item.quote.item;
  return <details className={`rg-case rg-case-${item.classification}`}>
    <summary>
      <span className={`rg-case-icon ${changed ? 'is-fail' : item.classification === 'skipped' ? 'is-muted' : 'is-pass'}`} aria-hidden="true">
        {changed ? <X size={16} /> : item.classification === 'skipped' ? <ShieldAlert size={16} /> : <Check size={16} />}
      </span>
      <span className="rg-case-title"><strong>{invoice}</strong><span>{item.scenario ? scenarioLabels[item.scenario] : item.scenarioTitle} · {supplier}</span></span>
      <span className={`rg-pill ${changed ? 'is-fail' : item.classification === 'skipped' ? 'is-muted' : 'is-pass'}`}>{classifications[item.classification]}</span>
      <ChevronDown className="rg-case-chevron" size={15} aria-hidden="true" />
    </summary>
    <div className="rg-case-body">
      <p className="rg-reason">{item.reason}</p>
      <div className="rg-decision-pair">
        <div><span>保存的基准</span><strong>{item.expected.allowed ? '允许' : '拦截'}</strong><code>{item.expected.code}</code></div>
        <ArrowRight size={18} aria-hidden="true" />
        <div><span>候选规则</span><strong>{item.actual ? item.actual.allowed ? '允许' : '拦截' : '未纳入闸门'}</strong>{item.actual && <code>{item.actual.code}</code>}</div>
      </div>
      <dl className="rg-case-facts">
        <div><dt>发票金额</dt><dd>{money(item.quote.amountMicros)} USDC</dd></div>
        <div><dt>服务费</dt><dd>{money(item.quote.feeMicros)} USDC</dd></div>
        <div><dt>基准此前累计</dt><dd>{money(item.originalContext.spentMicros)} USDC</dd></div>
        <div><dt>候选此前累计</dt><dd>{item.candidateContext ? `${money(item.candidateContext.spentMicros)} USDC` : '—'}</dd></div>
      </dl>
      {item.changedChecks.length > 0 && <ul className="rg-check-diff">{item.changedChecks.map(change => <li key={change.key}>
        <strong>{checkLabels[change.key] || change.label}</strong>
        <p><span>基准</span>{change.expectedDetail || '没有此项检查'}</p>
        <p><span>候选</span>{change.actualDetail || '没有此项检查'}</p>
      </li>)}</ul>}
      {item.baselineIssues.length > 0 && <div className="rg-quarantine"><strong>整组历史需人工复核</strong><ul>{item.baselineIssues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul></div>}
      <p className="rg-record-id">{item.source === 'fixture' ? '合成演示记录' : '本地保存记录'} · <code>{item.recordId}</code></p>
    </div>
  </details>;
}

function ImpactResults({ report, filter, onFilterChange }: { report: ImpactReport; filter: ResultFilter; onFilterChange: (value: ResultFilter) => void }) {
  const changed = report.summary.falseAllow + report.summary.falseBlock;
  const visible = report.items.filter(item => filter === 'all' || (filter === 'skipped' ? item.classification === 'skipped'
    : item.classification === 'falseAllow' || item.classification === 'falseBlock'));
  return <section className="rg-impact-results" aria-label="规则影响报告">
    <div className={`rg-verdict rg-verdict-${report.verdict}`}>
      {report.verdict === 'pass' ? <ShieldCheck size={27} aria-hidden="true" /> : <ShieldAlert size={27} aria-hidden="true" />}
      <div><h3>{verdictLabel(report)}</h3><p>{report.summary.eligible} 条可复现基准参与判断 · {report.summary.skipped} 条隔离 · 扫描 {report.summary.total} 条记录</p></div>
      <code>{report.candidate}</code>
    </div>
    <div className="rg-summary-grid">
      <dl className="rg-counts">
        <div><dt>误放行</dt><dd className={report.summary.falseAllow ? 'rg-fail-text' : ''}>{report.summary.falseAllow}</dd></div>
        <div><dt>误拦截</dt><dd className={report.summary.falseBlock ? 'rg-fail-text' : ''}>{report.summary.falseBlock}</dd></div>
        <div><dt>结论一致</dt><dd>{report.summary.unchanged}</dd></div>
        <div><dt>基准隔离</dt><dd>{report.summary.skipped}</dd></div>
      </dl>
      <div className="rg-exposure"><span>误放行提案金额</span><strong>{money(report.summary.falseAllowMicros)} <small>USDC</small></strong><p>含服务费的完整报价，不代表已付款或实际损失。</p></div>
    </div>
    <div className="rg-result-toolbar"><h3>逐条检查</h3><div className="rg-filters" role="group" aria-label="筛选影响结果">
      {([{ id: 'changed', label: `判断变化 ${changed}` }, { id: 'all', label: `全部 ${report.summary.total}` }, { id: 'skipped', label: `隔离 ${report.summary.skipped}` }] as const).map(option =>
        <button type="button" key={option.id} aria-pressed={filter === option.id} onClick={() => onFilterChange(option.id)}>{option.label}</button>)}
    </div></div>
    <div className="rg-case-list">{visible.length ? visible.map(item => <ImpactRow key={`${item.scenarioId}/${item.recordId}`} item={item} />)
      : <p className="rg-empty">{filter === 'changed' ? '本次没有放行或拦截结论发生变化。' : filter === 'skipped' ? '没有需要隔离的历史基准。' : '当前没有可用于判断的记录。'}</p>}</div>
    {report.summary.skipped > 0 && <p className="rg-scope-note"><ShieldAlert size={15} aria-hidden="true" />隔离项仍完整保留；绿灯只表示纳入本次闸门的基准通过。</p>}
    <details className="rg-scope-details"><summary>这份报告能证明什么？</summary><p>{report.scope}</p><p>“结论一致”只表示允许/拦截结果相同；发布闸门是当前案例集的规则对照，不会部署代码，也不能替代完整支付链路验收。</p></details>
  </section>;
}

/** A local release rehearsal. Requests evaluate rules only; no code is deployed. */
export function ReleaseGate({ session }: ReleaseGateProps) {
  const instanceId = useId();
  const [source, setSource] = useState<ImpactResponse['source'] | null>(null);
  const [red, setRed] = useState<ImpactReport | null>(null);
  const [green, setGreen] = useState<ImpactReport | null>(null);
  const [running, setRunning] = useState<ImpactRun>(null);
  const [impactError, setImpactError] = useState('');
  const [filter, setFilter] = useState<ResultFilter>('changed');
  const [boundaries, setBoundaries] = useState<DisplayedBoundaries | null>(null);
  const [boundaryRunning, setBoundaryRunning] = useState(false);
  const [boundaryError, setBoundaryError] = useState('');
  const impactRequest = useRef<AbortController | null>(null);
  const boundaryRequest = useRef<AbortController | null>(null);

  useEffect(() => () => { impactRequest.current?.abort(); boundaryRequest.current?.abort(); }, []);
  useEffect(() => {
    boundaryRequest.current?.abort();
    boundaryRequest.current = null;
    setBoundaries(null); setBoundaryError(''); setBoundaryRunning(false);
  }, [session?.id]);

  async function runImpact(kind: Exclude<ImpactRun, null>) {
    if (impactRequest.current || (kind === 'correct' && !red)) return;
    const controller = new AbortController();
    impactRequest.current = controller;
    setRunning(kind); setImpactError(''); setGreen(null);
    if (kind === 'fault') setRed(null);
    try {
      const data = await api<ImpactResponse>('/impact', { method: 'POST', body: '{}', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!data.red?.summary || !data.green?.summary || !Array.isArray(data.red.items) || !Array.isArray(data.green.items)) throw new Error('影响报告格式无效，请重试。');
      if (kind === 'correct' && red && (data.source !== source || corpusSignature(data.red) !== corpusSignature(red))) {
        setRed(null); setSource(null);
        throw new Error('本地历史在两次运行之间发生变化。请重新运行故障候选，以同一组记录完成红绿对照。');
      }
      setSource(data.source);
      if (kind === 'fault') {
        setRed(data.red);
        setFilter(data.red.summary.falseAllow + data.red.summary.falseBlock ? 'changed' : 'all');
      } else {
        setGreen(data.green);
        setFilter(data.green.summary.falseAllow + data.green.summary.falseBlock ? 'changed' : 'all');
      }
    } catch (error) {
      if (!controller.signal.aborted) setImpactError(error instanceof Error ? error.message : '影响报告暂时无法生成。');
    } finally {
      if (impactRequest.current === controller) impactRequest.current = null;
      if (!controller.signal.aborted) setRunning(null);
    }
  }

  async function generateBoundaries() {
    if (!session?.records.length || session.status === 'running' || boundaryRequest.current) return;
    const sessionId = session.id;
    const controller = new AbortController();
    boundaryRequest.current = controller;
    setBoundaryRunning(true); setBoundaryError(''); setBoundaries(null);
    try {
      const data = await api<BoundaryResponse>(`/sessions/${encodeURIComponent(sessionId)}/boundaries`, { method: 'POST', body: '{}', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.cases) || !Array.isArray(data.report?.results)) throw new Error('边界案例响应格式无效，请重试。');
      setBoundaries({ ...data, sessionId });
    } catch (error) {
      if (!controller.signal.aborted) setBoundaryError(error instanceof Error ? error.message : '无法生成边界案例。');
    } finally {
      if (boundaryRequest.current === controller) boundaryRequest.current = null;
      if (!controller.signal.aborted) setBoundaryRunning(false);
    }
  }

  const report = green || red;
  const boundaryResult = boundaries?.sessionId === session?.id ? boundaries : null;
  const boundaryDisabledReason = !session ? '先选择一份已有采购提案的运行记录。'
    : session.status === 'running' ? '当前任务仍在运行，结束或停止后可生成边界案例。'
      : !session.records.length ? '当前记录没有采购提案，请先完成一次运行。' : '';
  const sourceRecord = boundaryResult && session?.records.find(record => record.id === boundaryResult.sourceRecordId);
  const liveStatus = running === 'fault' ? '正在运行忽略手续费的故障候选。' : running === 'correct' ? '正在用相同历史重跑正确规则。'
    : report ? `${verdictLabel(report)}。误放行 ${report.summary.falseAllow} 条，误拦截 ${report.summary.falseBlock} 条，结论一致 ${report.summary.unchanged} 条，隔离 ${report.summary.skipped} 条。` : '';

  return <div className="release-gate">
    <section className="rg-panel" aria-labelledby={`${instanceId}-title`}>
      <header className="rg-heading"><div><p className="rg-eyebrow"><span /> RULE RELEASE</p><h2 id={`${instanceId}-title`}>旧事故，再跑一遍。</h2><p>同一组供应商付款。先红，修复后绿。</p></div><span className="rg-offline"><FlaskConical size={15} aria-hidden="true" />0 模型 · 0 付款</span></header>
      <ol className="rg-steps" aria-label="发布闸门操作顺序">
        <li className={`rg-step ${red ? `rg-step-${red.verdict}` : ''}`}>
          <div className="rg-step-label"><span>01</span><p>故障规则</p>{red && <span className={`rg-pill ${red.verdict === 'fail' ? 'is-fail' : red.verdict === 'pass' ? 'is-pass' : 'is-muted'}`}>{red.verdict === 'fail' ? '红灯' : red.verdict === 'pass' ? '未触发' : '无基准'}</span>}</div>
          <h3>忽略手续费</h3><p className="rg-formula">已用 + 发票金额 <span>≤ 预算</span></p><p className="rg-step-copy">找出被错误放行的旧发票。</p>
          <button className="rg-button rg-primary" type="button" disabled={running !== null} onClick={() => void runImpact('fault')}>{running === 'fault' ? <LoaderCircle className="rg-spin" size={16} aria-hidden="true" /> : red ? <RotateCcw size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{running === 'fault' ? '正在测试故障候选…' : red ? '重新运行故障候选' : '运行故障候选'}<ArrowUpRight size={16} aria-hidden="true" /></button>
          {red && <p className="rg-step-result">{red.summary.falseAllow} 笔误放行 · {red.summary.falseBlock} 笔误拦截</p>}
        </li>
        <li className={`rg-step ${green ? `rg-step-${green.verdict}` : ''}`}>
          <div className="rg-step-label"><span>02</span><p>正确规则</p>{green && <span className={`rg-pill ${green.verdict === 'pass' ? 'is-pass' : green.verdict === 'fail' ? 'is-fail' : 'is-muted'}`}>{green.verdict === 'pass' ? '绿灯' : green.verdict === 'fail' ? '仍有差异' : '无基准'}</span>}</div>
          <h3>费用完整计入</h3><p className="rg-formula">已用 + 发票金额 <ins>+ 服务费</ins> <span>≤ 预算</span></p><p className="rg-step-copy">同一事故集，重新检查。</p>
          <button className="rg-button rg-secondary" type="button" disabled={!red || red.verdict === 'empty' || running !== null} aria-describedby={`${instanceId}-repair-note`} onClick={() => void runImpact('correct')}>{running === 'correct' ? <LoaderCircle className="rg-spin" size={16} aria-hidden="true" /> : <CheckCheck size={16} aria-hidden="true" />}{running === 'correct' ? '正在重跑正确规则…' : '应用正确规则并重跑'}<ArrowRight size={16} aria-hidden="true" /></button>
          <p id={`${instanceId}-repair-note`} className="rg-step-result">{green ? `${green.summary.unchanged} 条结论一致 · ${green.summary.skipped} 条基准隔离` : !red ? '先运行左侧故障候选，解锁这一步。' : red.verdict === 'empty' ? '没有有效基准，暂不能完成红绿对照。' : '仅切换本次报告候选，不修改或部署支付引擎。'}</p>
        </li>
      </ol>
      <p className="rg-live-status" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</p>
      {impactError && <p className="rg-error" role="alert"><ShieldAlert size={17} aria-hidden="true" />{impactError}</p>}
      {source && <p className="rg-source"><GitCompareArrows size={16} aria-hidden="true" />{source === 'history' ? '数据范围：本机保存的全部提案，可能包含演示运行；与下方当前会话的边界案例分开计算。' : '数据范围：没有本地历史，使用明确标记的四组固定演示案例。'}</p>}
      {red?.verdict === 'pass' && !green && <p className="rg-neutral-note">这批事故没有亮红灯。先运行“含费超支”样例。</p>}
      {report && <ImpactResults report={report} filter={filter} onFilterChange={setFilter} />}
    </section>

    <section className="rg-panel rg-boundaries" aria-labelledby={`${instanceId}-boundaries-title`}>
      <header className="rg-heading"><div><p className="rg-eyebrow"><span /> EDGE CASES</p><h2 id={`${instanceId}-boundaries-title`}>一张发票，九个边界。</h2><p>差 1 micro-USDC、到期瞬间、换钱包、重复编号。</p></div><span className="rg-offline"><FlaskConical size={15} aria-hidden="true" />0 模型 · 0 付款</span></header>
      <div className="rg-boundary-action"><div><span className="rg-small-label">当前会话</span><strong>{session?.title || '尚未选择运行记录'}</strong><p id={`${instanceId}-boundary-note`}>{boundaryDisabledReason || `将使用 ${short(session!.id)} 中的原始提案；不会修改原事故。`}</p></div><button className="rg-button rg-secondary" type="button" disabled={Boolean(boundaryDisabledReason) || boundaryRunning} aria-describedby={`${instanceId}-boundary-note`} onClick={() => void generateBoundaries()}>{boundaryRunning ? <LoaderCircle className="rg-spin" size={16} aria-hidden="true" /> : <FlaskConical size={16} aria-hidden="true" />}{boundaryRunning ? '正在生成并检查…' : boundaryResult ? '重新生成 9 个边界案例' : '生成 9 个边界案例'}<ArrowRight size={16} aria-hidden="true" /></button></div>
      <p className="rg-live-status" role="status" aria-live="polite" aria-atomic="true">{boundaryRunning ? '正在生成并执行边界案例。' : boundaryResult ? `${boundaryResult.report.total} 个合成案例，${boundaryResult.report.total - boundaryResult.report.failed} 个符合预期，${boundaryResult.report.failed} 个失败。` : ''}</p>
      {boundaryError && <p className="rg-error" role="alert"><ShieldAlert size={17} aria-hidden="true" />{boundaryError}</p>}
      {boundaryResult && <>
        <div className={`rg-boundary-verdict ${boundaryResult.report.passed ? 'is-pass' : 'is-fail'}`}><span>{boundaryResult.report.passed ? <ShieldCheck size={24} aria-hidden="true" /> : <ShieldAlert size={24} aria-hidden="true" />}<strong>{boundaryResult.report.total - boundaryResult.report.failed}<small> / {boundaryResult.report.total}</small></strong>案例符合预期</span><p>“符合预期”包含正确拦截，不表示所有提案被允许。</p></div>
        <p className="rg-source">源提案：{sourceRecord?.quote.item || short(boundaryResult.sourceRecordId)} · <code>{short(boundaryResult.sourceRecordId)}</code> · 下方均为合成用例</p>
        {boundaryResult.report.issues.map((issue, index) => <p key={`${index}-${issue}`} className="rg-error" role="alert">{issue}</p>)}
        <div className="rg-boundary-grid">{boundaryResult.report.results.map((result, index) => {
          const boundary = boundaryResult.cases.find(item => item.id === result.caseId);
          return <details className={`rg-boundary-case ${result.passed ? '' : 'rg-boundary-failed'}`} key={result.caseId}>
            <summary><span className="rg-boundary-number">{String(index + 1).padStart(2, '0')}</span><strong>{result.label}</strong><span className={`rg-pill ${result.passed ? 'is-pass' : 'is-fail'}`}>{result.passed ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}{result.passed ? '通过' : '失败'}</span><ChevronDown className="rg-case-chevron" size={14} aria-hidden="true" /></summary>
            <div className="rg-boundary-detail"><p>{boundary?.description}</p><dl><div><dt>独立预期</dt><dd>{result.expected.allowed ? '允许' : '拦截'} <code>{result.expected.code}</code></dd></div><div><dt>当前规则</dt><dd>{result.actual ? result.actual.allowed ? '允许' : '拦截' : '未返回判断'} {result.actual && <code>{result.actual.code}</code>}</dd></div></dl>{result.error && <p className="rg-fail-text">{result.error}</p>}{result.actual && <p>{result.actual.reason}</p>}</div>
          </details>;
        })}</div>
        <details className="rg-scope-details"><summary>合成案例调整了哪些条件？</summary><ul>{boundaryResult.cases[0]?.normalization.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul><p>这些用例验证局部边界，不是新增历史付款或真实模型请求。</p></details>
      </>}
    </section>
  </div>;
}

export default ReleaseGate;
