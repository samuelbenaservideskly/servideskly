import { Router } from 'express';
import { safeRedirectPath } from '../lib/util.js';
import { isTheme, writeSidebar, writeTheme } from '../middleware/theme.js';

/**
 * Setting the light/dark preference.
 *
 * A POST rather than a link, because it changes stored state - and a GET that
 * did so could be triggered by any page that embeds an image pointing at it.
 * The CSRF token and the Sec-Fetch-Site check apply as they do everywhere
 * else; nothing here is exempt.
 *
 * Available signed in or not: the sign-in page is where a reader is most
 * likely to notice the theme is wrong.
 */
export const themeRouter = Router();

themeRouter.post('/theme', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  // An unknown value is treated as "follow the system" rather than refused:
  // a display preference is not worth an error page.
  writeTheme(res, isTheme(body.theme) ? body.theme : 'system');
  res.redirect(303, safeRedirectPath(body.returnTo, '/'));
});

/** The sidebar, full or compact (middleware/theme.ts). The same rules as the theme. */
themeRouter.post('/sidebar', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  writeSidebar(res, body.sidebar === 'compact');
  res.redirect(303, safeRedirectPath(body.returnTo, '/'));
});
