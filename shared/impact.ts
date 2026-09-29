import { evaluateProposal } from './policy';
import { MERCHANTS } from './types';
import type { Decision, EvaluationContext, PaymentRecord, Policy, Quote, Scenario } from './types';

export type CandidateRule = 'current' | 'correct' | 'ignore-fees';
export type ImpactClassification = 'falseAllow' | 'falseBlock' | 'unchanged' | 'skipped';
export type ImpactVerdict = 'pass' | 'fail' | 'empty';

/** One complete, ordered ledger. Session objects satisfy this interface directly. */
export interface ImpactScenario {
  id: string;
  title?: string;
  scenario?: Scenario;
  source?: 'history' | 'fixture';
  policy: Policy;
  records: readonly PaymentRecord[];
}

export interface ImpactCheckChange {
  key: string;
  label: string;
  expectedPassed: boolean | null;
  actualPassed: boolean | null;
  expectedDetail: string;
  actualDetail: string;
}

export interface ImpactItem {
  scenarioId: string;
  scenarioTitle: string;
  scenario?: Scenario;
  source: 'history' | 'fixture';
  recordId: string;
  quote: Quote;
  expected: Decision;
  actual: Decision | null;
  originalContext: EvaluationContext;
  candidateContext: EvaluationContext | null;
  classification: ImpactClassification;
  reason: string;
  changedChecks: ImpactCheckChange[];
  baselineIssues: string[];
}

export interface ImpactReport {
  candidate: CandidateRule;
  verdict: ImpactVerdict;
  summary: {
    scenarios: number;
    total: number;
    eligible: number;
    skipped: number;
    falseAllow: number;
    falseBlock: number;
    unchanged: number;
    affectedScenarios: number;
    skippedScenarios: number;
    emptyScenarios: number;
    /** Full quoted amounts, including fees, for false allows; not actual payments. */
    falseAllowMicros: number;
  };
  items: ImpactItem[];
  baselineIssues: { scenarioId: string; issues: string[] }[];
  llmCalls: 0;
  paymentCalls: 0;
  scope: string;
}

export interface RedGreenImpact {
  red: ImpactReport;
  green: ImpactReport;
}

const scope = '仅重放已记录的提案，不预测模型在新条件下的行为。当前规则用于核对历史基准；无法复现的整组历史已隔离，不计入候选规则闸门。没有模型调用或付款。';
const money = (value: number) => `${(value / 1_000_000).toFixed(6)} USDC`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function candidateOrThrow(candidate: CandidateRule) {
  if (!['current', 'correct', 'ignore-fees'].includes(candidate)) throw new TypeError('Unknown candidate rule.');
}

/**
 * The fault deliberately omits the current quote's fee ONLY from its budget
 * check. Its actual ledger total still includes that fee. All other protections,
 * including invalid-money rejection, are evaluated by the real policy engine.
 * This function is for offline comparison, never the payment execution path.
 */
export function evaluateCandidateRule(candidate: CandidateRule, quote: Quote, policy: Policy, context: EvaluationContext): Decision {
  candidateOrThrow(candidate);
  const correct = evaluateProposal(quote, policy, context);
  if (candidate !== 'ignore-fees' || correct.code.startsWith('INVALID_')) return correct;
  const candidateDecision = evaluateProposal({ ...quote, feeMicros: 0 }, policy, context);
  return {
    ...candidateDecision,
    totalMicros: correct.totalMicros,
    checks: candidateDecision.checks.map(check => check.key === 'budget' ? {
      ...check,
      label: 'Budget check with fee omission (fault injection)',
      detail: `故障候选：${money(context.spentMicros)} 已用 + ${money(quote.amountMicros)} 价款 / ${money(policy.budgetMicros)} 预算；本笔 ${money(quote.feeMicros)} 服务费未参与检查。实际记账仍含服务费。`,
    } : check),
    reason: candidateDecision.allowed ? '故障候选忽略本笔服务费后允许提案；仅用于离线影响分析。' : candidateDecision.reason,
  };
}

function decisionShape(value: unknown): value is Decision {
  return object(value) && typeof value.allowed === 'boolean' && typeof value.code === 'string'
    && typeof value.reason === 'string' && Number.isSafeInteger(value.totalMicros) && (value.totalMicros as number) >= 0
    && Array.isArray(value.checks) && value.checks.every(check => object(check)
      && typeof check.key === 'string' && typeof check.label === 'string'
      && typeof check.passed === 'boolean' && typeof check.detail === 'string');
}

function assertScenarios(scenarios: readonly ImpactScenario[]) {
  if (!Array.isArray(scenarios)) throw new TypeError('Impact scenarios must be an array.');
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (!object(scenario) || typeof scenario.id !== 'string' || !scenario.id.trim()
      || !object(scenario.policy) || !Array.isArray(scenario.records)) throw new TypeError('Each scenario needs an ID, policy and ordered records.');
    if (ids.has(scenario.id)) throw new TypeError('Scenario IDs must be unique.');
    ids.add(scenario.id);
    for (const record of scenario.records) {
      if (!object(record) || typeof record.id !== 'string' || !record.id.trim()
        || !object(record.quote) || !object(record.context) || !decisionShape(record.decision)) {
        throw new TypeError('Each historical record needs a quote, context and captured decision.');
      }
    }
  }
}

/** Compare rule outcomes/checks, not editorial changes to labels or descriptions. */
function decisionMatches(expected: Decision, actual: Decision) {
  const signature = (decision: Decision) => JSON.stringify({
    allowed: decision.allowed, code: decision.code, totalMicros: decision.totalMicros,
    checks: decision.checks.map(check => [check.key, check.passed]).sort(([a], [b]) => String(a).localeCompare(String(b))),
  });
  return signature(expected) === signature(actual);
}

function equalIds(actual: unknown, expected: string[]) {
  return Array.isArray(actual) && actual.every(id => typeof id === 'string')
    && JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

/** Admission checks are ledger consistency checks, not cryptographic authenticity. */
function checkBaseline(scenario: ImpactScenario): string[] {
  const issues: string[] = [];
  let spentMicros = 0;
  const paidBusinessIds: string[] = [];
  let stopped = false;
  let previousTime = -Infinity;
  const recordIds = new Set<string>();
  for (const record of scenario.records) {
    const prefix = `记录 ${record.id}`;
    if (recordIds.has(record.id)) issues.push(`${prefix}：记录 ID 重复。`);
    recordIds.add(record.id);
    const at = Date.parse(record.context.now);
    if (!Number.isFinite(at) || at < previousTime || at !== Date.parse(record.createdAt)) issues.push(`${prefix}：时间或记录顺序不一致。`);
    previousTime = at;
    if (record.context.spentMicros !== spentMicros || !equalIds(record.context.paidBusinessIds, paidBusinessIds)) {
      issues.push(`${prefix}：原始累计支出或已付业务编号与前序记录不一致。`);
    }
    if (stopped && !record.context.stopped) issues.push(`${prefix}：停止后的历史出现了重新启用。`);
    stopped ||= record.context.stopped;
    const reproduced = evaluateProposal(record.quote, scenario.policy, record.context);
    if (!decisionMatches(record.decision, reproduced)) issues.push(`${prefix}：保存的 ${record.decision.code} 与当前规则重算的 ${reproduced.code} 不一致，需人工复核基准。`);
    if (record.status !== (record.decision.allowed ? 'simulated' : 'blocked')) issues.push(`${prefix}：保存的状态与保存的判断不一致。`);
    if (record.decision.allowed) {
      spentMicros += record.decision.totalMicros;
      if (!Number.isSafeInteger(spentMicros)) issues.push(`${prefix}：累计金额超出安全整数范围。`);
      paidBusinessIds.push(record.quote.businessId);
    }
  }
  return issues;
}

function changedChecks(expected: Decision, actual: Decision): ImpactCheckChange[] {
  const keys = new Set([...expected.checks, ...actual.checks].map(check => check.key));
  return [...keys].flatMap(key => {
    const before = expected.checks.find(check => check.key === key);
    const after = actual.checks.find(check => check.key === key);
    if (before?.passed === after?.passed) return [];
    return [{ key, label: before?.label || after?.label || key,
      expectedPassed: before?.passed ?? null, actualPassed: after?.passed ?? null,
      expectedDetail: before?.detail || '', actualDetail: after?.detail || '' }];
  });
}

function describeItem(classification: Exclude<ImpactClassification, 'skipped'>, expected: Decision, actual: Decision, changes: ImpactCheckChange[]) {
  const changed = changes.map(change => `${change.label}：${change.expectedPassed ? '通过' : '未通过'} → ${change.actualPassed ? '通过' : '未通过'}`).join('；');
  if (classification === 'falseAllow') return `误放行：基准要求拦截（${expected.code}），候选却允许。${changed || actual.reason}`;
  if (classification === 'falseBlock') return `误拦截：基准允许，候选却拦截（${actual.code}）。${changed || actual.reason}`;
  return expected.allowed ? '放行结论保持一致；候选仍允许此提案。' : `拦截结论保持一致；基准 ${expected.code}，候选 ${actual.code}。`;
}

/**
 * Replay each eligible scenario from an empty ledger, in its supplied order.
 * Candidate decisions build their own cumulative balance and business IDs.
 * An inconsistent scenario is quarantined in full; it can never manufacture a
 * passing gate. Empty/all-quarantined input returns "empty", not "pass".
 */
export function evaluateRuleImpact(scenarios: readonly ImpactScenario[], candidate: CandidateRule = 'current'): ImpactReport {
  candidateOrThrow(candidate);
  assertScenarios(scenarios);
  const report: ImpactReport = {
    candidate, verdict: 'empty',
    summary: { scenarios: scenarios.length, total: 0, eligible: 0, skipped: 0,
      falseAllow: 0, falseBlock: 0, unchanged: 0, affectedScenarios: 0, skippedScenarios: 0, emptyScenarios: 0, falseAllowMicros: 0 },
    items: [], baselineIssues: [], llmCalls: 0, paymentCalls: 0, scope,
  };
  const affectedScenarios = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.records.length) report.summary.emptyScenarios++;
    const issues = checkBaseline(scenario);
    if (issues.length) {
      report.baselineIssues.push({ scenarioId: scenario.id, issues: [...issues] });
      report.summary.skippedScenarios++;
    }
    let spentMicros = 0;
    const paidBusinessIds: string[] = [];
    let stopped = false;
    for (const record of scenario.records) {
      report.summary.total++;
      const base = {
        scenarioId: scenario.id, scenarioTitle: scenario.title || scenario.id, scenario: scenario.scenario,
        source: scenario.source || 'history' as const, recordId: record.id,
        quote: structuredClone(record.quote), expected: structuredClone(record.decision), originalContext: structuredClone(record.context),
      };
      if (issues.length) {
        report.summary.skipped++;
        report.items.push({ ...base, actual: null, candidateContext: null, classification: 'skipped',
          reason: '此组历史基准无法完整复现，已隔离；不参与通过/失败判定。', changedChecks: [], baselineIssues: [...issues] });
        continue;
      }
      stopped ||= record.context.stopped;
      const context: EvaluationContext = { spentMicros, paidBusinessIds: [...paidBusinessIds], stopped, now: record.context.now };
      const actual = evaluateCandidateRule(candidate, record.quote, scenario.policy, context);
      const classification = actual.allowed === record.decision.allowed ? 'unchanged'
        : actual.allowed ? 'falseAllow' : 'falseBlock';
      const changes = changedChecks(record.decision, actual);
      report.summary.eligible++;
      report.summary[classification]++;
      if (classification !== 'unchanged') affectedScenarios.add(scenario.id);
      if (classification === 'falseAllow') {
        report.summary.falseAllowMicros += actual.totalMicros;
        if (!Number.isSafeInteger(report.summary.falseAllowMicros)) throw new RangeError('Aggregated false-allow amount exceeds safe integer precision.');
      }
      report.items.push({ ...base, actual, candidateContext: context, classification,
        reason: describeItem(classification, record.decision, actual, changes), changedChecks: changes, baselineIssues: [] });
      if (actual.allowed) {
        spentMicros += actual.totalMicros;
        paidBusinessIds.push(record.quote.businessId);
      }
    }
  }
  report.summary.affectedScenarios = affectedScenarios.size;
  report.verdict = report.summary.eligible === 0 ? 'empty'
    : report.summary.falseAllow || report.summary.falseBlock ? 'fail' : 'pass';
  return report;
}

/** Both reports evaluate exactly the same immutable recorded proposals. */
export function evaluateRedGreen(scenarios: readonly ImpactScenario[]): RedGreenImpact {
  return { red: evaluateRuleImpact(scenarios, 'ignore-fees'), green: evaluateRuleImpact(scenarios, 'current') };
}

/** Explicit synthetic fixtures for an empty workspace; never inserted as history. */
export function createImpactDemoScenarios(): ImpactScenario[] {
  const definitions: { scenario: Scenario; title: string }[] = [
    { scenario: 'normal', title: '供应商事故集 · 正常发票' },
    { scenario: 'fees', title: '供应商事故集 · 含费超预算' },
    { scenario: 'merchant', title: '供应商事故集 · 钱包被替换' },
    { scenario: 'duplicate', title: '供应商事故集 · 重复发票' },
  ];
  return definitions.map(({ scenario, title }) => {
    const id = `impact-demo:${scenario}`;
    const policy: Policy = { budgetMicros: 5_000_000, allowedMerchants: ['atlas', 'orbit'],
      expiresAt: '2026-09-28T13:00:00.000Z', task: '核对 VinaPack 包装发票与 HanBridge 物流尾款' };
    const records: PaymentRecord[] = [];
    let spentMicros = 0;
    const paidBusinessIds: string[] = [];
    for (let step = 0; step < 2; step++) {
      const merchant = MERCHANTS[step];
      const quote: Quote = {
        id: `${id}:quote-${step + 1}`, businessId: `${id}:${scenario === 'duplicate' || step === 0 ? 'INV-VP-2048' : 'INV-HB-7712'}`,
        merchantId: merchant.id, merchantName: merchant.name,
        recipient: scenario === 'merchant' && step === 1 ? '0x22222222222222222222222222222222222222a2' : merchant.recipient,
        item: step === 0 ? '包装样品定金 · INV-VP-2048' : scenario === 'duplicate' ? '重复包装发票 · INV-VP-2048' : '海运订舱尾款 · INV-HB-7712',
        amountMicros: step === 0 ? 1_500_000 : 2_000_000,
        feeMicros: scenario === 'fees' && step === 1 ? 3_000_000 : 100_000,
      };
      const context: EvaluationContext = { spentMicros, paidBusinessIds: [...paidBusinessIds], stopped: false, now: `2026-09-28T12:00:0${step}.000Z` };
      const decision = evaluateProposal(quote, policy, context);
      records.push({ id: `${id}:record-${step + 1}`, quote, context, decision, createdAt: context.now, status: decision.allowed ? 'simulated' : 'blocked' });
      if (decision.allowed) { spentMicros += decision.totalMicros; paidBusinessIds.push(quote.businessId); }
    }
    return { id, title, scenario, source: 'fixture', policy, records };
  });
}
