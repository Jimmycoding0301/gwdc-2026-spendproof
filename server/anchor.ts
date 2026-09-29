import { createPublicClient, createWalletClient, http, keccak256, parseTransaction, recoverTransactionAddress, toHex } from 'viem';
import type { TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { Evidence, EvidenceAnchor } from '../shared/types.js';
import { anchorConfigured, config } from './config.js';
import { persistAnchor, readAnchor } from './store.js';
import type { StoredEvidenceAnchor } from './store.js';

let anchorBusy = false;

export function anchorData(digest: string): `0x${string}` {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Evidence digest must be a lowercase SHA-256 hex string.');
  return toHex(`spendproof:v1:${digest}`);
}

export function transactionMatchesAnchor(input: {
  digest: string;
  account: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  value: bigint;
  data: `0x${string}`;
}) {
  const account = input.account.toLowerCase();
  return input.from.toLowerCase() === account
    && input.to?.toLowerCase() === account
    && input.value === 0n
    && input.data.toLowerCase() === anchorData(input.digest).toLowerCase();
}

function publicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 1 }) });
}

function publicAnchor(anchor: StoredEvidenceAnchor): EvidenceAnchor {
  // Never spread a persisted object into an API response: recovery material and
  // future private fields must stay server-side even when loaded from disk.
  return {
    version: anchor.version, kind: anchor.kind, sessionId: anchor.sessionId,
    chainId: anchor.chainId, network: anchor.network, digest: anchor.digest,
    exportedAt: anchor.exportedAt, account: anchor.account,
    transactionHash: anchor.transactionHash,
    explorerUrl: `https://sepolia.basescan.org/tx/${anchor.transactionHash}`,
    status: anchor.status, blockNumber: anchor.blockNumber,
    transactionIndex: anchor.transactionIndex, gasUsed: anchor.gasUsed,
    confirmedAt: anchor.confirmedAt, digestMatched: anchor.digestMatched,
    verificationStatus: anchor.verificationStatus, lastCheckedAt: anchor.lastCheckedAt,
    verificationError: anchor.verificationStatus === 'unavailable'
      ? 'The latest RPC lookup did not complete. Previously recorded transaction status is retained.' : undefined,
    note: anchor.note,
  };
}

export async function getAnchorAccount() {
  if (!anchorConfigured()) return { configured: false, chainId: 84532 as const, network: 'Base Sepolia' as const };
  const client = publicClient();
  const account = privateKeyToAccount(config.testnetPrivateKey as `0x${string}`);
  const [chainId, balance] = await Promise.all([client.getChainId(), client.getBalance({ address: account.address })]);
  if (chainId !== 84532) throw new Error('RPC chain ID is not Base Sepolia (84532).');
  return { configured: true, chainId: 84532 as const, network: 'Base Sepolia' as const, account: account.address, balanceWei: balance.toString() };
}

async function refreshAnchor(anchor: StoredEvidenceAnchor): Promise<StoredEvidenceAnchor> {
  if (!['prepared', 'submitted', 'broadcast_unknown', 'confirmed', 'reverted'].includes(anchor.status)) return anchor;
  const client = publicClient();
  const lastCheckedAt = new Date().toISOString();
  try {
    if (await client.getChainId() !== 84532) throw new Error('RPC chain ID is not Base Sepolia.');
    const [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash: anchor.transactionHash }),
      client.getTransaction({ hash: anchor.transactionHash }),
    ]);
    if (receipt.transactionHash.toLowerCase() !== anchor.transactionHash.toLowerCase()
      || transaction.hash.toLowerCase() !== anchor.transactionHash.toLowerCase()
      || transaction.blockHash !== receipt.blockHash
      || transaction.blockNumber !== receipt.blockNumber) {
      throw new Error('RPC receipt and transaction do not describe the same mined transaction.');
    }
    const digestMatched = transactionMatchesAnchor({
      digest: anchor.digest,
      account: anchor.account,
      from: transaction.from,
      to: transaction.to,
      value: transaction.value,
      data: transaction.input,
    });
    const refreshed: StoredEvidenceAnchor = {
      ...anchor,
      status: receipt.status === 'success' ? 'confirmed' : 'reverted',
      blockNumber: receipt.blockNumber.toString(),
      transactionIndex: receipt.transactionIndex,
      gasUsed: receipt.gasUsed.toString(),
      confirmedAt: anchor.confirmedAt ?? new Date().toISOString(),
      digestMatched,
      verificationStatus: 'verified', lastCheckedAt, verificationError: undefined,
      serializedTransaction: undefined,
      note: receipt.status === 'success' && digestMatched
        ? 'Confirmed zero-value evidence anchor. Sender, recipient, value and calldata match this evidence digest; no merchant payment occurred.'
        : receipt.status === 'success'
          ? 'The transaction confirmed, but its sender, recipient, value or calldata does not match this evidence anchor.'
        : 'The evidence anchor transaction reverted and does not satisfy the chain-record requirement.',
    };
    await persistAnchor(anchor.sessionId, refreshed);
    return refreshed;
  } catch {
    // Preserve historical confirmation without presenting a failed lookup as a
    // fresh verification. Do not persist RPC exceptions or overwrite the last
    // successful on-disk receipt merely because a node is unavailable.
    return {
      ...anchor, verificationStatus: 'unavailable', lastCheckedAt,
      verificationError: 'The latest RPC lookup did not complete. Previously recorded transaction status is retained.',
    };
  }
}

export async function getStoredAnchor(sessionId: string) {
  const anchor = await readAnchor(sessionId);
  return anchor ? publicAnchor(await refreshAnchor(anchor)) : undefined;
}

async function broadcastAndConfirm(anchor: StoredEvidenceAnchor, serializedTransaction: TransactionSerialized) {
  const client = publicClient();
  const parsed = parseTransaction(serializedTransaction);
  const recoveredFrom = await recoverTransactionAddress({ serializedTransaction });
  if (keccak256(serializedTransaction).toLowerCase() !== anchor.transactionHash.toLowerCase()
    || parsed.chainId !== 84532
    || !parsed.to
    || !transactionMatchesAnchor({
      digest: anchor.digest,
      account: anchor.account,
      from: recoveredFrom,
      to: parsed.to,
      value: parsed.value ?? 0n,
      data: parsed.data ?? '0x',
    })) {
    throw new Error('Stored signed transaction does not match the zero-value evidence anchor. Nothing was broadcast.');
  }
  // Check the endpoint again for both first submission and exact-byte recovery.
  // Keep this outside the ambiguous-broadcast catch: nothing was sent on failure.
  if (await client.getChainId() !== 84532) {
    throw new Error('RPC chain ID is not Base Sepolia (84532). No transaction was sent.');
  }
  try {
    const sentHash = await client.sendRawTransaction({ serializedTransaction });
    if (sentHash.toLowerCase() !== anchor.transactionHash.toLowerCase()) throw new Error('RPC returned a different transaction hash.');
    anchor.status = 'submitted';
    anchor.note = 'Exact signed zero-value anchor broadcast; waiting for a Base Sepolia receipt.';
  } catch {
    anchor.status = 'broadcast_unknown';
    anchor.note = 'RPC broadcast outcome is unknown. The same signed transaction can be checked or rebroadcast; no replacement transaction will be generated.';
  }
  anchor.serializedTransaction = serializedTransaction;
  await persistAnchor(anchor.sessionId, anchor);
  try {
    await client.waitForTransactionReceipt({ hash: anchor.transactionHash, confirmations: 1, timeout: 60_000 });
  } catch {
    // The transaction can still confirm later; GET /anchor rechecks the exact hash.
  }
  return refreshAnchor(anchor);
}

export async function anchorEvidence(evidence: Evidence) {
  if (!anchorConfigured()) throw new Error('Testnet anchoring is disabled or its testnet key is not configured.');
  if (anchorBusy) throw new Error('Another evidence anchor is being submitted. Retry after its status is known.');
  anchorBusy = true;
  try {
    const existing = await readAnchor(evidence.session.id);
    if (existing) {
      if (existing.digest !== evidence.digest) throw new Error('Stored anchor belongs to a different evidence digest. Nothing was broadcast.');
      const refreshed = await refreshAnchor(existing);
      if (['confirmed', 'reverted'].includes(refreshed.status)) return publicAnchor(refreshed);
      if (refreshed.serializedTransaction) return publicAnchor(await broadcastAndConfirm(refreshed, refreshed.serializedTransaction));
      return publicAnchor(refreshed);
    }
    const client = publicClient();
    const account = privateKeyToAccount(config.testnetPrivateKey as `0x${string}`);
    const chainId = await client.getChainId();
    if (chainId !== 84532) throw new Error('RPC chain ID is not Base Sepolia (84532). No transaction was sent.');
    const wallet = createWalletClient({ chain: baseSepolia, account, transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 0 }) });
    // A zero-value self transaction carrying a digest. Test ETH gas is still required.
    // Persist the prepared signed tx hash before broadcast so a lost RPC response cannot trigger a second anchor.
    const request = await wallet.prepareTransactionRequest({ to: account.address, value: 0n, data: anchorData(evidence.digest) });
    const balance = await client.getBalance({ address: account.address });
    const feePerGas = request.maxFeePerGas ?? request.gasPrice ?? 0n;
    const requiredWei = (request.gas ?? 21_000n) * feePerGas;
    if (balance < requiredWei) {
      throw new Error(`The dedicated Base Sepolia account needs test ETH for gas. Fund ${account.address}; no transaction was signed or sent.`);
    }
    const signedTransaction = await wallet.signTransaction(request);
    const transactionHash = keccak256(signedTransaction);
    const anchor: StoredEvidenceAnchor = {
      version: '1', kind: 'evidence_anchor', sessionId: evidence.session.id,
      chainId: 84532, network: 'Base Sepolia', account: account.address,
      digest: evidence.digest, exportedAt: evidence.exportedAt,
      transactionHash, explorerUrl: `https://sepolia.basescan.org/tx/${transactionHash}`,
      status: 'prepared',
      serializedTransaction: signedTransaction,
      note: 'Digest anchoring only. Zero-value self transaction, requiring test ETH gas. No USDC payment or merchant payout.',
    };
    await persistAnchor(evidence.session.id, anchor);
    return publicAnchor(await broadcastAndConfirm(anchor, signedTransaction));
  } finally { anchorBusy = false; }
}
