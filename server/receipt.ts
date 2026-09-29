import { z } from 'zod';
import { createEvidence } from '../shared/evidence.js';
import { createReceiptView } from '../shared/receipt.js';
import type { Session } from '../shared/types.js';
import { config } from './config.js';
import { getStoredAnchor } from './anchor.js';

/** No model requests, payment or broadcast. A read-only RPC lookup may refresh cached anchor status. */
export async function createSessionReceipt(session: Session) {
  if (!z.uuid().safeParse(session.id).success) throw new Error('Invalid session ID.');
  if (!['completed', 'stopped', 'error'].includes(session.status)) throw new Error('Finish or stop the session before sharing its receipt.');
  const snapshot = structuredClone(session);
  const exportedAt = snapshot.events.at(-1)?.at || snapshot.createdAt;
  return createReceiptView(createEvidence(snapshot, exportedAt), {
    anchor: await getStoredAnchor(session.id),
    sensitiveValues: [config.kilnApiKey, config.testnetPrivateKey],
  });
}
