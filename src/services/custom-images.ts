import fsp from 'node:fs/promises';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { execute, query, queryOne } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { brandingAssetPath, storeBrandingAsset, type BrandingAsset } from './branding.js';

const log = logger.child({ module: 'custom-images' });

/**
 * Settings - Customisation - Custom images.
 *
 * Images an administrator uploads to use in their own HTML: a requester
 * portal, the approval page, a notification. Same checks as the logo - type
 * from the bytes, SVG screened - and the same storage directory, because they
 * are the same kind of thing: the organisation's own artwork, public by
 * nature.
 *
 * Two ways to point at one, because a browser and a mail client differ:
 *
 * - **On a web page**: `/images/<id>`, served by this application.
 * - **In an email**: `cid:image-<id>`, which the outbox resolves at send
 *   time and attaches inline, exactly like `cid:logo`. A link to the web
 *   address would be blocked by Outlook and Gmail until the reader allows
 *   images, which in practice means a broken box.
 */

export interface CustomImageRow {
  id: string;
  name: string;
  file: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  original_name: string;
  /** Served only to a signed-in person; emails still carry it. */
  is_private: boolean;
  created_by: string | null;
  created_at: string;
}

/** The Content-ID an email uses for an image: `cid:image-<id>`. */
export function imageCid(id: string): string {
  return 'image-' + id;
}

/** Every `cid:image-<id>` a body refers to, once each. */
export function referencedImageIds(bodyHtml: string): string[] {
  const ids = new Set<string>();
  for (const match of bodyHtml.matchAll(/\bcid:image-([0-9a-f-]{36})\b/gi)) {
    ids.add(match[1]!.toLowerCase());
  }
  return Array.from(ids);
}

function asset(row: CustomImageRow): BrandingAsset {
  return {
    file: row.file,
    contentType: row.content_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    originalName: row.original_name,
    uploadedAt: row.created_at,
  };
}

export function customImagePath(row: CustomImageRow): string {
  return brandingAssetPath(asset(row));
}

export function listCustomImages(): Promise<CustomImageRow[]> {
  return query<CustomImageRow>('SELECT * FROM custom_images ORDER BY lower(name)');
}

export function findCustomImage(id: string): Promise<CustomImageRow | undefined> {
  return queryOne<CustomImageRow>('SELECT * FROM custom_images WHERE id = ?', [id]);
}

/** Verifies and stores an upload. Throws 400 on a bad file, 409 on a taken name. */
export async function addCustomImage(
  name: string,
  originalName: string,
  bytes: Buffer,
  actorId: string | null,
  isPrivate = false,
): Promise<CustomImageRow> {
  const clash = await queryOne<{ id: string }>(
    'SELECT id FROM custom_images WHERE lower(name) = lower(?)',
    [name],
  );
  if (clash) throw conflict('An image with that name already exists.', 'image_name_taken');

  // The logo's rules: PNG, JPEG, GIF, WebP and screened SVG, 1 MB.
  const stored = storeBrandingAsset('logo', originalName, bytes);
  const id = newId();
  await execute(
    `INSERT INTO custom_images
       (id, name, file, content_type, byte_size, sha256, original_name, is_private, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      stored.file,
      stored.contentType,
      stored.byteSize,
      stored.sha256,
      stored.originalName,
      isPrivate ? 1 : 0,
      actorId,
      nowIso(),
    ],
  );
  audit({
    action: 'custom_image.added',
    actorId,
    targetType: 'image',
    targetId: id,
    detail: { name, contentType: stored.contentType, bytes: stored.byteSize },
  });
  return (await findCustomImage(id))!;
}

/** Private: only signed-in people may load it from /images/<id>. */
export async function setCustomImagePrivate(id: string, isPrivate: boolean, actorId: string | null): Promise<void> {
  const row = await findCustomImage(id);
  if (!row) throw notFound('That image no longer exists.');
  await execute('UPDATE custom_images SET is_private = ? WHERE id = ?', [isPrivate ? 1 : 0, id]);
  audit({ action: 'custom_image.' + (isPrivate ? 'made_private' : 'made_public'), actorId, targetType: 'image', targetId: id, detail: { name: row.name } });
}

/** Removes the row, then the file - a failure leaves a stray file, never a dangling row. */
export async function deleteCustomImage(id: string, actorId: string | null): Promise<void> {
  const row = await findCustomImage(id);
  if (!row) throw notFound('That image no longer exists.');
  await execute('DELETE FROM custom_images WHERE id = ?', [id]);
  try {
    await fsp.unlink(customImagePath(row));
  } catch (err) {
    log.warn({ err, id }, 'custom image file could not be removed');
  }
  audit({
    action: 'custom_image.deleted',
    actorId,
    targetType: 'image',
    targetId: id,
    detail: { name: row.name },
  });
}
