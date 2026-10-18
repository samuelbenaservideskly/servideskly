import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertCsrfToken } from '../middleware/csrf.js';
import { allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { LOGO_EXTENSIONS, MAX_BRANDING_BYTES } from '../services/branding.js';
import {
  addCustomImage,
  customImagePath,
  deleteCustomImage,
  findCustomImage,
  setCustomImagePrivate,
  imageCid,
  listCustomImages,
} from '../services/custom-images.js';
import { customImageProblem } from '../services/mail/inline-images.js';
import { attempt } from './form-errors.js';
import { settingsView } from './settings-shared.js';

const log = logger.child({ module: 'routes/custom-images' });

const BASE = '/admin/settings/customization/images';

// ---------------------------------------------------------------------------
// Public: the image itself
// ---------------------------------------------------------------------------

/**
 * Serves an uploaded image at /images/<id>.
 *
 * Public by default, like the logo: these are the organisation's own
 * artwork, put there to be shown - including on pages a person reaches before
 * signing in. **A private image** answers only a signed-in person; anybody
 * else gets the same 404 as an image that does not exist, and no shared cache
 * may keep it. The same headers as the logo: the verified type, nosniff, and
 * a sandbox policy so a screened SVG still cannot run if opened directly.
 */
export const publicImageRouter = Router();

publicImageRouter.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const image = await findCustomImage(String(req.params.id));
    if (!image) throw notFound('No such image.');
    if (image.is_private && !req.currentUser) throw notFound('No such image.');

    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(customImagePath(image));
    } catch {
      throw notFound('No such image.');
    }
    res.setHeader('Content-Type', image.content_type);
    res.setHeader('Content-Length', String(image.byte_size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('ETag', '"' + image.sha256.slice(0, 32) + '"');
    // The id never points at different bytes, so it can be kept.
    res.setHeader('Cache-Control', image.is_private ? 'private, max-age=3600' : 'public, max-age=604800, immutable');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    stream.on('error', (err) => {
      log.warn({ err, id: image.id }, 'custom image could not be read');
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    stream.pipe(res);
  }),
);

// ---------------------------------------------------------------------------
// Settings - Customisation - Custom images
// ---------------------------------------------------------------------------

export const customImagesAdminRouter = Router();

async function renderList(
  res: Response,
  extra: {
    problems?: string[];
    name?: string;
    openDialog?: string | null;
    q?: string;
  } = {},
  status?: number,
): Promise<void> {
  const q = (extra.q ?? '').trim().toLowerCase();
  const all = await listCustomImages();
  const images = all.filter((image) => !q || image.name.toLowerCase().includes(q)).map((image) => ({
    ...image,
    webSrc: '/images/' + image.id,
    absoluteSrc: config.publicOrigin + '/images/' + image.id,
    cid: imageCid(image.id),
    emailProblem: customImageProblem(image),
  }));
  if (status) res.status(status);
  res.render(
    'admin/settings/custom-images',
    settingsView('customization', {
      images,
      accept: LOGO_EXTENSIONS.join(','),
      maxKb: Math.round(MAX_BRANDING_BYTES / 1024),
      problems: extra.problems ?? [],
      nameValue: extra.name ?? '',
      openDialog: extra.openDialog ?? null,
      q: extra.q ?? '',
    }),
  );
}

customImagesAdminRouter.get(
  '/',
  // The copy buttons: one small script of ours, on this page only.
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    await renderList(res, {
      q: typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '',
    });
  }),
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BRANDING_BYTES, files: 1, fields: 5, parts: 8 },
}).single('image');

customImagesAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tooBig = await new Promise<boolean>((resolve, reject) => {
      upload(req, res, (err: unknown) => {
        if (!err) resolve(false);
        else if (err instanceof multer.MulterError) resolve(true);
        else reject(err);
      });
    });
    // The global CSRF check runs before a multipart body exists.
    assertCsrfToken(req);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const isPrivate = body.isPrivate === 'on';
    // Refused in the dialog, not on an error page (trap 6).
    const refuse = (problem: string) =>
      renderList(res, { problems: [problem], name, openDialog: 'upload-image' }, 400);

    if (tooBig) {
      await refuse('Images must be ' + Math.round(MAX_BRANDING_BYTES / 1024) + ' KB or smaller.');
      return;
    }
    if (!name) {
      await refuse('Give the image a name.');
      return;
    }
    if (!req.file) {
      await refuse('Choose an image to upload.');
      return;
    }
    const file = req.file;
    const added = await attempt(() =>
      addCustomImage(name, file.originalname, file.buffer, req.currentUser?.id ?? null, isPrivate),
    );
    if (!added.ok) {
      await refuse(added.errors.name ?? added.errors.form ?? Object.values(added.errors)[0] ?? '');
      return;
    }
    flash(req, 'success', 'Image "' + name + '" uploaded.');
    // Scrolled to and highlighted (:target), but closed like every row: an
    // address with ?open= reopened it on every refresh.
    res.redirect(BASE + '#image-' + added.value.id);
  }),
);

customImagesAdminRouter.post(
  '/:id/private',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const isPrivate = (req.body ?? {}).isPrivate === 'on';
    const done = await attempt(() => setCustomImagePrivate(id, isPrivate, req.currentUser?.id ?? null));
    flash(
      req,
      done.ok ? 'success' : 'error',
      done.ok
        ? isPrivate
          ? 'Private: only signed-in people can load it. Emails still carry it.'
          : 'Public: anybody with the address can load it.'
        : Object.values(done.errors)[0] ?? '',
    );
    res.redirect(BASE + '#image-' + id);
  }),
);

customImagesAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const result = await attempt(() =>
      deleteCustomImage(String(req.params.id), req.currentUser?.id ?? null),
    );
    if (result.ok) {
      flash(req, 'success', 'Image removed. Anything still pointing at it now shows a broken image.');
    } else {
      flash(req, 'error', result.errors.form ?? Object.values(result.errors)[0] ?? '');
    }
    res.redirect(BASE);
  }),
);
