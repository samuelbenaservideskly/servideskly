import fs from 'node:fs';
import { execute, query, queryOne } from '../db/index.js';
import { isSealedFile, sealFile, sealText, TEXT_PREFIX } from '../lib/field-crypto.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/util.js';
import { attachmentPath, type AttachmentRow } from './attachments.js';
import { SEALED_USER_COLUMNS } from './users.js';

const log = logger.child({ module: 'data-sealing' });

/**
 * Seals what is still in plain text (lib/field-crypto.ts): every row and
 * file from before encryption at rest, and whatever a write left unsealed.
 * Each write of these columns seals its own value; this is the net under
 * them, run at start-up and hourly (server.ts).
 *
 * Safe to run twice, and to stop part way: a value is sealed only if it is
 * still the plain text that was read (`AND column = ?`), so a write in
 * between wins, and a sealed value is never touched again.
 */

/** Table, its key, and the columns encrypted at rest. */
const TEXT_COLUMNS: { table: string; key: string; columns: readonly string[] }[] = [
  { table: 'users', key: 'id', columns: SEALED_USER_COLUMNS },
  { table: 'audit_log', key: 'id', columns: ['actor_email', 'ip', 'user_agent', 'detail'] },
  { table: 'mail_outbox', key: 'id', columns: ['to_address', 'subject', 'body_html'] },
];

const BATCH = 500;
/** The attachment files are sealed once, then every new one is written sealed. */
const FILES_MARKER = 'attachments_sealed_v1';

let running: Promise<{ values: number; files: number }> | null = null;

/** One pass. A pass already running is joined rather than doubled. */
export function sealPlaintext(): Promise<{ values: number; files: number }> {
  running ??= pass().finally(() => {
    running = null;
  });
  return running;
}

async function pass(): Promise<{ values: number; files: number }> {
  let values = 0;
  for (const { table, key, columns } of TEXT_COLUMNS) {
    for (const column of columns) values += await sealColumn(table, key, column);
  }
  const files = await sealFiles();
  if (values + files > 0) log.info({ values, files }, 'sealed data that was still in plain text');
  return { values, files };
}

async function sealColumn(table: string, key: string, column: string): Promise<number> {
  let sealed = 0;
  for (;;) {
    // Read under an alias, so the database layer hands back the stored text
    // as it is (a JSON column is not parsed). The names come from the list
    // above, never from a request.
    const rows = await query<{ k: string; raw: string }>(
      `SELECT ${key} AS k, ${column} AS raw FROM ${table}
        WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT LIKE ?
        LIMIT ${BATCH}`,
      [TEXT_PREFIX + '%'],
    );
    if (rows.length === 0) return sealed;
    for (const row of rows) {
      if (typeof row.raw !== 'string') continue;
      await execute(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ? AND ${column} = ?`, [sealText(row.raw), row.k, row.raw]);
      sealed += 1;
    }
    if (rows.length < BATCH) return sealed;
  }
}

/**
 * Every attachment file not yet sealed, rewritten sealed: written beside it
 * and renamed over it, so a crash leaves the old file or the new one, never
 * half of one. Once all are done, never again.
 */
async function sealFiles(): Promise<number> {
  if (await queryOne('SELECT key FROM seed_markers WHERE key = ?', [FILES_MARKER])) return 0;
  let sealed = 0;
  let after = '';
  for (;;) {
    const rows = await query<AttachmentRow>('SELECT * FROM ticket_attachments WHERE id > ? ORDER BY id LIMIT ?', [after, BATCH]);
    for (const row of rows) {
      const file = attachmentPath(row);
      try {
        const bytes = await fs.promises.readFile(file);
        if (isSealedFile(bytes)) continue;
        const temp = file + '.sealing';
        await fs.promises.writeFile(temp, sealFile(bytes), { mode: 0o600 });
        await fs.promises.rename(temp, file);
        sealed += 1;
      } catch (err) {
        // A file already gone is a row for the attachment store to tidy; any
        // other failure is retried on the next pass (the marker is not set).
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn({ err, attachmentId: row.id }, 'an attachment file could not be sealed');
          return sealed;
        }
      }
    }
    if (rows.length < BATCH) break;
    after = rows[rows.length - 1]!.id;
  }
  await execute('INSERT INTO seed_markers (key, done_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [FILES_MARKER, nowIso()]);
  return sealed;
}
