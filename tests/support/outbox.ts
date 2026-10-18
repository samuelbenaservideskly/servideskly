import { query } from '../../src/db/index.js';

export interface QueuedMail {
  id: string;
  ticket_id: string | null;
  to_address: string;
  subject: string;
  body_html: string;
  via_relay: boolean;
  relay_id: string | null;
  created_at: string;
}

/**
 * Queued mail, newest first, that passes `where`. The recipient, subject and
 * body are encrypted at rest (lib/field-crypto.ts), so they cannot be
 * matched in SQL: the rows are read - decrypted by the database layer - and
 * filtered here.
 */
export async function queuedMail(where: (m: QueuedMail) => boolean = () => true): Promise<QueuedMail[]> {
  return (await query<QueuedMail>('SELECT * FROM mail_outbox ORDER BY created_at DESC')).filter(where);
}
