// Server-only builder/verifier. Browser components import the interfaces with `import type`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalStringify, createEvidence, verifyEvidence } from './evidence';
import { evaluateProposal } from './policy';
import { MERCHANTS } from './types';
import type { Evidence, Session } from './types';

export interface ReceiptAnchor {
  kind: 'evidence_anchor';
  chainId: 84532;
  status: 'none' | 'prepared' | 'submitted' | 'broadcast_unknown' | 'confirmed' | 'reverted' | 'unverified';
  transactionHash: string | null;
  digest: string | null;
  matchesSource: boolean;
  account: string | null;
  blockNumber: string | null;
  gasUsed: string | null;
  /** Stored RPC result, not an independent assertion made by the browser. */
  digestMatched: boolean | null;
  verificationStatus?: 'verified' | 'unavailable';
  lastCheckedAt?: string;
}

export interface ReceiptViewModel {
  format: 'spendproof-receipt-v1';
  sourceEvidenceDigest: string;
  sourceCheck: 'checked_before_redaction';
  /** A separate, self-contained redacted snapshot. Its digest differs from the source. */
  evidence: Evidence;
  anchor: ReceiptAnchor;
  /** SHA-256 over the whole receipt except this field, using sorted-key JSON. */
  digest: string;
}

export interface ReceiptVerification {
  valid: boolean;
  digestMatches: boolean;
  evidenceValid: boolean;
  disclosureValid: boolean;
  trustedDigestMatches: boolean | null;
  issues: string[];
}

export interface ReceiptOptions {
  anchor?: unknown;
  /** Defense in depth: the server should provide configured secrets; values are never returned. */
  sensitiveValues?: readonly string[];
}

const digestPattern = /^[a-f0-9]{64}$/;
const transactionPattern = /^0x[a-fA-F0-9]{64}$/;
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const knownModels = new Set(['qwen3-32b', 'deepseek-v4.1-flash', 'gpt-oss-120b']);
const TASK = '原始任务正文已隐藏；此收据只公开规则核验所需的信息。';

const anchorSchema = z.object({
  kind: z.literal('evidence_anchor'), chainId: z.literal(84532),
  status: z.enum(['none', 'prepared', 'submitted', 'broadcast_unknown', 'confirmed', 'reverted', 'unverified']),
  transactionHash: z.string().regex(transactionPattern).nullable(),
  digest: z.string().regex(digestPattern).nullable(), matchesSource: z.boolean(),
  account: z.string().regex(addressPattern).nullable(),
  blockNumber: z.string().regex(decimalPattern).nullable(),
  gasUsed: z.string().regex(decimalPattern).nullable(), digestMatched: z.boolean().nullable(),
  verificationStatus: z.enum(['verified', 'unavailable']).optional(),
  lastCheckedAt: z.iso.datetime().optional(),
}).strict();
const receiptSchema = z.object({
  format: z.literal('spendproof-receipt-v1'),
  sourceEvidenceDigest: z.string().regex(digestPattern),
  sourceCheck: z.literal('checked_before_redaction'),
  evidence: z.unknown(), anchor: anchorSchema, digest: z.string().regex(digestPattern),
}).strict();

/** No source free text, URLs, errors, events, or extra fields are copied into the public snapshot. */
function redactSession(source: Session): Session {
  const merchantAliases = new Map<string, string>();
  const businessAliases = new Map<string, string>();
  const merchantId = (id: string) => {
    if (MERCHANTS.some(merchant => merchant.id === id)) return id;
    if (!merchantAliases.has(id)) merchantAliases.set(id, `unregistered-${merchantAliases.size + 1}`);
    return merchantAliases.get(id)!;
  };
  const businessId = (id: string) => {
    if (!businessAliases.has(id)) businessAliases.set(id, `business-${businessAliases.size + 1}`);
    return businessAliases.get(id)!;
  };
  const policy = {
    budgetMicros: source.policy.budgetMicros,
    allowedMerchants: source.policy.allowedMerchants.map(merchantId),
    expiresAt: source.policy.expiresAt,
    task: TASK,
  };
  const records = source.records.map((record, index) => {
    const knownMerchant = MERCHANTS.find(merchant => merchant.id === record.quote.merchantId);
    const quote = {
      id: `quote-${index + 1}`, businessId: businessId(record.quote.businessId),
      merchantId: merchantId(record.quote.merchantId), merchantName: knownMerchant?.name || '未登记供应商',
      recipient: addressPattern.test(record.quote.recipient) ? record.quote.recipient : 'invalid-address-redacted',
      item: `购买提案 ${index + 1}（原始描述已隐藏）`,
      amountMicros: record.quote.amountMicros, feeMicros: record.quote.feeMicros,
    };
    const context = {
      spentMicros: record.context.spentMicros,
      paidBusinessIds: record.context.paidBusinessIds.map(businessId),
      stopped: record.context.stopped, now: record.context.now,
    };
    return {
      id: `proposal-${index + 1}`, quote, context,
      decision: evaluateProposal(quote, policy, context),
      createdAt: record.createdAt, status: record.status,
    };
  });
  return {
    id: 'shared-session', title: 'SpendProof 只读验证收据', createdAt: source.createdAt,
    policy, scenario: source.scenario, agentMode: source.agentMode, status: source.status,
    records, events: [],
    usage: source.usage.map((usage, index) => ({
      flow: `model-call-${index + 1}`, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      model: knownModels.has(usage.model) ? usage.model : 'model-name-hidden',
    })),
  };
}

function publicAnchor(input: unknown, sourceDigest: string): ReceiptAnchor {
  const result: ReceiptAnchor = {
    kind: 'evidence_anchor', chainId: 84532, status: 'none',
    transactionHash: null, digest: null, matchesSource: false,
    account: null, blockNumber: null, gasUsed: null, digestMatched: null,
  };
  if (input === undefined || input === null) return result;
  result.status = 'unverified';
  if (typeof input !== 'object' || Array.isArray(input)) return result;
  const anchor = input as Record<string, unknown>;
  if (anchor.kind !== 'evidence_anchor' || anchor.chainId !== 84532) return result;
  if (typeof anchor.transactionHash === 'string' && transactionPattern.test(anchor.transactionHash)) result.transactionHash = anchor.transactionHash;
  if (typeof anchor.digest === 'string' && digestPattern.test(anchor.digest)) result.digest = anchor.digest;
  if (typeof anchor.account === 'string' && addressPattern.test(anchor.account)) result.account = anchor.account;
  if (typeof anchor.blockNumber === 'string' && decimalPattern.test(anchor.blockNumber)) result.blockNumber = anchor.blockNumber;
  if (typeof anchor.gasUsed === 'string' && decimalPattern.test(anchor.gasUsed)) result.gasUsed = anchor.gasUsed;
  if (typeof anchor.digestMatched === 'boolean') result.digestMatched = anchor.digestMatched;
  if (anchor.verificationStatus === 'verified' || anchor.verificationStatus === 'unavailable') result.verificationStatus = anchor.verificationStatus;
  if (typeof anchor.lastCheckedAt === 'string' && z.iso.datetime().safeParse(anchor.lastCheckedAt).success) result.lastCheckedAt = anchor.lastCheckedAt;
  result.matchesSource = result.digest === sourceDigest;
  if (result.transactionHash && result.digest && ['prepared', 'submitted', 'broadcast_unknown', 'confirmed', 'reverted'].includes(String(anchor.status))) {
    result.status = anchor.status as ReceiptAnchor['status'];
  }
  // The server supplies a refreshed RPC result. A downloaded receipt cannot independently prove it.
  return result;
}

export function receiptDigest(receipt: Omit<ReceiptViewModel, 'digest'> | ReceiptViewModel): string {
  const { digest: _digest, ...payload } = receipt as ReceiptViewModel;
  return createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

/** Only exports internally consistent evidence. A receipt does not prove source authenticity. */
export function createReceiptView(source: Evidence, options: ReceiptOptions = {}): ReceiptViewModel {
  if (!verifyEvidence(source).valid) throw new Error('Source evidence must pass integrity and rule verification before sharing.');
  const session = redactSession(source.session);
  if (session.records.some((record, index) => record.decision.allowed !== source.session.records[index].decision.allowed
    || record.decision.code !== source.session.records[index].decision.code)) {
    throw new Error('This evidence cannot be shared without changing its rule result.');
  }
  const payload: Omit<ReceiptViewModel, 'digest'> = {
    format: 'spendproof-receipt-v1', sourceEvidenceDigest: source.digest,
    sourceCheck: 'checked_before_redaction', evidence: createEvidence(session, source.exportedAt),
    anchor: publicAnchor(options.anchor, source.digest),
  };
  const receipt = { ...payload, digest: receiptDigest(payload) };
  // Never substitute arbitrary strings inside a signed/digested view: refuse the export instead.
  const serialized = canonicalStringify(receipt);
  if (options.sensitiveValues?.some(value => value.length > 0 && serialized.includes(value))) {
    throw new Error('Receipt export was refused because it contains a protected value.');
  }
  if (!verifyReceiptView(receipt).valid) throw new Error('Redacted receipt verification failed.');
  return receipt;
}

/** Validates the disclosed snapshot, not the hidden source-to-receipt linkage or a chain receipt. */
export function verifyReceiptView(input: unknown, trustedDigest?: string): ReceiptVerification {
  const failed: ReceiptVerification = {
    valid: false, digestMatches: false, evidenceValid: false, disclosureValid: false,
    trustedDigestMatches: trustedDigest === undefined ? null : false, issues: [],
  };
  try {
    const parsed = receiptSchema.safeParse(input);
    if (!parsed.success) return { ...failed, issues: ['收据格式无效。'] };
    const receipt = parsed.data as ReceiptViewModel;
    const digestMatches = receiptDigest(receipt) === receipt.digest;
    const evidenceValid = verifyEvidence(receipt.evidence).valid;
    const disclosureValid = evidenceValid
      && canonicalStringify(receipt.evidence.session) === canonicalStringify(redactSession(receipt.evidence.session));
    const trustedDigestMatches = trustedDigest === undefined ? null : digestPattern.test(trustedDigest) && receipt.digest === trustedDigest;
    const anchorMatches = receipt.anchor.matchesSource === (receipt.anchor.digest !== null && receipt.anchor.digest === receipt.sourceEvidenceDigest);
    const noneIsEmpty = receipt.anchor.status !== 'none' || (receipt.anchor.digest === null && receipt.anchor.transactionHash === null
      && receipt.anchor.account === null && receipt.anchor.blockNumber === null && receipt.anchor.gasUsed === null && receipt.anchor.digestMatched === null);
    const submittedHasHash = !['prepared', 'submitted', 'broadcast_unknown', 'confirmed', 'reverted'].includes(receipt.anchor.status)
      || (receipt.anchor.transactionHash !== null && receipt.anchor.digest !== null);
    const issues = [
      ...(!digestMatches ? ['收据内容与摘要不一致。'] : []),
      ...(!evidenceValid ? ['脱敏证据的规则或累计上下文不一致。'] : []),
      ...(!disclosureValid ? ['收据包含不在公开白名单内的信息。'] : []),
      ...(trustedDigestMatches === false ? ['收据与链接中预期的摘要不一致。'] : []),
      ...(!anchorMatches || !noneIsEmpty || !submittedHasHash ? ['链上记录的声明不一致。'] : []),
    ];
    return { valid: issues.length === 0, digestMatches, evidenceValid, disclosureValid, trustedDigestMatches, issues };
  } catch {
    return { ...failed, issues: ['收据无法解析或校验。'] };
  }
}
