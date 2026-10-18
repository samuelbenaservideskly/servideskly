import crypto from 'node:crypto';
import { query } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import {
  attachmentLimits,
  countAttachments,
  formatBytes,
  sanitiseFilename,
  storeAttachment,
  verifyType,
} from '../attachments.js';
import type { IncomingAttachment } from './transport.js';

const log = logger.child({ module: 'mail' });

/**
 * Files that arrive on an email.
 *
 * Mail is how most people send a screenshot of the thing that is broken, so
 * dropping what a message carried loses the evidence the ticket exists for.
 *
 * Every file goes through the **same** store as one picked in the browser -
 * `verifyType()` on the bytes, the configured size limit, the per-ticket cap.
 * Nothing is trusted because it arrived by mail; if anything, less is, since
 * the sender may be a stranger with no account.
 */

/**
 * Below this, an image the body displays is taken for a signature logo.
 *
 * Outlook sends a corporate signature's logo as an inline image on every
 * message, and a ticket that collects one per reply is a ticket nobody can
 * find the real screenshot in. A pasted screenshot is far larger: a 200x60
 * logo is a few KB, a screen capture is hundreds.
 *
 * It is a heuristic, and it is the only one in here. A file the sender
 * actually attached is never measured against it, however small.
 */
const SIGNATURE_IMAGE_BYTES = 25 * 1024;

export interface StoredAttachments {
  stored: number;
  /** One line per file that was not kept, ready to show a technician. */
  skipped: string[];
}

export async function storeIncomingAttachments(
  ticketId: string,
  uploadedBy: string,
  attachments: IncomingAttachment[],
  options: { isInternal?: boolean } = {},
): Promise<StoredAttachments> {
  const result: StoredAttachments = { stored: 0, skipped: [] };
  if (attachments.length === 0) return result;

  const limits = attachmentLimits();
  if (!limits.enabled) {
    result.skipped.push(
      attachments.length + ' file(s) were not kept because attachments are turned off.',
    );
    return result;
  }

  let count = await countAttachments(ticketId);
  const seen = await hashesOn(ticketId);

  for (const attachment of attachments) {
    const name = sanitiseFilename(attachment.filename);

    if (attachment.inline && attachment.content.byteLength < SIGNATURE_IMAGE_BYTES) {
      continue; // A signature logo. Silently, because saying so every time is noise.
    }

    if (count >= limits.maxPerTicket) {
      result.skipped.push(name + ' - this ticket already has ' + limits.maxPerTicket + ' files.');
      continue;
    }

    if (attachment.content.byteLength > limits.maxBytes) {
      result.skipped.push(
        name + ' - ' + formatBytes(attachment.content.byteLength) + ', over the limit of ' +
          formatBytes(limits.maxBytes) + '.',
      );
      continue;
    }

    if (attachment.content.byteLength === 0) {
      result.skipped.push(name + ' - the file was empty.');
      continue;
    }

    // The same thing twice: the signature logo that did clear the size floor,
    // or a quoted attachment coming back on a reply. Stored once per ticket.
    const sha256 = crypto.createHash('sha256').update(attachment.content).digest('hex');
    if (seen.has(sha256)) continue;

    let verified;
    try {
      verified = verifyType(name, attachment.content.subarray(0, 64));
    } catch (err) {
      result.skipped.push(name + ' - ' + reasonFrom(err));
      continue;
    }

    try {
      await storeAttachment({
        ticketId,
        uploadedBy,
        filename: name,
        contentType: verified.contentType,
        bytes: attachment.content,
        // Mail comes from outside, so hiding it from the requester would hide
        // their own file from them. An automation may choose (its step says).
        isInternal: options.isInternal === true,
      });
      seen.add(sha256);
      count++;
      result.stored++;
    } catch (err) {
      // One file failing must not cost the ticket or the rest of the files.
      log.warn({ err, ticketId, name }, 'could not store an emailed attachment');
      result.skipped.push(name + ' - it could not be saved.');
    }
  }

  return result;
}

/** What a technician should be told about the files that did not make it. */
export function skippedNote(skipped: string[]): string {
  if (skipped.length === 0) return '';
  return (
    'Some files on this email were not kept:\n' + skipped.map((line) => '- ' + line).join('\n')
  );
}

async function hashesOn(ticketId: string): Promise<Set<string>> {
  const rows = await query<{ sha256: string }>(
    'SELECT sha256 FROM ticket_attachments WHERE ticket_id = ? AND deleted_at IS NULL',
    [ticketId],
  );
  return new Set(rows.map((row) => row.sha256));
}

function reasonFrom(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'its type could not be confirmed.';
}
