import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import type { TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEvidence } from '../shared/evidence';
import type { StoredEvidenceAnchor } from '../server/store';

// RPC and disk are entirely mocked. The well-known synthetic key is used only
// for local serialization/signature checks; these tests cannot send a network request.
const mocks = vi.hoisted(() => ({
  rpc: {
    getChainId: vi.fn(), getBalance: vi.fn(), getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(), sendRawTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(),
  },
  wallet: { prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() },
  config: { rpcUrl: 'http://127.0.0.1:1', testnetPrivateKey: `0x${'1'.repeat(64)}`, enabled: true },
  readAnchor: vi.fn(), persistAnchor: vi.fn(),
}));
vi.mock('viem', async importOriginal => ({
  ...await importOriginal<typeof import('viem')>(),
  createPublicClient: () => mocks.rpc, createWalletClient: () => mocks.wallet,
}));
vi.mock('../server/config.js', () => ({ config: mocks.config, anchorConfigured: () => mocks.config.enabled }));
vi.mock('../server/store.js', () => ({ readAnchor: mocks.readAnchor, persistAnchor: mocks.persistAnchor }));
import { anchorData, anchorEvidence, getStoredAnchor } from '../server/anchor';

const privateKey = `0x${'1'.repeat(64)}` as const;
const account = privateKeyToAccount(privateKey);
const blockHash = `0x${'b'.repeat(64)}` as const;
const evidence = createEvidence({
  id: '572c7403-e6b5-4a46-909b-ff9d5cb10923', title: 'Offline anchor test',
  createdAt: '2026-09-28T12:00:00.000Z', status: 'completed', agentMode: 'fixture', scenario: 'normal',
  policy: { budgetMicros: 5_000_000, allowedMerchants: ['atlas'], expiresAt: '2026-09-28T13:00:00.000Z', task: 'Offline test' },
  records: [], events: [], usage: [],
}, '2026-09-28T12:00:01.000Z');
function request() {
  return { chainId: 84532, type: 'eip1559' as const, nonce: 0, gas: 30_000n,
    maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, to: account.address,
    value: 0n, data: anchorData(evidence.digest) };
}
let stored: StoredEvidenceAnchor | undefined;
let writes: StoredEvidenceAnchor[];

async function seed(status: StoredEvidenceAnchor['status'] = 'prepared') {
  const serializedTransaction = await account.signTransaction(request()) as TransactionSerialized;
  const transactionHash = keccak256(serializedTransaction);
  stored = { version: '1', kind: 'evidence_anchor', sessionId: evidence.session.id,
    chainId: 84532, network: 'Base Sepolia', account: account.address,
    digest: evidence.digest, exportedAt: evidence.exportedAt, transactionHash,
    explorerUrl: `https://sepolia.basescan.org/tx/${transactionHash}`, status,
    serializedTransaction, note: 'Synthetic offline test.' };
  return stored;
}

function mined(status: 'success' | 'reverted' = 'success', input = anchorData(evidence.digest)) {
  mocks.rpc.getTransactionReceipt.mockImplementation(async () => ({
    transactionHash: stored!.transactionHash, blockHash, blockNumber: 123n,
    transactionIndex: 0, gasUsed: 24_000n, status,
  }));
  mocks.rpc.getTransaction.mockImplementation(async () => ({
    hash: stored!.transactionHash, blockHash, blockNumber: 123n,
    from: account.address, to: account.address, value: 0n, input,
  }));
}

beforeEach(() => {
  vi.resetAllMocks(); stored = undefined; writes = [];
  mocks.config.enabled = true;
  mocks.config.testnetPrivateKey = privateKey;
  mocks.rpc.getChainId.mockResolvedValue(84532);
  mocks.rpc.getBalance.mockResolvedValue(10n ** 18n);
  mocks.rpc.getTransactionReceipt.mockRejectedValue(new Error('Not mined.'));
  mocks.rpc.getTransaction.mockRejectedValue(new Error('Not mined.'));
  mocks.rpc.waitForTransactionReceipt.mockRejectedValue(new Error('Offline timeout.'));
  mocks.rpc.sendRawTransaction.mockImplementation(async ({ serializedTransaction }: { serializedTransaction: TransactionSerialized }) => keccak256(serializedTransaction));
  mocks.wallet.prepareTransactionRequest.mockImplementation(async () => request());
  mocks.wallet.signTransaction.mockImplementation(async () => account.signTransaction(request()));
  mocks.readAnchor.mockImplementation(async () => structuredClone(stored));
  mocks.persistAnchor.mockImplementation(async (_id: string, value: StoredEvidenceAnchor) => {
    stored = structuredClone(value); writes.push(structuredClone(value));
  });
});

describe('testnet evidence anchor state machine (offline only)', () => {
  it('persists before broadcasting, verifies mined content and never signs twice for the same evidence', async () => {
    mocks.rpc.sendRawTransaction.mockImplementation(async ({ serializedTransaction }: { serializedTransaction: TransactionSerialized }) => {
      expect(stored?.status).toBe('prepared');
      expect(stored?.serializedTransaction).toBe(serializedTransaction);
      mined();
      return keccak256(serializedTransaction);
    });
    const result = await anchorEvidence(evidence);
    expect(result).toMatchObject({ status: 'confirmed', digestMatched: true, verificationStatus: 'verified', blockNumber: '123', gasUsed: '24000' });
    expect(result).not.toHaveProperty('serializedTransaction');
    expect(stored?.serializedTransaction).toBeUndefined();
    expect(writes.map(write => write.status)).toEqual(['prepared', 'submitted', 'confirmed']);
    expect(await anchorEvidence(evidence)).toMatchObject({ transactionHash: result.transactionHash, status: 'confirmed' });
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('recovers a prepared transaction through a read-only lookup with signing disabled', async () => {
    await seed(); mined(); mocks.config.enabled = false; mocks.config.testnetPrivateKey = '';
    expect(await getStoredAnchor(evidence.session.id)).toMatchObject({ status: 'confirmed', digestMatched: true, verificationStatus: 'verified' });
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('recovers an unknown broadcast using exactly the same signed bytes and hash', async () => {
    mocks.rpc.sendRawTransaction.mockRejectedValueOnce(new Error('Synthetic network failure.'));
    const first = await anchorEvidence(evidence);
    expect(first.status).toBe('broadcast_unknown');
    expect(first.verificationStatus).toBe('unavailable');
    const raw = stored!.serializedTransaction;
    mocks.rpc.sendRawTransaction.mockImplementationOnce(async ({ serializedTransaction }: { serializedTransaction: TransactionSerialized }) => {
      expect(serializedTransaction).toBe(raw); mined(); return keccak256(serializedTransaction);
    });
    const recovered = await anchorEvidence(evidence);
    expect(recovered).toMatchObject({ status: 'confirmed', digestMatched: true, transactionHash: first.transactionHash });
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it('checks the actual RPC chain again immediately before first broadcast', async () => {
    mocks.rpc.getChainId.mockResolvedValueOnce(84532).mockResolvedValue(1);
    await expect(anchorEvidence(evidence)).rejects.toThrow('No transaction was sent');
    expect(stored?.status).toBe('prepared');
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses exact-byte recovery when the configured endpoint is on the wrong chain', async () => {
    await seed('broadcast_unknown'); mocks.rpc.getChainId.mockResolvedValue(1);
    await expect(anchorEvidence(evidence)).rejects.toThrow('No transaction was sent');
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it.each(['hash', 'recipient', 'chain'] as const)('refuses tampered stored signed material: %s', async tamper => {
    await seed();
    if (tamper === 'hash') stored!.transactionHash = `0x${'c'.repeat(64)}`;
    else {
      const serializedTransaction = await account.signTransaction({ ...request(),
        ...(tamper === 'recipient' ? { to: '0x2222222222222222222222222222222222222222' as const } : { chainId: 1 }),
      }) as TransactionSerialized;
      stored!.serializedTransaction = serializedTransaction;
      stored!.transactionHash = keccak256(serializedTransaction);
    }
    await expect(anchorEvidence(evidence)).rejects.toThrow('Nothing was broadcast');
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects an evidence digest mismatch before signing or submitting', async () => {
    await seed();
    await expect(anchorEvidence({ ...evidence, digest: '0'.repeat(64) })).rejects.toThrow('different evidence digest');
    expect(mocks.rpc.getChainId).not.toHaveBeenCalled();
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('keeps historical confirmation while marking the latest failed lookup unavailable and excluding private fields', async () => {
    await seed('confirmed');
    Object.assign(stored!, { digestMatched: true, verificationStatus: 'verified',
      password: 'synthetic-password-must-not-be-public', privateKey: privateKey,
      verificationError: 'synthetic-private-error', explorerUrl: 'javascript:alert(1)' });
    mocks.rpc.getChainId.mockRejectedValue(new Error('synthetic-private-error'));
    const result = await getStoredAnchor(evidence.session.id);
    expect(result).toMatchObject({ status: 'confirmed', digestMatched: true, verificationStatus: 'unavailable' });
    expect(result?.lastCheckedAt).toMatch(/^\d{4}-/);
    for (const value of ['synthetic-password', privateKey, 'synthetic-private-error', 'serializedTransaction', 'javascript:']) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(mocks.persistAnchor).not.toHaveBeenCalled();
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('reports successful mining with mismatched calldata without asserting an evidence match', async () => {
    await seed(); mined('success', anchorData('0'.repeat(64)));
    expect(await getStoredAnchor(evidence.session.id)).toMatchObject({ status: 'confirmed', digestMatched: false, verificationStatus: 'verified' });
  });

  it('reports a reverted anchor and does not rebroadcast it', async () => {
    await seed(); mined('reverted');
    expect(await anchorEvidence(evidence)).toMatchObject({ status: 'reverted', verificationStatus: 'verified' });
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects a receipt for a different hash or block rather than asserting confirmation', async () => {
    await seed(); mined();
    mocks.rpc.getTransaction.mockResolvedValue({ hash: `0x${'c'.repeat(64)}`, blockHash, blockNumber: 123n,
      from: account.address, to: account.address, value: 0n, input: anchorData(evidence.digest) });
    expect(await getStoredAnchor(evidence.session.id)).toMatchObject({ status: 'prepared', verificationStatus: 'unavailable' });
    expect(mocks.persistAnchor).not.toHaveBeenCalled();
  });

  it('rejects concurrent submission without signing or broadcasting a second transaction', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.wallet.prepareTransactionRequest.mockImplementation(async () => { await gate; return request(); });
    const first = anchorEvidence(evidence);
    await expect(anchorEvidence(evidence)).rejects.toThrow('Another evidence anchor');
    release(); await first;
    expect(mocks.wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('never signs when the test account cannot cover the prepared gas bound', async () => {
    mocks.rpc.getBalance.mockResolvedValue(0n);
    await expect(anchorEvidence(evidence)).rejects.toThrow('needs test ETH');
    expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
    expect(mocks.persistAnchor).not.toHaveBeenCalled();
    expect(mocks.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});
