import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { execute, query } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { ANONYMOUS_ISSUER_URN, MAIL_ISSUER_URN } from './users.js';
import { LOCAL_EXTERNAL_ID, LOCAL_ISSUER } from '../auth/local-accounts.js';
import { zipFiles } from '../lib/xlsx.js';
import { loadSettings, settings } from '../settings/index.js';
import { openFile } from '../lib/field-crypto.js';


const log = logger.child({ module: 'data-export' });

/**
 * Everything out, and everything gone.
 *
 * Settings - Advanced settings - Data (asked for 16 Oct 2026). Two actions
 * that are opposites and belong on one page, because the honest order is
 * **export, then delete**: the page says so, and the delete asks whether
 * one has been taken.
 *
 * What makes these different from every other action here:
 *
 * - The export is **everything**, not a report. A report answers a
 *   question; this answers "give me my data" - the GDPR one, and the one
 *   somebody asks when they are leaving. So it is every table, as it is,
 *   plus the attachment files.
 * - The delete is the only irreversible thing in the application. It is
 *   behind a typed confirmation, it is audited **before** the rows go, and
 *   it leaves a service desk that still starts: the schema, the
 *   migrations, the settings document and the break-glass account.
 */

/** Tables the export never carries, and why. */
const SKIPPED = new Set([
  // Housekeeping, not data: who is signed in, and what has already been
  // migrated. Neither means anything outside this installation.
  'sessions',
  'schema_migrations',
]);

/**
 * Tables emptied by "delete all data", in an order foreign keys allow.
 *
 * Written out rather than discovered, because the order matters and
 * because **what is kept has to be a decision somebody made**: the settings
 * document, the migration history and the accounts that let an
 * administrator back in are not "data" in the sense this page means.
 */
const WIPE_ORDER = [
  'sla_notifications', 'sla_breaches', 'automation_runs', 'ticket_events',
  'mail_threads', 'mail_outbox', 'mail_seen', 'attachments', 'ticket_comments',
  'tickets', 'ticket_categories',
  'board_shares', 'user_pins', 'user_boards',
  'announcements', 'availability_entries', 'availability_week',
  'technician_group_managers', 'technician_group_members', 'technician_group_rules',
  'user_group_members', 'user_group_rules', 'user_groups', 'technician_groups',
  'ticket_templates', 'custom_fields', 'service_catalogue_tiles',
  'mail_rules', 'mail_notifications', 'mailboxes', 'smtp_relay_groups', 'smtp_relays',
  'automations', 'automation_connections', 'api_keys',
  'portal_group_assignments', 'portal_themes', 'custom_images',
  'language_groups', 'languages',
  'password_resets', 'registrations', 'local_signin_codes',
  'audit_log',
];

/** Every table this database holds, whatever dialect it is. */
async function tableNames(): Promise<string[]> {
  if (config.database.url) {
    const rows = await query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    return rows.map((r) => r.name);
  }
  const rows = await query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => r.name);
}

export interface ExportSummary {
  tables: number;
  rows: number;
  files: number;
  bytes: number;
}

/**
 * The whole service desk as a zip: one JSON document, and the files.
 *
 * Held in memory, which is the honest limit of this: a service desk with
 * a gigabyte of attachments needs a streaming export, and that is a
 * different piece of work. The page says what was included.
 */
export async function exportEverything(
  actorId: string | null,
): Promise<{ zip: Buffer; summary: ExportSummary }> {
  const names = (await tableNames()).filter((name) => !SKIPPED.has(name));
  const data: Record<string, unknown[]> = {};
  let rows = 0;
  for (const name of names) {
    // The table names come from the database itself, never from a request.
    const all = await query<Record<string, unknown>>('SELECT * FROM "' + name + '"');
    data[name] = all;
    rows += all.length;
  }

  const files: [string, Buffer][] = [];
  const dir = config.uploadDir;
  let bytes = 0;
  const addFiles = (from: string, prefix: string): void => {
    if (!fs.existsSync(from)) return;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const full = path.join(from, entry.name);
      if (entry.isDirectory()) {
        addFiles(full, prefix + entry.name + '/');
        continue;
      }
      try {
        // Decrypted, like the rows (the database layer opens those): an
        // export is for reading, by whoever asked for their data.
        const buf = openFile(fs.readFileSync(full));
        bytes += buf.length;
        files.push([prefix + entry.name, buf]);
      } catch (err) {
        // One unreadable file must not cost the whole export.
        log.warn({ err, file: full }, 'a file could not be read for the export');
      }
    }
  };
  addFiles(dir, 'uploads/');

  const document = {
    exported_at: nowIso(),
    application: 'helpdesk',
    note: 'Every table of this service desk, as it was. Files are under uploads/.',
    tables: data,
  };

  const zip = zipFiles([
    ['data.json', Buffer.from(JSON.stringify(document, null, 2), 'utf8')],
    ...files,
  ]);

  const summary: ExportSummary = { tables: names.length, rows, files: files.length, bytes };
  audit({
    action: 'data.exported',
    actorId,
    targetType: 'settings',
    detail: { ...summary },
  });
  return { zip, summary };
}

/** What a reader is told the export would hold, before they ask for it. */
export async function exportSize(): Promise<ExportSummary> {
  const names = (await tableNames()).filter((name) => !SKIPPED.has(name));
  let rows = 0;
  for (const name of names) {
    const [count] = await query<{ n: number }>('SELECT count(*) AS n FROM "' + name + '"');
    rows += Number(count?.n ?? 0);
  }
  let files = 0;
  let bytes = 0;
  const walk = (from: string): void => {
    if (!fs.existsSync(from)) return;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const full = path.join(from, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // A file that cannot be measured is still a file.
        }
      }
    }
  };
  walk(config.uploadDir);
  return { tables: names.length, rows, files, bytes };
}

/** The words somebody has to type. Deliberately not "yes". */
export const DELETE_PHRASE = 'DELETE EVERYTHING';

export interface WipeSummary {
  tables: number;
  rows: number;
  files: number;
}

/**
 * Empty the service desk.
 *
 * Everything in WIPE_ORDER, the attachment files, and every account except
 * the one that can let somebody back in. **The audit entry is written
 * first**, for the same reason deleting one ticket writes it first: after
 * this there is nothing left to describe - and then the audit table itself
 * is emptied, so what survives is the line the log kept.
 */
export async function deleteEverything(phrase: string, actorId: string | null): Promise<WipeSummary> {
  if (phrase.trim() !== DELETE_PHRASE) {
    throw badRequest('Type ' + DELETE_PHRASE + ' exactly, in capitals, to confirm.');
  }

  const before = await exportSize();
  audit({
    action: 'data.deleted_all',
    actorId,
    targetType: 'settings',
    detail: { rows: before.rows, files: before.files },
  });
  log.warn({ actorId, rows: before.rows, files: before.files }, 'deleting every ticket and account');

  let emptied = 0;
  const present = new Set(await tableNames());
  for (const table of WIPE_ORDER) {
    if (!present.has(table)) continue;
    await execute('DELETE FROM "' + table + '"');
    emptied += 1;
  }

  /*
   * The accounts. Everything but the ways back in - whoever pressed it, the
   * administrators the customer portal lists, and in development the
   * break-glass account - and the two reserved placeholders: with no account
   * at all nobody could sign in to the service desk they have just emptied,
   * and the placeholders are referenced by rows that may come back in a
   * later import.
   */
  const listed = settings().provisioning.portalAdmins;
  await execute(
    `DELETE FROM users
      WHERE NOT (issuer = ? AND external_id = ?)
        AND issuer NOT IN (?, ?)
        AND id <> ?` +
      (listed.length ? ' AND email NOT IN (' + listed.map(() => '?').join(', ') + ')' : ''),
    [LOCAL_ISSUER, LOCAL_EXTERNAL_ID, MAIL_ISSUER_URN, ANONYMOUS_ISSUER_URN, actorId ?? '', ...listed],
  );
  await execute(
    `DELETE FROM local_credentials
      WHERE user_id NOT IN (SELECT id FROM users)`,
  );
  await execute('DELETE FROM sessions');

  // The files, after the rows, because the filesystem has no foreign keys:
  // a failure here leaves an unreferenced file rather than a row pointing
  // at a file that is gone.
  let removed = 0;
  const wipe = (from: string): void => {
    if (!fs.existsSync(from)) return;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const full = path.join(from, entry.name);
      if (entry.isDirectory()) {
        wipe(full);
        continue;
      }
      try {
        fs.unlinkSync(full);
        removed += 1;
      } catch (err) {
        log.warn({ err, file: full }, 'a file could not be removed');
      }
    }
  };
  wipe(config.uploadDir);

  // The settings document is kept - a service desk with no settings cannot
  // draw a page - but anything cached from the rows just deleted is not.
  await loadSettings();

  return { tables: emptied, rows: before.rows, files: removed };
}
