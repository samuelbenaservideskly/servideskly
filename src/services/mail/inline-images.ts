import fsp from 'node:fs/promises';
import { brandingAssetPath } from '../branding.js';
import {
  customImagePath,
  findCustomImage,
  imageCid,
  referencedImageIds,
  type CustomImageRow,
} from '../custom-images.js';
import { settings } from '../../settings/index.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ module: 'mail' });

/**
 * Images carried inside a notification.
 *
 * A logo in an email can be done three ways and only one of them works. A
 * remote `<img src="https://...">` is blocked by Outlook and Gmail until the
 * reader asks for images, and needs the server to be reachable from wherever
 * they read their mail. A `data:` URI is stripped outright by both. What is
 * left is **CID**: the image travels with the message and the body points at
 * it by Content-ID, which is what every organisation's mail actually does.
 *
 * So a notification body writes
 *
 *     <img src="cid:logo" alt="">
 *
 * and the logo already uploaded under Settings - Customisation is attached
 * when the message is sent. There is deliberately no second uploader on the
 * notification page: one logo for the whole system means changing it in one
 * place changes every email, and no new storage or validation.
 *
 * Resolved at **send** time rather than when the mail is queued, so a logo
 * changed while something sits in the outbox goes out as the new one, and the
 * queue never holds a copy of an image.
 */

export interface InlineImage {
  /** The bit after `cid:` in the body, and the Content-ID without brackets. */
  cid: string;
  contentType: string;
  fileName: string;
  content: Buffer;
}

/** The one reference understood today. */
export const LOGO_CID = 'logo';

/**
 * Smaller than the 1 MB a logo may be in the browser, because this one is
 * paid for on **every** notification and base64 adds a third on top. 100 KB
 * is a generous PNG at the size an email shows one.
 */
export const MAX_INLINE_BYTES = 100 * 1024;

/**
 * What a mail client will actually draw.
 *
 * The branding uploader accepts more than this, because a browser draws more
 * than this. SVG is rendered by no mail client at all, and WebP is not
 * rendered by Outlook on Windows - which in a service desk is most of the
 * readers. Either would arrive as a broken image in every message, so they
 * are refused with a reason rather than sent and silently wrong.
 */
const SENDABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);

/** True when a body asks for the branding logo. */
export function usesLogo(bodyHtml: string): boolean {
  return new RegExp('\\bsrc\\s*=\\s*["\']?cid:' + LOGO_CID + '\\b', 'i').test(bodyHtml);
}

/**
 * Why `cid:logo` would not arrive, in words, or '' when it would.
 *
 * Used by the notification page: a reader who has just typed the tag needs to
 * be told now, not to discover it in somebody's inbox.
 */
export function logoProblem(): string {
  const logo = settings().branding.logo;
  if (!logo) {
    return 'No logo has been uploaded yet, so cid:logo will arrive as a broken image. Upload one under Settings - Customisation.';
  }
  if (!SENDABLE_TYPES.has(logo.contentType)) {
    return (
      'The logo is ' +
      logo.contentType +
      ', which mail clients do not reliably render. Upload a PNG or JPEG under Settings - Customisation to use it in email.'
    );
  }
  if (logo.byteSize > MAX_INLINE_BYTES) {
    return (
      'The logo is ' +
      Math.round(logo.byteSize / 1024) +
      ' KB, over the ' +
      Math.round(MAX_INLINE_BYTES / 1024) +
      ' KB an email may carry. Upload a smaller one under Settings - Customisation.'
    );
  }
  return '';
}

/**
 * The images a body needs, read from disk.
 *
 * Returns an empty list rather than throwing: a logo that cannot be attached
 * must not stop the notification itself from going out. The body then has one
 * broken image, which is a great deal better than the ticket update never
 * arriving - and `logoProblem()` has already said so on the page.
 */
export async function inlineImagesFor(bodyHtml: string): Promise<InlineImage[]> {
  const images = await customImagesFor(bodyHtml);
  return usesLogo(bodyHtml) ? [...(await logoImages()), ...images] : images;
}

/**
 * Why a custom image would not arrive in an email, or '' when it would.
 * The same two rules as the logo: a type every mail client draws, and small
 * enough to be paid for on every message.
 */
export function customImageProblem(image: Pick<CustomImageRow, 'content_type' | 'byte_size'>): string {
  if (!SENDABLE_TYPES.has(image.content_type)) {
    return 'Mail clients cannot show this type - use PNG, JPEG or GIF for email.';
  }
  if (image.byte_size > MAX_INLINE_BYTES) {
    return 'Over the ' + Math.round(MAX_INLINE_BYTES / 1024) + ' KB an email may carry.';
  }
  return '';
}

/** The custom images a body names with cid:image-<id>, read from disk. */
async function customImagesFor(bodyHtml: string): Promise<InlineImage[]> {
  const out: InlineImage[] = [];
  for (const id of referencedImageIds(bodyHtml)) {
    try {
      const image = await findCustomImage(id);
      if (!image || customImageProblem(image)) continue;
      const content = await fsp.readFile(customImagePath(image));
      if (content.byteLength > MAX_INLINE_BYTES) continue;
      out.push({
        cid: imageCid(image.id),
        contentType: image.content_type,
        fileName: image.original_name || image.name,
        content,
      });
    } catch (err) {
      // As with the logo: one missing image never stops the message.
      log.warn({ err, id }, 'could not read a custom image for an email');
    }
  }
  return out;
}

async function logoImages(): Promise<InlineImage[]> {

  const logo = settings().branding.logo;
  if (!logo || logoProblem()) return [];

  try {
    const content = await fsp.readFile(brandingAssetPath(logo));
    // Checked again against the file rather than trusting the recorded size.
    if (content.byteLength > MAX_INLINE_BYTES) return [];

    return [
      {
        cid: LOGO_CID,
        contentType: logo.contentType,
        fileName: logo.originalName || 'logo',
        content,
      },
    ];
  } catch (err) {
    log.warn({ err }, 'could not read the logo for an email');
    return [];
  }
}

/**
 * The same images as `data:` URIs, for the preview.
 *
 * `cid:` means nothing to a browser, so the preview would show an empty box
 * where the real message shows the logo. Substituting the actual bytes keeps
 * the preview honest both ways: the real file is what is drawn, and when it
 * could not be sent nothing is substituted, so the preview is as broken as
 * the email would be.
 */
export async function previewHtml(bodyHtml: string): Promise<string> {
  const images = await inlineImagesFor(bodyHtml);
  let html = bodyHtml;

  for (const image of images) {
    const uri = 'data:' + image.contentType + ';base64,' + image.content.toString('base64');
    html = html.replace(new RegExp('cid:' + image.cid + '\\b', 'gi'), uri);
  }

  return html;
}
