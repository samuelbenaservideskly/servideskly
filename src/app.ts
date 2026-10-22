import path from 'node:path';
import { installAutomations } from './services/automation.js';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { pinoHttp } from 'pino-http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config, ROOT_DIR } from './config.js';
import { logger } from './lib/logger.js';
import { query } from './db/index.js';
import {
  authModeLabel,
  formatDateTime,
  formatDate,
  formatDetail,
  detailPairs,
  formatRelative,
  shortFileName,
  formatDuration,
  provisioningLabel,
  queryString,
  roleLabel,
  sourceLabel,
  stateLabel,
  triggerLabel,
} from './lib/format.js';
import { allowSignOutRedirect, authRouter } from './routes/auth.js';
import { providerName, providerOfIssuer } from './auth/oidc.js';
import { adminSetupRouter } from './routes/admin-setup.js';
import { ticketRouter } from './routes/tickets.js';
import { peopleRouter } from './routes/people.js';
import { columnLists } from './routes/column-lists.js';
import { assetsRouter } from './routes/assets.js';
import { registerAssetNotifications } from './services/asset-notify.js';
import { searchRouter } from './routes/search.js';
import { selectSearch } from './middleware/select-search.js';
import { workDashboardLink, workDashboardRouter } from './routes/work-dashboard.js';
import { reportsRouter } from './routes/reports.js';
import { boardsRouter } from './routes/boards.js';
import { adminRouter } from './routes/admin.js';
import { approvalRouter } from './routes/approvals.js';
import { homeRouter, portalPresentation, portalRouter, portalScriptRouter } from './routes/portal.js';
import { publicImageRouter } from './routes/custom-images.js';
import { profileRouter } from './routes/profile.js';
import { brandingRouter } from './routes/branding.js';
import { themeRouter } from './routes/theme.js';
import { scimRouter } from './routes/scim.js';
import { hooksRouter } from './routes/hooks.js';
import { portalAdminsRouter } from './routes/portal-admins.js';
import { apiReadRouter } from './routes/api-read.js';
import { apiWriteRouter } from './routes/api-write.js';
import { loadCurrentUser } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { notFound } from './lib/errors.js';
import {
  globalLimiter,
  noStore,
  sameSiteOnly,
  securityHeaders,
  warnOnInsecureConnection,
} from './middleware/security.js';
import { enforceSessionLifetime, sessionMiddleware } from './middleware/session.js';
import { viewLocals } from './middleware/view-locals.js';
import { themePreference } from './middleware/theme.js';
import { language } from './middleware/language.js';
import { useTranslatedViews } from './i18n/engine.js';
import { english, interpolatorFor, textInterpolatorFor } from './i18n/index.js';
import { installSettingsWiring } from './settings/wiring.js';

/**
 * No browser-facing endpoint accepts a cross-site POST any more.
 *
 * The SAML assertion consumer service used to be the exception. OpenID
 * Connect returns through a redirect the browser makes itself, so every
 * state-changing request is now same-site and subject to both the CSRF token
 * and the Sec-Fetch-Site check. SCIM is not in this list because it is not
 * mounted in the browser pipeline at all - see below.
 */
const CROSS_SITE_ENDPOINTS = [] as const;

/**
 * Attachment uploads are multipart, and the global CSRF middleware runs before
 * any multipart parser, so `req.body` is not populated when it looks for the
 * token. The route therefore calls `assertCsrfToken` itself once multer has
 * parsed the body. This exemption is deliberately narrow - it covers only the
 * upload endpoint, and those requests still go through the Sec-Fetch-Site and
 * Origin checks, which need no body at all.
 */
function isAttachmentUploadPath(path: string): boolean {
  // Raising a ticket, which may carry files with it.
  if (path === '/tickets') return true;

  const parts = path.split('/');
  // A reply, which may carry files (21 Oct 2026). The route checks the token
  // itself on every post, with files or without.
  if (parts.length === 4 && parts[1] === 'tickets' && parts[3] === 'comments' && parts[2] !== '') return true;
  if (
    parts.length === 4 &&
    parts[1] === 'tickets' &&
    parts[3] === 'attachments' &&
    parts[2] !== ''
  ) {
    return true;
  }
  // The local-users CSV import and the custom image upload, which check the
  // token themselves once the multipart body is parsed.
  if (path === '/admin/settings/users/import') return true;
  // The assets import (routes/assets.ts), checked there the same way.
  if (path === '/inventory/import') return true;
  // Files added to an asset (routes/assets.ts), checked there the same way.
  if (/^\/inventory\/[0-9a-f-]{36}\/attachments$/.test(path)) return true;
  // A document template for assets (routes/assets-admin.ts), the same way.
  if (path === '/admin/settings/assets/documents') return true;
  if (path === '/admin/settings/customization/images') return true;

  // /admin/settings/customization/{logo|favicon}/upload
  return (
    parts.length === 6 &&
    parts[1] === 'admin' &&
    parts[2] === 'settings' &&
    parts[3] === 'customization' &&
    (parts[4] === 'logo' || parts[4] === 'favicon') &&
    parts[5] === 'upload'
  );
}

const CSRF_EXEMPT = [...CROSS_SITE_ENDPOINTS, isAttachmentUploadPath];

/**
 * Short content hash of the cacheable assets, used to bust their caches.
 *
 * `/assets` is served with a seven-day max-age, so a file without a version in
 * its URL stays stale for a week after a change. Every asset shares one hash
 * rather than carrying its own: a change to any is worth re-fetching all, and
 * one value cannot get out of step with itself.
 *
 * **Every file** under public/css and public/js, read from the folders: a
 * fixed list once left out automation-canvas.js, so a fixed canvas script
 * stayed cached in browsers for a week and the old bug looked unfixed.
 */
function assetVersion(): string {
  const hash = crypto.createHash('sha256');
  let found = false;

  for (const dir of ['css', 'js']) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(ROOT_DIR, 'public', dir)).sort();
    } catch {
      // A missing folder is a packaging problem that the 404 on the link will
      // make obvious; do not take the whole application down for it.
      continue;
    }
    for (const name of names) {
      try {
        hash.update(dir + '/' + name + '\0');
        hash.update(fs.readFileSync(path.join(ROOT_DIR, 'public', dir, name)));
        found = true;
      } catch {
        // A subfolder or an unreadable file: not an asset of ours.
      }
    }
  }

  return found ? hash.digest('hex').slice(0, 12) : 'dev';
}

export function createApp(): Express {
  // Ticket events -> automations. Idempotent: one listener however many apps.
  installAutomations();
  // Asset changes -> the assigned / unassigned emails (services/asset-notify.ts).
  registerAssetNotifications();

  installSettingsWiring();

  const app = express();

  // Trust proxy headers only when explicitly configured, so req.ip cannot be
  // spoofed through X-Forwarded-For on a directly-exposed deployment.
  if (config.trustProxy !== false) {
    const numeric = Number(config.trustProxy);
    app.set('trust proxy', Number.isInteger(numeric) ? numeric : config.trustProxy);
  } else {
    app.set('trust proxy', false);
  }

  app.disable('x-powered-by');
  // Escaping is the template engine's job; EJS escapes with <%= %> by default.
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT_DIR, 'views'));
  // The views are compiled with each of the reader's strings asking to be
  // translated (src/i18n/engine.ts). With no language enabled t() returns its
  // argument, so this changes not one byte of any page.
  useTranslatedViews(app);
  app.set('query parser', 'simple');
  app.set('etag', false);

  // Template helpers. These format only; they never mark anything as safe HTML.
  // The stylesheet is served with a seven-day max-age, so without a version
  // in the URL a CSS change stays invisible to anyone who has visited
  // before. Hashed once at start-up: the file cannot change under a running
  // process, and this is cheaper than stat-ing it per request.
  app.locals.assetVersion = assetVersion();
  // Where the source and its license are, at the foot of every page (partials/footer.ejs).
  app.locals.sourceUrl = config.sourceUrl;

  // Every render has t(), including the error page, which is drawn outside
  // the usual pipeline and so never sees res.locals.
  app.locals.t = english;
  app.locals.tr = interpolatorFor(english);
  app.locals.tx = textInterpolatorFor(english);

  app.locals.formatDateTime = formatDateTime;
  app.locals.formatDate = formatDate;
  app.locals.formatRelative = formatRelative;
  app.locals.shortFileName = shortFileName;
  app.locals.formatDuration = formatDuration;
  app.locals.formatDetail = formatDetail;
  app.locals.detailPairs = detailPairs;
  app.locals.queryString = queryString;
  app.locals.provisioningLabel = provisioningLabel;
  app.locals.roleLabel = roleLabel;
  app.locals.sourceLabel = sourceLabel;
  // Which identity provider an account signs in with, by its issuer: "Okta",
  // never "Microsoft Entra ID" for everything that is not a password.
  app.locals.providerNameOf = (issuer: string) => {
    const key = providerOfIssuer(issuer);
    return key ? providerName(key) : 'Another identity provider';
  };
  app.locals.stateLabel = stateLabel;
  app.locals.authModeLabel = authModeLabel;
  app.locals.triggerLabel = triggerLabel;

  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise dominate the log.
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(securityHeaders());

  // Liveness and readiness, before sessions so they allocate nothing.
  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });
  // Readiness means "can serve a request", which for this application means
  // the database answers. An orchestrator uses this to decide whether to
  // route traffic here, so a lost database must show up as not-ready rather
  // than as a wall of 500s.
  app.get('/readyz', (_req, res) => {
    void query('SELECT 1')
      .then(() => res.type('text/plain').send('ready'))
      .catch((err: unknown) => {
        logger.error({ err, module: 'health' }, 'readiness check failed');
        res.status(503).type('text/plain').send('not ready');
      });
  });

  // Static assets are the only cacheable responses this app serves.
  app.use(
    '/assets',
    express.static(path.join(ROOT_DIR, 'public'), {
      maxAge: '7d',
      immutable: false,
      index: false,
      dotfiles: 'deny',
      etag: true,
      fallthrough: false,
    }),
  );

  // `fallthrough: false` keeps asset requests out of the application pipeline,
  // but it also makes a missing file an exception. Translate that into a plain
  // 404 rather than letting it surface as a server error.
  const staticErrorHandler: ErrorRequestHandler = (err, _req, _res, next) => {
    const failure = err as NodeJS.ErrnoException & { status?: number };
    if (failure && (failure.code === 'ENOENT' || failure.status === 404)) {
      next(notFound('That asset does not exist.'));
      return;
    }
    next(err);
  };
  app.use('/assets', staticErrorHandler);

  // SCIM is a machine API: bearer token, no session, no CSRF, its own JSON
  // body parser and its own error documents. Mounted here, ahead of the
  // browser pipeline, so a provisioning cycle neither allocates sessions nor
  // competes with people for the global rate limit.
  app.use('/scim/v2', scimRouter);
  // Automations started by another system with an API key: the same reasons.
  app.use('/hooks', hooksRouter);
  // The customer portal's list of administrators, signed: the same reasons.
  app.use('/portal-sync', portalAdminsRouter);
  // Changing tickets with an API key (POST, PATCH), then reading them (GET):
  // the same reasons again. Writing first - it passes every GET on.
  app.use('/api/v1', apiWriteRouter);
  app.use('/api/v1', apiReadRouter);

  app.use(globalLimiter);

  // Branding is public - the sign-in page needs the theme and logo before
  // anyone is authenticated - and asked for on every page. Mounted ahead of
  // the session, so the theme, logo and favicon neither read the session
  // store (a database round trip on PostgreSQL) nor set a cookie, and keep
  // the cache headers they set themselves rather than noStore().
  app.use(brandingRouter);

  // Form bodies only. `extended: false` avoids qs entirely.
  app.use(
    express.urlencoded({
      extended: false,
      limit: '1mb',
      parameterLimit: 100,
    }),
  );

  app.use(noStore());
  app.use(warnOnInsecureConnection());
  app.use(sessionMiddleware());
  app.use(loadCurrentUser());
  app.use(enforceSessionLifetime());
  app.use(allowSignOutRedirect());
  app.use(sameSiteOnly(CROSS_SITE_ENDPOINTS));
  app.use(csrfProtection(CSRF_EXEMPT));
  app.use(themePreference());
  // After the session: the first rule for a language is what the reader
  // chose. Before anything that renders.
  app.use(language());
  app.use(viewLocals());
  // The Dashboard link in the header: technicians in a group, and managers.
  app.use(workDashboardLink());

  app.get('/', (req, res) => {
    // /home is the portal's home page when one has it, and My tickets
    // otherwise - so this lands where it always did unless a portal says so.
    res.redirect(req.currentUser ? '/home' : '/login');
  });

  // Mounted under a prefix each, so a router's blanket guards apply only to
  // its own URLs. Mounting them all at '/' would make the admin router's
  // requireRole('admin') run for every unmatched path in the application.
  // The sign-in page is drawn in the default portal (routes/portal.ts).
  app.use('/login', portalPresentation());
  app.use(authRouter);
  // The first administrator of a hosted helpdesk, from the portal's one-time link.
  app.use(adminSetupRouter);
  // The light/dark preference, available signed in or not.
  app.use(themeRouter);
  // Approval links: the one part of the application somebody reaches with
  // no account, by holding a token mailed to them. It shows one ticket and
  // offers one decision; see routes/approvals.ts.
  app.use('/approvals', approvalRouter);
  // Search in long dropdowns: adds its script only to a page that has one.
  app.use(selectSearch());
  // The requester portal dresses these three and nothing else; staff and
  // settings pages always keep the built-in look. See routes/portal.ts.
  app.use(['/home', '/tickets', '/profile'], portalPresentation());
  app.use('/home', homeRouter);
  // Custom images are public, like the logo: see routes/custom-images.ts.
  app.use('/images', publicImageRouter);
  app.use('/portal', portalRouter);
  app.use('/portal', portalScriptRouter);
  app.use('/profile', profileRouter);
  app.use('/tickets', ticketRouter);
  // One person, read only, for the service desk; see routes/people.ts.
  app.use('/people', peopleRouter);
  app.use('/inventory', assetsRouter);
  // The bar above every page: tickets, people and references in one.
  app.use('/search', searchRouter);
  app.use('/dashboard', workDashboardRouter);
  app.use('/reports', reportsRouter);
  app.use('/boards', boardsRouter);
  // Excel-like headers on the whole Settings lists (routes/column-lists.ts).
  app.use('/admin', columnLists(), adminRouter);

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
