import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Authenticated encryption for the few secrets that can be stored in the
 * database (the Entra client secret, the SAML signing key).
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than silently
 * yielding altered plaintext. The key is derived with HKDF from the session
 * signing key, which means:
 *
 *  - the secret is not readable from a stolen database file alone;
 *  - rotating SESSION_SECRET makes stored secrets undecryptable, which is
 *    reported clearly so an administrator can re-enter them.
 *
 * This protects against database exfiltration, not against an attacker who
 * already has the application's environment. Keep the database file readable
 * only by the service account either way.
 */

const KEY_INFO = 'helpdesk-settings-encryption-v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  // The oldest key is used, not the newest, so that adding a new session key
  // for cookie rotation does not orphan previously stored secrets.
  const material = config.session.keys[config.session.keys.length - 1] ?? '';
  cachedKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.alloc(0), KEY_INFO, 32),
  );
  return cachedKey;
}

/** Marker shape for an encrypted value inside the settings document. */
export interface SealedValue {
  enc: string;
}

export function isSealed(value: unknown): value is SealedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SealedValue).enc === 'string'
  );
}

export function seal(plaintext: string): SealedValue {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([iv, tag, ciphertext]).toString('base64') };
}

export class SealedValueUnreadable extends Error {
  constructor() {
    super(
      'A stored secret could not be decrypted. This normally means SESSION_SECRET ' +
        'changed since it was saved. Re-enter the secret under Admin -> Settings.',
    );
    this.name = 'SealedValueUnreadable';
  }
}

export function open(value: SealedValue): string {
  const raw = Buffer.from(value.enc, 'base64');
  if (raw.length < IV_BYTES + 16 + 1) throw new SealedValueUnreadable();
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = raw.subarray(IV_BYTES + 16);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SealedValueUnreadable();
  }
}

/** Decrypts if sealed, passes a plain string through, else returns ''. */
export function openMaybe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isSealed(value)) {
    try {
      return open(value);
    } catch {
      return '';
    }
  }
  return '';
}
