import { describe, expect, it } from 'vitest';
import { anchorData, transactionMatchesAnchor } from '../server/anchor';

const digest = 'a'.repeat(64);
const account = '0x1111111111111111111111111111111111111111' as const;

describe('Base Sepolia evidence anchor binding', () => {
  it('encodes a versioned evidence digest and binds zero-value self transactions', () => {
    expect(Buffer.from(anchorData(digest).slice(2), 'hex').toString()).toBe(`spendproof:v1:${digest}`);
    expect(transactionMatchesAnchor({ digest, account, from: account, to: account, value: 0n, data: anchorData(digest) })).toBe(true);
  });

  it.each([
    { from: '0x2222222222222222222222222222222222222222' as const, to: account, value: 0n, data: anchorData(digest) },
    { from: account, to: '0x2222222222222222222222222222222222222222' as const, value: 0n, data: anchorData(digest) },
    { from: account, to: account, value: 1n, data: anchorData(digest) },
    { from: account, to: account, value: 0n, data: anchorData('b'.repeat(64)) },
  ])('rejects a transaction when any bound field differs', (transaction) => {
    expect(transactionMatchesAnchor({ digest, account, ...transaction })).toBe(false);
  });

  it('rejects malformed evidence digests before signing', () => {
    expect(() => anchorData('not-a-digest')).toThrow(/SHA-256/);
  });
});
