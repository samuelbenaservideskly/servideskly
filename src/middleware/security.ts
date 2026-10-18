import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'security' });

/**
 * Response headers.
 *
 * The Content-Security-Policy is deliberately severe: this application serves
 * no JavaScript at all, so `script-src 'none'` is achievable and removes the
 * entire class of script-injection attacks rather than merely filtering them.
 */
export function securityHeaders(): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'script-src': ["'none'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          'connect-src': ["'none'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'object-src': ["'none'"],
          'manifest-src': ["'self'"],
          ...(config.session.secureCookies ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      // Not required here and known to break legitimate sub-resources.
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      // Enabled only when the public origin is https, otherwise a local http
      // deployment would pin itself out of reach.
      hsts: config.session.secureCookies
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: false }
        : false,
      frameguard: { action: 'deny' },
      noSniff: true,
      xPoweredBy: false,
      ieNoOpen: true,
      dnsPrefetchControl: { allow: false },
      originAgentCluster: true,
    }),
    (_req: Request, res: Response, next: NextFunction) => {
      // No browser feature this application uses needs a powerful permission.
      res.setHeader(
        'Permissions-Policy',
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
      );
      next();
    },
  ];
}

/**
 * Lets one page load one script of ours.
 *
 * The form builder's drag-and-drop is the single thing in this application
 * that cannot be done without JavaScript, so the policy is relaxed for that
 * response only - every other page in the process keeps `script-src 'none'`.
 *
 * Note what this does **not** allow. The directive becomes `'self'`, not
 * `'unsafe-inline'`, so an injected `<script>alert(1)</script>` is still
 * refused on the builder page too; the only thing that can now execute is a
 * file already served from `/assets`. The page is also administrator-only,
 * and the builder works without the script - the arrow buttons do the same
 * job - so if this ever looks like a liability it can be removed by deleting
 * one middleware and one `<script>` tag.
 */
export function allowOwnScripts(): RequestHandler {
  return (_req, res, next) => {
    const policy = res.getHeader('Content-Security-Policy');
    if (typeof policy === 'string' && policy.includes("script-src 'none'")) {
      res.setHeader(
        'Content-Security-Policy',
        policy.replace("script-src 'none'", "script-src 'self'"),
      );
    }
    next();
  };
}

/**
 * Lets one page's script talk to this server: `connect-src 'self'` instead
 * of `'none'`. Only the template builder, whose script moves a field without
 * reloading the page - it posts the same form the page would, then fetches
 * the page again and swaps the builder in. Nothing leaves for another origin.
 */
export function allowOwnRequests(): RequestHandler {
  return (_req, res, next) => {
    const policy = res.getHeader('Content-Security-Policy');
    if (typeof policy === 'string' && policy.includes("connect-src 'none'")) {
      res.setHeader('Content-Security-Policy', policy.replace("connect-src 'none'", "connect-src 'self'"));
    }
    next();
  };
}

/**
 * Lets one page frame a document of ours.
 *
 * The notification preview is an iframe, because the body being previewed is
 * HTML an administrator wrote: rendering it inline would let its styles - or
 * a stray unclosed tag - reach the settings page around it, and a mail client
 * shows a message as its own document anyway.
 *
 * `frame-src 'self'` only, so the one thing that can be framed is a page
 * this process served. The framed response sets its own policy, stricter
 * still: no script, no network, inline styles and data: images and nothing
 * else.
 */
export function allowOwnFrames(): RequestHandler {
  return (_req, res, next) => {
    const policy = res.getHeader('Content-Security-Policy');
    if (typeof policy === 'string' && !policy.includes('frame-src')) {
      res.setHeader('Content-Security-Policy', policy + "; frame-src 'self'");
    }
    next();
  };
}

/**
 * Lets a form on this one response lead to the given origins.
 *
 * `form-action` also governs where a form submission is **redirected**:
 * "Sign in with ..." posts to /auth/login, which answers with a redirect to
 * the identity provider - and Chrome refused that redirect under
 * `form-action 'self'`, so single sign-on silently did nothing. The page
 * that carries such a button names the provider origins it may reach, and
 * only https origins; every other page keeps `'self'`.
 */
export function allowFormActionTo(res: Response, origins: readonly string[]): void {
  const policy = res.getHeader('Content-Security-Policy');
  const safe = [...new Set(origins.filter((o) => /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o)))];
  if (typeof policy !== 'string' || safe.length === 0) return;
  res.setHeader('Content-Security-Policy', policy.replace("form-action 'self'", "form-action 'self' " + safe.join(' ')));
}

/**
 * Lets a custom requester portal page run its administrator's script.
 *
 * Settings - Advanced - JavaScript, off by default and switched on behind a
 * warning. Scripts from this origin (the portal's own file) plus the listed
 * origins may run, and may talk to the same list. Still never
 * 'unsafe-inline' or 'unsafe-eval', so an injected inline script or an
 * on*= handler stays refused - and only on the response that asks.
 */
export function allowPortalScripts(res: Response, origins: readonly string[]): void {
  const policy = res.getHeader('Content-Security-Policy');
  if (typeof policy !== 'string') return;
  const sources = ["'self'", ...origins].join(' ');
  res.setHeader(
    'Content-Security-Policy',
    policy
      .replace("script-src 'none'", 'script-src ' + sources)
      .replace("connect-src 'none'", 'connect-src ' + sources),
  );
}

/**
 * Lets this one response be framed by a page of ours.
 *
 * The requester-portal editor shows a real requester page beside the code,
 * in an iframe. Helmet's `X-Frame-Options: DENY` would block that whatever
 * the policy says, so it goes, and `frame-ancestors 'self'` - the same rule,
 * stated for one response - replaces `'none'`. Only ever called for an
 * administrator who asked for the preview.
 */
export function allowFramingBySelf(res: Response): void {
  res.removeHeader('X-Frame-Options');
  const policy = res.getHeader('Content-Security-Policy');
  if (typeof policy === 'string') {
    res.setHeader(
      'Content-Security-Policy',
      policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
    );
  }
}

/**
 * Authenticated pages must not be written to shared or browser caches, or a
 * later user of the same machine could read them from history.
 */
export function noStore(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  };
}

/**
 * Diagnoses the most costly deployment mistake: an https `APP_BASE_URL` with
 * `TRUST_PROXY` left unset.
 *
 * The session cookie is then marked Secure, and Express will not send a Secure
 * cookie on a connection it believes is plain http. No cookie means no session,
 * which means the CSRF token can never match and every sign-in fails with a
 * bare 403. Turning that into one explicit log line saves a long hunt.
 */
export function warnOnInsecureConnection(): RequestHandler {
  let warned = false;
  return (req, _res, next) => {
    if (!warned && config.session.secureCookies && !req.secure) {
      warned = true;
      log.error(
        {
          appBaseUrl: config.publicOrigin,
          trustProxy: config.trustProxy,
          forwardedProto: req.get('x-forwarded-proto') ?? null,
        },
        'APP_BASE_URL is https but this request arrived as plain http, so the Secure ' +
          'session cookie cannot be set and every sign-in will fail. Set TRUST_PROXY ' +
          '(usually 1) and make the proxy send X-Forwarded-Proto: https, or serve the ' +
          'application over TLS directly.',
      );
    }
    next();
  };
}

function limiter(options: {
  windowMs: number;
  max: number;
  name: string;
  /** Count only the responses this says are failures; the rest pass free. */
  failures?: (res: import('express').Response) => boolean;
  /** Rate limiting is per instance and off in tests; a test of the limiter itself turns it on. */
  inTests?: boolean;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    ...(options.failures
      ? { skipSuccessfulRequests: true, requestWasSuccessful: (_req, res) => !options.failures!(res) }
      : {}),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Never rate-limit by a header the client controls.
    keyGenerator: (req) => req.ip ?? 'unknown',
    handler: (req, res, _next, optionsUsed) => {
      log.warn({ ip: req.ip, path: req.path, limiter: options.name }, 'rate limit exceeded');
      const message = 'Too many requests. Please wait a moment and try again.';
      res.status(optionsUsed.statusCode);
      if (req.accepts(['html', 'json']) !== 'html') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(message);
        return;
      }
      res.render('error', { title: 'Too many requests', status: optionsUsed.statusCode, message, reference: null, stack: null }, (err, html) => {
        if (err) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.send(message);
          return;
        }
        res.send(html);
      });
    },
    // Rate limiting is per instance; skip it in tests so they stay hermetic.
    skip: () => config.isTest && !options.inTests,
  });
}

/**
 * Guessing API keys: ten refused keys (401) from one address in fifteen
 * minutes, and that address is answered 429 for the rest of the window. A
 * request with a working key is not counted, so an integration that works
 * is never slowed by it. Keys are 256 random bits, so this is about noise
 * and cost rather than odds - but a prober should still hit a wall.
 */
export function keyGuessLimiter(inTests = false): RateLimitRequestHandler {
  return limiter({ windowMs: 15 * 60_000, max: 10, name: 'api-key-guess', failures: (res) => res.statusCode === 401, inTests });
}
export const apiKeyGuessLimiter = keyGuessLimiter();

/** Broad ceiling on any single client, to blunt scraping and brute force. */
export const globalLimiter = limiter({ windowMs: 15 * 60_000, max: 1000, name: 'global' });

/** Starting a login is cheap for the client and expensive for the IdP. */
export const loginLimiter = limiter({ windowMs: 15 * 60_000, max: 30, name: 'login' });

/** Assertion and code processing involves signature checks and network calls. */
export const callbackLimiter = limiter({ windowMs: 15 * 60_000, max: 60, name: 'callback' });

/** An automation started over HTTP: a machine, but one that is not ours. */
export const hookLimiter = limiter({ windowMs: 15 * 60_000, max: 300, name: 'hook' });

/** Everything that writes to the database. */
export const writeLimiter = limiter({ windowMs: 15 * 60_000, max: 300, name: 'write' });

/**
 * Cross-origin request check for state-changing requests.
 *
 * This runs alongside, not instead of, the CSRF token: `Sec-Fetch-Site` is set
 * by the browser and cannot be forged by page script, which catches forgery
 * attempts before any token is even looked at. Requests without the header
 * (older browsers, server-side clients) fall through to the Origin check and
 * then to the token.
 *
 * Note that this must not require the request to arrive at the *configured*
 * origin. Reaching a deployment by a second valid name is normal, and the
 * question being asked here is only whether the request came from another
 * site - which the browser itself already answers.
 */
export function sameSiteOnly(exemptPaths: readonly string[] = []): RequestHandler {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  const exempt = new Set(exemptPaths);
  return (req, _res, next) => {
    if (safeMethods.has(req.method)) {
      next();
      return;
    }

    // The SAML assertion consumer service is exempt by design: the identity
    // provider POSTs to it from its own origin. That endpoint is protected by
    // the XML signature, the audience and InResponseTo checks instead.
    if (exempt.has(req.path)) {
      next();
      return;
    }

    // Sec-Fetch-Site is computed and set by the browser and cannot be forged by
    // page script, so it is authoritative when present. "same-origin" settles
    // the question on its own; comparing Origin to a configured value on top of
    // that would reject legitimate requests whenever the browser reaches the
    // application by any other valid name (127.0.0.1 instead of localhost, an
    // internal DNS alias, a direct IP).
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite) {
      if (fetchSite === 'same-origin' || fetchSite === 'none') {
        next();
        return;
      }
      log.warn({ path: req.path, fetchSite }, 'blocked cross-site state-changing request');
      next(forbidden('This request appears to come from another site.', 'cross_site_request'));
      return;
    }

    // No Sec-Fetch-Site: an older browser or a non-browser client. Fall back to
    // Origin, accepting either the configured public origin or the origin this
    // request was actually addressed to.
    const origin = req.get('origin');
    if (origin && origin !== config.publicOrigin && origin !== requestOrigin(req)) {
      log.warn(
        { path: req.path, origin, expected: config.publicOrigin },
        'blocked request with foreign Origin',
      );
      next(forbidden('This request appears to come from another site.', 'origin_mismatch'));
      return;
    }

    next();
  };
}

/**
 * The origin this request was addressed to, from the protocol and Host that
 * Express resolved (which honours X-Forwarded-* only when TRUST_PROXY is set).
 */
function requestOrigin(req: Request): string | null {
  const host = req.get('host');
  if (!host) return null;
  return req.protocol + '://' + host;
}
