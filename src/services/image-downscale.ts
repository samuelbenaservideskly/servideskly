/**
 * Pictures are made smaller the way Teams and Outlook do it (asked for
 * 17 Oct 2026): a phone photo of 4,000 pixels and 6 MB is stored at 2,560
 * pixels on its longest side - still sharper than any screen shows it - for a
 * fraction of the bytes.
 *
 * - **Only when it helps.** A picture within 2,560 pixels is left exactly as
 *   it came, except a large PNG, which is recompressed losslessly. A JPEG is
 *   never re-encoded just to save bytes: each pass loses a little.
 * - **The same format, the same name.** A screenshot stays a PNG (lossless,
 *   so text stays crisp); a photo stays a JPEG at quality 85 with mozjpeg,
 *   which nobody tells from the original at that size.
 * - **Turned upright, and its location dropped.** The EXIF rotation is
 *   applied, then the metadata - GPS position included - is not carried
 *   over; the colour profile is.
 * - **Never worse, never a refusal.** The result is kept only if it is
 *   smaller; anything that fails, is not a picture, or is too large to open
 *   safely (over 60 megapixels) is stored as it came.
 *
 * GIF is left alone: it may be animated.
 */
import sharp from 'sharp';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'image-downscale' });

/** Longest side, in pixels, a stored picture keeps. */
export const MAX_EDGE = 2560;
/** A PNG within that size is recompressed only above this. */
const PNG_RECOMPRESS_FROM = 1024 * 1024;
/** Decoding a bigger picture would take more memory than one vCPU's plan should spend on it. */
const MAX_PIXELS = 60_000_000;

// One picture at a time, and nothing kept between them: memory over speed.
sharp.cache(false);
sharp.concurrency(1);

const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** The bytes to store for a file: smaller when a picture can be, otherwise the same Buffer. */
export async function downscaleImage(bytes: Buffer, contentType: string): Promise<Buffer> {
  if (!RESIZABLE.has(contentType)) return bytes;
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
    if (!meta.width || !meta.height) return bytes;
    // EXIF orientations 5-8 swap the sides.
    const longest = Math.max(meta.width, meta.height);
    const tooBig = longest > MAX_EDGE;
    if (!tooBig && !(contentType === 'image/png' && bytes.length > PNG_RECOMPRESS_FROM)) return bytes;

    let image = sharp(bytes, { limitInputPixels: MAX_PIXELS }).rotate().keepIccProfile();
    if (tooBig) image = image.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    if (contentType === 'image/jpeg') image = image.jpeg({ quality: 85, mozjpeg: true });
    else if (contentType === 'image/png') image = image.png({ compressionLevel: 9, adaptiveFiltering: true });
    else image = image.webp({ quality: 85 });

    const out = await image.toBuffer();
    return out.length < bytes.length ? out : bytes;
  } catch (err) {
    log.warn({ err: (err as Error).message, contentType }, 'a picture could not be made smaller; stored as it came');
    return bytes;
  }
}
