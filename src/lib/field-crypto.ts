import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'field-crypto' });

/**
 * Encryption at rest for personal data and attachments (docs/encryption-at-
 * rest-brief.md, stages 1 and 2; asked for 18 Oct 2026).
 *
 * Encrypted by the application, read back by the application: the database
 * and the uploads folder hold ciphertext, so a copied database, a stolen
 * backup or somebody holding the connection string reads nothing. It does
 * not protect against somebody who has the application server too - the key
 * is there.
 *
 * - **The key** is derived with HKDF from this installation's oldest session
 *   key, under its own label - the same root as secret-box.ts, a different
 *   key. Each helpdesk has its own SESSION_SECRET (a Key Vault secret on
 *   Azure), so one helpdesk cannot read another's rows on a shared server.
 *   **Losing or changing SESSION_SECRET loses the data**: DEPLOYMENT.md says
 *   so.
 * - **A text value** becomes `enc:v1:` + base64(iv | tag | ciphertext),
 *   AES-256-GCM, so a tampered value fails rather than decrypting to
 *   something else. The empty string stays empty: "nothing here" is not
 *   worth hiding, and `<> ''` checks keep working.
 * - **Reading is transparent**: the database layer (db/index.ts) decrypts any
 *   value with the prefix, whatever column or alias it arrives under.
 *   Writing is not: each write of an encrypted column calls sealText(), and
 *   data-sealing.ts seals whatever a write left in plain text.
 * - **A file** starts with the 8-byte header `HDENC1\0\0`, then iv, tag and
 *   ciphertext. A file without it is read as it is, which is how files from
 *   before this are still served until the sealing pass reaches them.
 */

export const TEXT_PREFIX = 'enc:v1:';
const FILE_HEADER = Buffer.from('HDENC1\0\0', 'latin1');
const KEY_INFO = 'helpdesk-data-encryption-v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  // The oldest session key, as secret-box.ts: adding a newer key to rotate
  // cookies must not orphan everything already stored.
  const material = config.session.keys[config.session.keys.length - 1] ?? '';
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0), KEY_INFO, 32));
  return cachedKey;
}

function encrypt(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(sealed: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('too short');
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), sealed.subarray(0, IV_BYTES));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export const isSealedText = (value: unknown): value is string => typeof value === 'string' && value.startsWith(TEXT_PREFIX);

/** A value as it is stored: sealed, unless empty or already sealed. null and undefined pass through. */
export function sealText<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string' || value === '' || isSealedText(value)) return value;
  return (TEXT_PREFIX + encrypt(Buffer.from(value, 'utf8')).toString('base64')) as T;
}

let warned = false;

/**
 * A stored value as the application reads it. A value that cannot be opened
 * - the key changed - reads as empty, and the log says why once: one
 * unreadable field must not take a page down.
 */
export function openText(value: string): string {
  if (!isSealedText(value)) return value;
  try {
    return decrypt(Buffer.from(value.slice(TEXT_PREFIX.length), 'base64')).toString('utf8');
  } catch {
    if (!warned) {
      warned = true;
      log.error('an encrypted value could not be decrypted: SESSION_SECRET has probably changed since it was written');
    }
    return '';
  }
}

export const isSealedFile = (bytes: Buffer): boolean => bytes.length >= FILE_HEADER.length && bytes.subarray(0, FILE_HEADER.length).equals(FILE_HEADER);

/** A file's bytes as they are written to disk. */
export function sealFile(bytes: Buffer): Buffer {
  return isSealedFile(bytes) ? bytes : Buffer.concat([FILE_HEADER, encrypt(bytes)]);
}

/** A file's bytes as read from disk, decrypted; one from before encryption as it is. Throws if it cannot be opened. */
export function openFile(bytes: Buffer): Buffer {
  return isSealedFile(bytes) ? decrypt(bytes.subarray(FILE_HEADER.length)) : bytes;
}

/** For tests: forget the derived key, after the session key changed. */
export function resetFieldKeyForTests(): void {
  cachedKey = null;
  warned = false;
}
