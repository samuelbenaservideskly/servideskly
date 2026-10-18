import './env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { MAX_EDGE, downscaleImage } from '../src/services/image-downscale.js';

/** A photo-like picture: noise, so it does not compress to nothing. */
async function photo(width: number, height: number, format: 'jpeg' | 'png'): Promise<Buffer> {
  const raw = crypto.randomBytes(width * height * 3);
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === 'jpeg' ? image.jpeg({ quality: 92 }).toBuffer() : image.png({ compressionLevel: 0 }).toBuffer();
}

test('a large photo is stored at 2,560 pixels on its longest side, as a JPEG, and smaller', async () => {
  const big = await photo(4000, 3000, 'jpeg');
  const out = await downscaleImage(big, 'image/jpeg');
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, MAX_EDGE);
  assert.equal(meta.height, 1920, 'the proportions are kept');
  assert.ok(out.length < big.length);
});

test('a picture within the size is left exactly as it came', async () => {
  const small = await photo(1200, 800, 'jpeg');
  assert.equal(await downscaleImage(small, 'image/jpeg'), small, 'the same bytes, not re-encoded');
});

test('a large PNG screenshot within the size is recompressed losslessly', async () => {
  // Flat colour, as a screenshot is: stored uncompressed, it is large.
  const flat = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#e4e7ec' } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(flat.length > 1024 * 1024);
  const out = await downscaleImage(flat, 'image/png');
  assert.ok(out.length < flat.length);
  const a = await sharp(flat).raw().toBuffer();
  const b = await sharp(out).raw().toBuffer();
  assert.ok(a.equals(b), 'every pixel the same');
});

test('anything that is not a picture, or not a valid one, is stored as it came', async () => {
  const pdf = Buffer.from('%PDF-1.7 not an image');
  assert.equal(await downscaleImage(pdf, 'application/pdf'), pdf);
  const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(2_000_000)]);
  assert.equal(await downscaleImage(broken, 'image/jpeg'), broken);
});
