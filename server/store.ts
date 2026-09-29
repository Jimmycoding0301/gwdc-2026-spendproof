import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Evidence, EvidenceAnchor, Session } from '../shared/types.js';
import type { TransactionSerialized } from 'viem';
import type { ReceiptViewModel } from '../shared/receipt.js';

export type StoredEvidenceAnchor = EvidenceAnchor & { serializedTransaction?: TransactionSerialized };

const dataDir = resolve('.data');
const sessionFile = join(dataDir, 'sessions.json');
const sessions = new Map<string, Session>();
let writes: Promise<void> = Promise.resolve();
const anchorWrites = new Map<string, Promise<void>>();

export async function initializeStore() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    const data: unknown = JSON.parse(await readFile(sessionFile, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Stored sessions must be an array.');
    for (const session of data as Session[]) {
      if (!session || typeof session.id !== 'string' || !Array.isArray(session.records) || !Array.isArray(session.events)) throw new Error('Stored session is invalid.');
      if (session.status === 'running') {
        session.status = 'error';
        session.error = 'Server restarted during this run. Existing records are preserved; create a new session to continue.';
      }
      sessions.set(session.id, session);
    }
    await persistSessions();
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export function getSession(id: string) { return sessions.get(id); }
export function listSessions() { return [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function putSession(session: Session) { sessions.set(session.id, session); }

export function persistSessions(): Promise<void> {
  // Snapshot at enqueue time: concurrent stop/run updates cannot reorder disk writes.
  const body = JSON.stringify([...sessions.values()], null, 2);
  const write = writes.then(async () => {
    const temporary = `${sessionFile}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, sessionFile);
  });
  writes = write.catch(() => undefined);
  return write;
}

export async function persistAnchor(sessionId: string, anchor: unknown) {
  const destination = join(dataDir, `anchor-${sessionId}.json`);
  const body = JSON.stringify(anchor, null, 2);
  const previous = anchorWrites.get(sessionId) ?? Promise.resolve();
  const write = previous.then(async () => {
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, destination);
  });
  anchorWrites.set(sessionId, write.catch(() => undefined));
  await write;
}

export async function persistEvidence(evidence: Evidence) {
  await writeFile(join(dataDir, `evidence-${evidence.session.id}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}

export async function persistReceipt(sessionId: string, receipt: ReceiptViewModel) {
  const destination = join(dataDir, `receipt-${sessionId}-${receipt.digest}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await rename(temporary, destination);
}

export async function readReceipt(sessionId: string, digest: string): Promise<ReceiptViewModel | undefined> {
  try { return JSON.parse(await readFile(join(dataDir, `receipt-${sessionId}-${digest}.json`), 'utf8')) as ReceiptViewModel; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readAnchor(sessionId: string): Promise<StoredEvidenceAnchor | undefined> {
  try { return JSON.parse(await readFile(join(dataDir, `anchor-${sessionId}.json`), 'utf8')); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
