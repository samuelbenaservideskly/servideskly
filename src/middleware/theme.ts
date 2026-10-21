import * as cookieLib from 'cookie';
import type { Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { settings } from '../settings/index.js';

/**
 * Light and dark mode.
 *
 * Three states, not two. "System" follows the operating system through the
 * `prefers-color-scheme` media query, which is the right default - someone who
 * has set their machine to dark at sunset should not have to set it again
 * here. The other two override it.
 *
 * The choice is a cookie rather than a session value, because the sign-in page
 * has no session yet and is exactly where a reader notices the theme is wrong.
 *
 * No client-side JavaScript is involved: the preference is submitted as a
 * form, stored in a cookie, and rendered as a `data-theme` attribute on
 * `<html>`, which the stylesheet keys off. That keeps the policy at
 * `script-src 'none'`.
 */
export const THEME_COOKIE = 'helpdesk_theme';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * The stored preference, or the service desk's own default when there is
 * none - light on a new deployment (asked for 16 Oct 2026). Somebody who
 * picks "System default" gets a cookie saying so, which is why that choice
 * is not the same as having chosen nothing.
 */
export function readTheme(req: Request): Theme {
  const fallback = settings().branding.defaultMode ?? 'light';
  const header = req.headers.cookie;
  if (!header) return fallback;
  try {
    const value = cookieLib.parse(header)[THEME_COOKIE];
    return isTheme(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeTheme(res: Response, theme: Theme): void {
  if (theme === 'system' && (settings().branding.defaultMode ?? 'light') === 'system') {
    // Nothing to store: no cookie already means "follow the system" here.
    res.clearCookie(THEME_COOKIE, { path: '/' });
    return;
  }
  res.cookie(THEME_COOKIE, theme, {
    httpOnly: true,
    secure: config.session.secureCookies,
    sameSite: 'lax',
    path: '/',
    // A display preference is worth remembering for a long time.
    maxAge: 365 * 24 * 60 * 60 * 1000,
    signed: false,
  });
}

/**
 * The sidebar: full, with its labels, or compact - icons only, each name in
 * its tooltip - as Outlook's folder pane folds (asked for 21 Oct 2026).
 * A cookie like the colour mode, chosen with a form post, so no script; a
 * phone keeps its slide-in menu either way.
 */
export const SIDEBAR_COOKIE = 'helpdesk_sidebar';

export function readSidebarCompact(req: Request): boolean {
  const header = req.headers.cookie;
  if (!header) return false;
  try {
    return cookieLib.parse(header)[SIDEBAR_COOKIE] === 'compact';
  } catch {
    return false;
  }
}

export function writeSidebar(res: Response, compact: boolean): void {
  if (!compact) {
    res.clearCookie(SIDEBAR_COOKIE, { path: '/' });
    return;
  }
  res.cookie(SIDEBAR_COOKIE, 'compact', {
    httpOnly: true,
    secure: config.session.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    signed: false,
  });
}

/**
 * Exposes the preference to every template.
 *
 * `themeAttribute` is rendered straight into the `<html>` tag, so it is an
 * empty string for 'system' rather than `data-theme="system"` - an attribute
 * the stylesheet would then have to know to ignore.
 */
export function themePreference(): RequestHandler {
  return (req, res, next) => {
    // An administrator may offer only one mode (Customisation - Appearance);
    // then nobody chooses, and the switch is not drawn.
    const modes = settings().branding.colourModes ?? 'both';
    const theme = modes === 'both' ? readTheme(req) : modes;
    res.locals.themeLocked = modes !== 'both';
    res.locals.theme = theme;
    res.locals.themeAttribute = theme === 'system' ? '' : ' data-theme="' + theme + '"';
    // Shown on the control itself, so the current choice is readable without
    // opening it.
    res.locals.themeLabel = theme === 'system' ? 'System default' : theme === 'dark' ? 'Dark' : 'Light';
    res.locals.sidebarCompact = readSidebarCompact(req);
    next();
  };
}
