// Server-only: browser views should import types.ts and policy.ts, never this file.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evaluateProposal } from './policy';
import type { Evidence, EvidenceVerification, Session } from './types';

const iso = z.string().datetime({ offset: true });
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonempty = z.string().min(1);
const checkSchema = z.object({ key: nonempty, label: z.string(), passed: z.boolean(), detail: z.string() }).strict();
const decisionSchema = z.object({
  allowed: z.boolean(), code: nonempty, reason: z.string(), checks: z.array(checkSchema), totalMicros: money,
}).strict();
const quoteSchema = z.object({
  id: nonempty, businessId: nonempty, merchantId: nonempty, merchantName: nonempty,
  recipient: z.string(), item: nonempty, amountMicros: z.number(), feeMicros: z.number(),
}).strict();
const contextSchema = z.object({
  spentMicros: money, paidBusinessIds: z.array(nonempty), stopped: z.boolean(), now: iso,
}).strict();
const sessionSchema = z.object({
  id: nonempty, title: z.string(), createdAt: iso,
  policy: z.object({ budgetMicros: money, allowedMerchants: z.array(nonempty), expiresAt: iso, task: nonempty }).strict(),
  scenario: z.enum(['normal', 'fees', 'merchant', 'duplicate']),
  agentMode: z.enum(['fixture', 'kiln']),
  status: z.enum(['ready', 'running', 'completed', 'stopped', 'error']),
  records: z.array(z.object({
    id: nonempty, quote: quoteSchema, decision: decisionSchema, context: contextSchema,
    createdAt: iso, status: z.enum(['simulated', 'blocked']), txHash: z.string().optional(),
  }).strict()),
  events: z.array(z.object({ id: nonempty, at: iso, kind: nonempty, title: z.string(), detail: z.string() }).strict()),
  usage: z.array(z.object({ flow: nonempty, inputTokens: money, outputTokens: money, model: nonempty }).strict()),
  error: z.string().optional(),
}).strict();
const evidenceSchema = z.object({ version: z.literal('1'), session: sessionSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), exportedAt: iso }).strict();

/** Stable sorted-key JSON; array order remains significant. */
export function canonicalStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null) throw new TypeError('Evidence must contain only JSON values.');
    if (ancestors.has(item)) throw new TypeError('Circular evidence is invalid.');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${item.map(encode).join(',')}]`;
    } else {
      const fields = item as Record<string, unknown>;
      result = `{${Object.keys(fields).filter((key) => fields[key] !== undefined).sort()
        .map((key) => `${JSON.stringify(key)}:${encode(fields[key])}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return encode(value);
}

export function evidenceDigest(input: Pick<Evidence, 'version' | 'session' | 'exportedAt'>): string {
  return createHash('sha256').update(canonicalStringify({
    version: input.version, session: input.session, exportedAt: input.exportedAt,
  })).digest('hex');
}

export function createEvidence(session: Session, exportedAt = new Date().toISOString()): Evidence {
  const snapshot = JSON.parse(canonicalStringify(session)) as Session;
  const payload = { version: '1' as const, session: snapshot, exportedAt };
  return { ...payload, digest: evidenceDigest(payload) };
}

/**
 * Verifies internal consistency, not a person's identity or an on-chain payment.
 * A digest is only tamper evidence against a separately trusted original digest.
 */
export function verifyEvidence(input: unknown): EvidenceVerification {
  const checks: EvidenceVerification['checks'] = [];
  const issues: string[] = [];
  const add = (key: string, label: string, passed: boolean, detail: string) => {
    checks.push({ key, label, passed, detail });
    if (!passed) issues.push(detail);
  };
  let parsed: ReturnType<typeof evidenceSchema.safeParse>;
  try {
    parsed = evidenceSchema.safeParse(input);
  } catch {
    add('schema', 'Evidence format', false, 'Evidence is not a finite, valid JSON document.');
    return { valid: false, digestMatches: false, checks, issues };
  }
  if (!parsed.success) {
    add('schema', 'Evidence format', false, parsed.error.issues.slice(0, 10)
      .map((issue) => `${issue.path.join('.') || 'evidence'}: ${issue.message}`).join('; '));
    return { valid: false, digestMatches: false, checks, issues };
  }
  add('schema', 'Evidence format', true, 'Evidence version 1 and required fields are valid.');
  const evidence = parsed.data;
  const digestMatches = evidence.digest === evidenceDigest(evidence);
  add('digest', 'SHA-256 integrity', digestMatches,
    digestMatches ? 'Content matches the included digest; compare it with a trusted original or chain anchor for authenticity.' : 'The evidence content does not match its digest.');
  const session = evidence.session;
  let spentMicros = 0;
  const paidBusinessIds: string[] = [];
  const recordIds = new Set<string>();
  let lastAt = Date.parse(session.createdAt);
  let stopped = false;
  const replayIssues: string[] = [];
  const historyIssues: string[] = [];
  if (new Set(session.policy.allowedMerchants).size !== session.policy.allowedMerchants.length) {
    historyIssues.push('Policy contains duplicate merchant IDs.');
  }
  for (const record of session.records) {
    const prefix = `Record ${record.id}`;
    if (recordIds.has(record.id)) historyIssues.push(`${prefix}: duplicate record ID.`);
    recordIds.add(record.id);
    const at = Date.parse(record.createdAt);
    if (at < lastAt || record.context.now !== record.createdAt) historyIssues.push(`${prefix}: context time or chronological order is inconsistent.`);
    lastAt = Math.max(at, lastAt);
    if (record.context.spentMicros !== spentMicros) historyIssues.push(`${prefix}: prior spending does not match the ledger.`);
    if (canonicalStringify([...record.context.paidBusinessIds].sort()) !== canonicalStringify([...paidBusinessIds].sort())) {
      historyIssues.push(`${prefix}: prior business IDs do not match the ledger.`);
    }
    if (stopped && !record.context.stopped) historyIssues.push(`${prefix}: a stopped session was resumed without a new authorization.`);
    stopped ||= record.context.stopped;
    const expected = evaluateProposal(record.quote, session.policy, record.context);
    if (canonicalStringify(expected) !== canonicalStringify(record.decision)) replayIssues.push(`${prefix}: stored decision differs from the rule evaluation.`);
    if (record.status !== (expected.allowed ? 'simulated' : 'blocked')) replayIssues.push(`${prefix}: status contradicts the evaluated decision.`);
    if (record.txHash !== undefined) historyIssues.push(`${prefix}: local simulated or blocked payments must not claim a chain transaction.`);
    if (expected.allowed) {
      spentMicros += expected.totalMicros;
      if (!Number.isSafeInteger(spentMicros)) historyIssues.push(`${prefix}: cumulative amount exceeds safe integer precision.`);
      paidBusinessIds.push(record.quote.businessId);
    }
  }
  if (Date.parse(evidence.exportedAt) < lastAt) historyIssues.push('Evidence export predates the recorded history.');
  add('decisions', 'Deterministic decision replay', replayIssues.length === 0,
    replayIssues.join(' ') || `${session.records.length} decisions reproduce exactly using the included policy and original contexts.`);
  add('history', 'Cumulative ledger consistency', historyIssues.length === 0,
    historyIssues.join(' ') || 'Cumulative spending, duplicate IDs, stop state and timestamps are consistent.');
  return { valid: issues.length === 0, digestMatches, checks, issues };
}
