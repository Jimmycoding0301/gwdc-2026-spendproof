import type { EvidenceAnchor } from '../shared/types';

export function isAnchorFreshlyVerified(anchor: EvidenceAnchor | null | undefined): boolean {
  return anchor?.status === 'confirmed' && anchor.digestMatched === true && anchor.verificationStatus === 'verified';
}

/** A stored confirmation and a successful RPC refresh are different claims. */
export function anchorStatusText(anchor: EvidenceAnchor): string {
  if (anchor.verificationStatus === 'unavailable') {
    return anchor.status === 'confirmed' ? '历史已确认，本次 RPC 未刷新' : '本次 RPC 未刷新';
  }
  if (isAnchorFreshlyVerified(anchor)) return '链上确认 · 摘要匹配';
  if (anchor.status === 'reverted') return '交易已回滚';
  if (anchor.digestMatched === false) return '交易内容不匹配';
  if (anchor.status === 'confirmed') return '历史已确认 · 待 RPC 核验';
  if (anchor.status === 'submitted') return '已广播，待确认';
  if (anchor.status === 'broadcast_unknown') return '广播结果未知';
  return '已签名，广播待核查';
}
