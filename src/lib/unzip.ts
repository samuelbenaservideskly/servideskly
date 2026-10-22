import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of a zip reader for a .docx (step 5 of assets, 21 Oct 2026):
 * the central directory, stored or deflated entries, node:zlib. The writer
 * is zipFiles() in lib/xlsx.ts. No dependency, like that writer.
 *
 * Bounded, because the file comes from an upload: at most MAX_ENTRIES
 * entries and MAX_TOTAL bytes once inflated (a zip bomb is a small file
 * that inflates to gigabytes), no zip64, no encryption. Anything else is
 * refused with a reason rather than half read.
 */

const MAX_ENTRIES = 2000;
const MAX_TOTAL = 60 * 1024 * 1024;

export class ZipError extends Error {}

/** Every entry, in the order the central directory lists them. */
export function unzip(zip: Buffer): [string, Buffer][] {
  // The end of central directory record: the last 0x06054b50 within the
  // final 64 KB (it may be followed by a comment).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new ZipError('too many entries');
  if (count === 0xffff || at === 0xffffffff) throw new ZipError('zip64 is not supported');

  const out: [string, Buffer][] = [];
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new ZipError('damaged central directory');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) throw new ZipError('encrypted entries are not supported');
    total += size;
    if (total > MAX_TOTAL) throw new ZipError('too large once unpacked');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new ZipError('damaged entry ' + name);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    let content: Buffer;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
    else throw new ZipError('unsupported compression in ' + name);
    if (content.length !== size) throw new ZipError('damaged entry ' + name);
    out.push([name, content]);
  }
  return out;
}
