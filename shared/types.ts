export type Scenario = 'normal' | 'fees' | 'merchant' | 'duplicate';

/** All monetary values use integer micro-USDC (1 USDC = 1_000_000). */
export interface Policy {
  budgetMicros: number;
  allowedMerchants: string[];
  expiresAt: string;
  task: string;
}

export interface Merchant {
  id: 'atlas' | 'orbit';
  name: string;
  recipient: `0x${string}`;
}

/** Demo supplier identities only. These are not real companies or payment destinations. */
export const MERCHANTS: readonly Merchant[] = Object.freeze([
  Object.freeze({ id: 'atlas', name: 'VinaPack Packaging', recipient: '0x1111111111111111111111111111111111111111' as const }),
  Object.freeze({ id: 'orbit', name: 'HanBridge Logistics', recipient: '0x2222222222222222222222222222222222222222' as const }),
]);

export interface Quote {
  id: string;
  businessId: string;
  merchantId: string;
  merchantName: string;
  recipient: string;
  item: string;
  amountMicros: number;
  feeMicros: number;
}

export interface EvaluationContext {
  spentMicros: number;
  paidBusinessIds: string[];
  stopped: boolean;
  now: string;
}

export interface DecisionCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface Decision {
  allowed: boolean;
  code: string;
  reason: string;
  checks: DecisionCheck[];
  totalMicros: number;
}

export interface PaymentRecord {
  id: string;
  quote: Quote;
  decision: Decision;
  context: EvaluationContext;
  createdAt: string;
  status: 'simulated' | 'blocked';
  /** Reserved for independently verified chain records; a simulation has no txHash. */
  txHash?: string;
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
}

export interface UsageEntry {
  flow: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  policy: Policy;
  scenario: Scenario;
  agentMode: 'fixture' | 'kiln';
  status: 'ready' | 'running' | 'completed' | 'stopped' | 'error';
  records: PaymentRecord[];
  events: TimelineEvent[];
  usage: UsageEntry[];
  error?: string;
}

export interface Evidence {
  version: '1';
  session: Session;
  digest: string;
  exportedAt: string;
}

export interface EvidenceVerification {
  valid: boolean;
  digestMatches: boolean;
  checks: DecisionCheck[];
  issues: string[];
}

/** A Base Sepolia receipt for a zero-value evidence anchor transaction. */
export interface EvidenceAnchor {
  version: '1';
  kind: 'evidence_anchor';
  sessionId: string;
  chainId: 84532;
  network: 'Base Sepolia';
  digest: string;
  exportedAt: string;
  account: `0x${string}`;
  transactionHash: `0x${string}`;
  explorerUrl: string;
  status: 'prepared' | 'submitted' | 'confirmed' | 'reverted' | 'broadcast_unknown';
  blockNumber?: string;
  transactionIndex?: number;
  gasUsed?: string;
  confirmedAt?: string;
  digestMatched?: boolean;
  /** Latest RPC lookup outcome, separate from the last known transaction status. */
  verificationStatus?: 'verified' | 'unavailable';
  lastCheckedAt?: string;
  verificationError?: string;
  note: string;
}
