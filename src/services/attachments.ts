import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { count, execute, query, queryOne } from '../db/index.js';
import { config } from '../config.js';
import { settings } from '../settings/index.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { newId, nowIso } from '../lib/util.js';
import { isStaff, type UserRow } from './users.js';
import { downscaleImage } from './image-downscale.js';
import { openFile, sealFile } from '../lib/field-crypto.js';
import { canRead } from '../auth/permissions.js';

const log = logger.child({ module: 'attachments' });

/**
 * Attachment storage.
 *
 * Files live outside the document root, under UPLOAD_DIR, are
 * named with random ids that are never derived from the uploaded filename, and
 * are always served with Content-Disposition: attachment. The stored type is
 * the one verified from the file's own leading bytes, never the client's
 * Content-Type claim.
 */

// A directory rather than the database, so a 10 MB upload never travels
// through a query. In a container this is a mounted volume.
export const ATTACHMENT_DIR = path.join(config.uploadDir, 'attachments');

export interface AttachmentRow {
  id: string;
  ticket_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  byte_size: string | number;
  sha256: string;
  storage_key: string;
  is_internal: boolean;
  created_at: string;
  deleted_at: string | null;
  /** When the requester was emailed this file, or null if they never were. */
  emailed_at: string | null;
}

export interface AttachmentListItem extends AttachmentRow {
  uploader_name: string;
}

/** What a browser may upload, and what we can prove from the bytes. */
interface TypeRule {
  contentType: string;
  extensions: string[];
  /** Leading-byte signatures; an empty list means the type has none. */
  magic: readonly (readonly number[])[];
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const TYPE_RULES: readonly TypeRule[] = [
  { contentType: 'image/png', extensions: ['.png'], magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { contentType: 'image/jpeg', extensions: ['.jpg', '.jpeg'], magic: [[0xff, 0xd8, 0xff]] },
  { contentType: 'image/gif', extensions: ['.gif'], magic: [[0x47, 0x49, 0x46, 0x38]] },
  { contentType: 'image/webp', extensions: ['.webp'], magic: [[0x52, 0x49, 0x46, 0x46]] },
  { contentType: 'application/pdf', extensions: ['.pdf'], magic: [[0x25, 0x50, 0x44, 0x46]] },
  {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    magic: [ZIP_MAGIC],
  },
  {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    magic: [ZIP_MAGIC],
  },
  {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['.pptx'],
    magic: [ZIP_MAGIC],
  },
  { contentType: 'application/zip', extensions: ['.zip'], magic: [ZIP_MAGIC] },
  {
    contentType: 'application/x-7z-compressed',
    extensions: ['.7z'],
    magic: [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  },
  {
    // An Outlook message is an OLE compound file, the same container as the
    // pre-2007 Office formats - which is why the signature is theirs.
    contentType: 'application/vnd.ms-outlook',
    extensions: ['.msg'],
    magic: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  },
  // A forwarded message. RFC 5322 is text with no signature, so it is checked
  // by decoding like the other text formats.
  { contentType: 'message/rfc822', extensions: ['.eml'], magic: [] },
  // Text has no signature, so it is validated by decoding instead.
  { contentType: 'text/plain', extensions: ['.txt', '.log'], magic: [] },
  { contentType: 'text/csv', extensions: ['.csv'], magic: [] },
];

export const ALLOWED_EXTENSIONS = TYPE_RULES.flatMap((r) => r.extensions).sort();

/**
 * Reduces an uploaded name to something safe to store and to echo back.
 *
 * Any directory component is discarded, so a name like `../../etc/passwd` or
 * `C:\Windows\x` cannot influence where anything is written or what the
 * download header says.
 */
export function sanitiseFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let cleaned = '';
  for (const char of base) {
    const code = char.charCodeAt(0);
    // Drop control characters and the characters that carry meaning in a
    // Content-Disposition header or on a filesystem.
    if (code < 0x20 || code === 0x7f) continue;
    if ('"\\/:*?<>|'.includes(char)) continue;
    cleaned += char;
  }
  cleaned = cleaned.replace(/\s+/g, ' ').replace(/^[. ]+/, '').trim();
  if (cleaned.length > 180) {
    const ext = path.extname(cleaned).slice(0, 12);
    cleaned = cleaned.slice(0, 180 - ext.length) + ext;
  }
  return cleaned.length > 0 ? cleaned : 'attachment';
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) return false;
  return signature.every((byte, index) => buffer[index] === byte);
}

/** True when the buffer decodes as UTF-8 and holds no control characters. */
function looksLikeText(buffer: Buffer): boolean {
  const text = buffer.toString('utf8');
  if (text.includes('\uFFFD')) return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

export interface VerifiedType {
  contentType: string;
  extension: string;
}

/**
 * Decides the type from the extension and then proves it from the bytes.
 *
 * Both must agree. That blocks the classic trick of uploading an HTML or SVG
 * payload under an image extension, and equally blocks a real image renamed to
 * something the browser would treat as active content.
 */
export function verifyType(filename: string, head: Buffer): VerifiedType {
  const extension = path.extname(filename).toLowerCase();
  if (!extension) {
    throw badRequest('That file has no extension, so its type cannot be confirmed.', 'no_extension');
  }

  const rule = TYPE_RULES.find((r) => r.extensions.includes(extension));
  if (!rule) {
    throw badRequest(
      'Files of type ' + extension + ' are not accepted. Allowed: ' + ALLOWED_EXTENSIONS.join(', '),
      'type_not_allowed',
    );
  }

  if (rule.magic.length === 0) {
    if (!looksLikeText(head)) {
      throw badRequest('That file does not look like the text file its name claims.', 'type_mismatch');
    }
  } else if (!rule.magic.some((signature) => startsWith(head, signature))) {
    throw badRequest(
      'The contents of that file do not match its ' + extension + ' extension.',
      'type_mismatch',
    );
  }

  return { contentType: rule.contentType, extension };
}

function storagePathFor(storageKey: string): string {
  // Two-character shard, so a large store does not end up as one huge directory.
  return path.join(ATTACHMENT_DIR, storageKey.slice(0, 2), storageKey);
}

export function attachmentPath(row: AttachmentRow): string {
  return storagePathFor(row.storage_key);
}

/**
 * An attachment's bytes, decrypted. Files are encrypted at rest
 * (lib/field-crypto.ts); one stored before that is read as it is. Every
 * reader goes through here - the download, mail, the export.
 */
export async function readAttachment(row: AttachmentRow): Promise<Buffer> {
  return openFile(await fsp.readFile(attachmentPath(row)));
}

/** Writes the bytes to disk and records the metadata in one step. */
/**
 * Writes the bytes to disk and records the metadata.
 *
 * The file is written first with the exclusive 'wx' flag, so a storage key
 * collision fails rather than overwriting, and only then is the row inserted.
 * A crash between the two leaves an orphaned file, which is harmless; the
 * reverse order would leave a row pointing at nothing.
 */
export async function storeAttachment(input: {
  ticketId: string;
  uploadedBy: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  isInternal: boolean;
}): Promise<AttachmentRow> {
  const id = newId();
  const storageKey = crypto.randomBytes(16).toString('hex');
  const target = storagePathFor(storageKey);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // A large picture is stored smaller (image-downscale.ts); anything else as it came.
  const stored = await downscaleImage(input.bytes, input.contentType);
  // 0o600: readable only by the service account. Encrypted: a copied
  // uploads folder is everything anybody ever sent the service desk.
  fs.writeFileSync(target, sealFile(stored), { mode: 0o600, flag: 'wx' });

  // The hash is of the file as it arrived, not as stored: a screenshot quoted
  // back on every reply is recognised and stored once (inbound-attachments.ts).
  const sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');

  try {
    const row = await queryOne<AttachmentRow>(
      `INSERT INTO ticket_attachments
         (id, ticket_id, uploaded_by, filename, content_type, byte_size, sha256,
          storage_key, is_internal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
      [
        id,
        input.ticketId,
        input.uploadedBy,
        input.filename,
        input.contentType,
        stored.length,
        sha256,
        storageKey,
        input.isInternal,
        nowIso(),
      ],
    );
    if (!row) throw new Error('attachment insert returned no row');
    return row;
  } catch (err) {
    // The row failed, so the file has no owner: remove it rather than leave
    // an orphan behind.
    try {
      fs.unlinkSync(target);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

/**
 * Records that these files have gone to the requester.
 *
 * So the ticket can say so. A file the requester has been sent and a file
 * only the service desk holds look identical otherwise, and the difference
 * decides whether somebody has already seen the thing being discussed.
 */
export async function markEmailed(ids: readonly string[]): Promise<void> {
  const at = nowIso();
  for (const id of ids) {
    await execute('UPDATE ticket_attachments SET emailed_at = ? WHERE id = ?', [at, id]);
  }
}

/** Attachments visible to this viewer; internal ones are filtered in SQL. */
export function listAttachments(
  ticketId: string,
  viewer: UserRow,
): Promise<AttachmentListItem[]> {
  // Internal files are for those who read internal notes (custom roles, part 2).
  const internalClause = isStaff(viewer.role) && canRead(viewer, 'tickets.internal') ? '' : ' AND a.is_internal = 0';
  return query<AttachmentListItem>(
    `SELECT a.*, u.display_name AS uploader_name
       FROM ticket_attachments a
       JOIN users u ON u.id = a.uploaded_by
      WHERE a.ticket_id = ? AND a.deleted_at IS NULL` +
      internalClause +
      ' ORDER BY a.created_at ASC, a.id ASC',
    [ticketId],
  );
}

export function countAttachments(ticketId: string): Promise<number> {
  return count(
    'SELECT count(*) AS c FROM ticket_attachments WHERE ticket_id = ? AND deleted_at IS NULL',
    [ticketId],
  );
}

export function findAttachment(id: string): Promise<AttachmentRow | undefined> {
  return queryOne<AttachmentRow>(
    'SELECT * FROM ticket_attachments WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
}

/** Soft-deletes the row, then removes the file. */
export async function deleteAttachment(row: AttachmentRow): Promise<void> {
  await execute('UPDATE ticket_attachments SET deleted_at = ? WHERE id = ?', [
    nowIso(),
    row.id,
  ]);
  try {
    await fsp.unlink(attachmentPath(row));
  } catch (err) {
    // The row is already marked deleted; a missing file is not worth failing on.
    log.warn({ err, attachmentId: row.id }, 'could not remove attachment file from disk');
  }
}

/**
 * Removes a stored file by its key, with no row to go with it.
 *
 * For deleting a whole ticket: the rows go with it through ON DELETE CASCADE,
 * and the filesystem has no foreign keys, so the files are removed by hand.
 */
export async function removeStoredFile(storageKey: string): Promise<void> {
  try {
    await fsp.unlink(storagePathFor(storageKey));
  } catch (err) {
    // Already gone, or never written. Not worth failing a delete over.
    log.warn({ err, storageKey }, 'could not remove a stored file from disk');
  }
}

/** Human-readable size, for the ticket page. */
export function formatBytes(bytes: number | string): string {
  const size = Number(bytes);
  return formatSize(size);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Current limits, for the upload form and its validation. */
export function attachmentLimits(): { enabled: boolean; maxBytes: number; maxPerTicket: number } {
  return settings().attachments;
}
