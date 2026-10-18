import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { settings } from '../settings/index.js';
import {
  brandingAssetPath,
  brandingVersion,
  defaultFaviconSvg,
  themeStylesheet,
} from '../services/branding.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'routes/branding' });

/**
 * Serves the customisable theme and the uploaded logo and favicon.
 *
 * These are public: the sign-in page needs them before anyone is
 * authenticated. They carry no information beyond the organisation's own
 * branding, which is by definition visible to anyone who can reach the page.
 */
export const brandingRouter = Router();

/** Long-lived caching is safe because the URL carries a content hash. */
function cacheHeaders(res: Response, versioned: boolean): void {
  if (versioned) {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  } else {
    // Unversioned requests (e.g. /favicon.ico from the browser chrome) must
    // revalidate, or a rebrand would not be picked up.
    res.setHeader('Cache-Control', 'public, max-age=300');
  }
}

brandingRouter.get('/branding/theme.css', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  cacheHeaders(res, typeof req.query.v === 'string');
  res.setHeader('ETag', '"' + brandingVersion() + '"');
  res.send(themeStylesheet());
});

/** Streams an uploaded image, or 404 when none is set. */
function sendAsset(res: Response, kind: 'logo' | 'favicon', versioned: boolean): boolean {
  const asset = settings().branding[kind];
  if (!asset) return false;

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(brandingAssetPath(asset));
  } catch {
    return false;
  }

  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Content-Length', String(asset.byteSize));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // An uploaded SVG is a document format. Even though the markup was screened
  // on upload, serving it sandboxed means script could not run if navigated to
  // directly.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('ETag', '"' + asset.sha256.slice(0, 32) + '"');
  cacheHeaders(res, versioned);

  stream.on('error', (err) => {
    log.warn({ err, kind }, 'branding asset could not be read');
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  });
  stream.pipe(res);
  return true;
}

brandingRouter.get('/branding/logo', (req: Request, res: Response) => {
  if (!sendAsset(res, 'logo', typeof req.query.v === 'string')) {
    res.status(404).end();
  }
});

brandingRouter.get('/branding/favicon', (req: Request, res: Response) => {
  if (sendAsset(res, 'favicon', typeof req.query.v === 'string')) return;

  // A plain square in the brand colour. No invented mark.
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  cacheHeaders(res, typeof req.query.v === 'string');
  res.send(defaultFaviconSvg());
});

/** Browsers request this path directly, whatever the page markup says. */
brandingRouter.get('/favicon.ico', (_req: Request, res: Response) => {
  if (sendAsset(res, 'favicon', false)) return;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  cacheHeaders(res, false);
  res.send(defaultFaviconSvg());
});
