import { Router, type Request, type Response } from 'express';
import { discover, redirectUri, signOutRedirectUri } from '../auth/oidc.js';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { contrastRatio, parseColour, toHex } from '../lib/color.js';
import { assertCsrfToken } from '../middleware/csrf.js';
import { writeLimiter } from '../middleware/security.js';
import { settingsView } from './settings-shared.js';
import { searchSettings } from '../services/settings-search.js';
import { languageAdminRouter, languageLocals } from './languages-admin.js';
import { userAdminRouter } from './users-admin.js';
import { groupAdminRouter } from './groups-admin.js';
import { userGroupAdminRouter } from './user-groups-admin.js';
import { mailAdminRouter } from './mail-admin.js';
import { templateAdminRouter } from './templates-admin.js';
import { auditRouter } from './audit-admin.js';
import { approvalPageAdminRouter, portalAdminRouter } from './portal-admin.js';
import { customImagesAdminRouter } from './custom-images.js';
import { advancedAdminRouter } from './advanced-admin.js';
import { dashboardsAdminRouter } from './dashboards-admin.js';
import { lastChangeLocal } from './last-change.js';
import { generateScimToken, revokeScimToken } from '../services/scim.js';
import { flash } from '../middleware/view-locals.js';
import { formatDateIn, formatDateTimeIn } from '../lib/format.js';
import { timeZoneOptions } from '../lib/time-zones.js';
import {
  DATE_FORMATS,
  type LocaleSettings,
  clearSecret,
  hasOidcClientSecret,
  hasProviderSecret,
  issuerOf,
  settingsDocument,
  settings,
  settingsProblems,
  updateSettings,
} from '../settings/index.js';
import {
  FAVICON_EXTENSIONS,
  LOGO_EXTENSIONS,
  MAX_BRANDING_BYTES,
  removeBrandingAsset,
  storeBrandingAsset,
  themeColours,
  modeColours,
  FONTS,
} from '../services/branding.js';

/**
 * Runtime configuration UI.
 *
 * Mounted inside the admin router, so it inherits requireAuth + requireRole
 * ('admin'). One page per concern rather than one long form, and each page
 * validates its own change before storing it: a change that would make
 * sign-in impossible is refused with an explanation rather than saved and
 * discovered at the next login.
 */
export const settingsRouter = Router();

// --- input helpers ---------------------------------------------------------

function parseList(value: unknown, limit = 200): string[] {
  if (typeof value !== 'string') return [];
  const parts = value
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 500);
  return Array.from(new Set(parts)).slice(0, limit);
}

function parseScopes(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const parts = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(parts)).slice(0, 50);
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const checkbox = (value: unknown): boolean => value === 'on' || value === 'true' || value === '1';

/** The current state of everything the validator looks at. */
function currentCandidate() {
  const current = settings();
  return {
    oidc: {
      tenantId: current.oidc.tenantId,
      clientId: current.oidc.clientId,
      hasSecret: hasOidcClientSecret(),
    },
    scim: { enabled: current.scim.enabled, configured: current.scim.configured },
    provisioning: { jitEnabled: current.provisioning.jitEnabled },
  };
}

function render(
  res: Response,
  section: string,
  extra: Record<string, unknown> = {},
  status?: number,
): void {
  if (status) res.status(status);
  // Authentication and Provisioning are tabs of the Entra ID integration now,
  // so they highlight Integrations in the sidebar.
  const owner = section === 'authentication' || section === 'provisioning' ? 'integrations' : section;
  res.render('admin/settings/' + section, settingsView(owner, extra));
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

const authenticationView = (extra: Record<string, unknown> = {}) => ({
  hasClientSecret: hasOidcClientSecret(),
  ...extra,
});

// "Last changed ... by ..." for the page about to render, from the audit
// trail. Before every router below, so each page gets its own.
settingsRouter.use(lastChangeLocal());

// Opening any settings page ends a full-screen portal preview. Left on, it
// quietly kept drawing /tickets in the previewed portal for the rest of the
// session - reported as "/tickets takes me to the editor".
settingsRouter.use((req: Request, _res: Response, next) => {
  if (req.method === 'GET' && req.session.portalPreview) delete req.session.portalPreview;
  next();
});

// Sections that are whole features of their own.
settingsRouter.use('/users', userAdminRouter);
// **Before** the technician router: that one owns '/groups/:id', which
// would otherwise swallow '/groups/users' and report that a group with the id
// "users" does not exist.
// Before '/mail', whose router would otherwise see 'approval' first.
settingsRouter.use('/mail/approval', approvalPageAdminRouter);
settingsRouter.use('/mail', mailAdminRouter);
settingsRouter.use('/groups/users', userGroupAdminRouter);
settingsRouter.use('/groups', groupAdminRouter);
settingsRouter.use('/templates', templateAdminRouter);
settingsRouter.use('/audit', auditRouter);
settingsRouter.use('/customization/portal', portalAdminRouter);
settingsRouter.use('/customization/images', customImagesAdminRouter);
settingsRouter.use('/advanced', advancedAdminRouter);
settingsRouter.use('/dashboards', dashboardsAdminRouter);

// Attachments moved under Customisation. The whole subtree, with a 308 so a
// form still posting to the old URL keeps its method and body (trap 7).
settingsRouter.use('/attachments', (req: Request, res: Response) => {
  const rest = req.path === '/' ? '' : req.path;
  const at = req.originalUrl.indexOf('?');
  res.redirect(
    308,
    '/admin/settings/customization/attachments' + rest + (at >= 0 ? req.originalUrl.slice(at) : ''),
  );
});

settingsRouter.get('/', (_req: Request, res: Response) => {
  res.redirect('/admin/settings/integrations');
});

/** The search bar above the sections: a GET, so a result list is an address. */
settingsRouter.get('/search', (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  res.render('admin/settings/search', settingsView('search', { title: 'Settings - Search', sectionTitle: 'Search', q, hits: q ? searchSettings(q) : [] }));
});

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/**
 * One tile per directory or service this desk connects to. Entra ID is the
 * only one; it opens on its two settings, Authentication and Provisioning.
 */
settingsRouter.get('/integrations', (_req: Request, res: Response) => {
  const current = settings();
  render(res, 'integrations', {
    entra: {
      signIn: current.ssoConfigured,
      provisioning: current.scim.enabled || current.provisioning.jitEnabled,
    },
    google: { signIn: current.google.configured },
    okta: { signIn: current.okta.configured },
    generic: { signIn: current.genericOidc.configured, name: settingsDocument().genericOidc.name },
  });
});

// ---------------------------------------------------------------------------
// Integrations - Google and Okta
// ---------------------------------------------------------------------------

/** One hostname: letters, digits, dots and dashes, with a dot in it. */
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** "https://acme.okta.com/" -> "acme.okta.com". */
function bareHost(value: string): string {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

function renderProvider(
  res: Response,
  provider: 'google' | 'okta' | 'generic',
  extra: { problems?: string[]; values?: Record<string, string> } = {},
  status?: number,
): void {
  if (status) res.status(status);
  const current = settings();
  res.render(
    'admin/settings/integration-' + provider,
    settingsView('integrations', {
      problems: extra.problems ?? [],
      values: extra.values ?? {},
      redirectUri: redirectUri(),
      signOutRedirectUri: signOutRedirectUri(),
      hasSecret: hasProviderSecret(provider === 'generic' ? 'genericOidc' : provider),
      configured: current[provider === 'generic' ? 'genericOidc' : provider].configured,
      google: settingsDocument().google,
      okta: settingsDocument().okta,
      generic: settingsDocument().genericOidc,
    }),
  );
}

settingsRouter.get('/integrations/google', (_req: Request, res: Response) => {
  renderProvider(res, 'google');
});

settingsRouter.post(
  '/integrations/google',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = text(body.clientId);
    const clientSecret = text(body.clientSecret);
    const allowedDomains = parseList(body.allowedDomains, 50).map((d) => bareHost(d));

    const problems: string[] = [];
    if (clientId && clientId.length > 300) problems.push('The client ID is too long.');
    const badDomain = allowedDomains.find((d) => !HOSTNAME.test(d));
    if (badDomain) problems.push('"' + badDomain + '" is not a domain name, e.g. example.com.');
    if (clientId && allowedDomains.length === 0) {
      problems.push(
        'Enter at least one Google Workspace domain. Without it, any Google account could sign in.',
      );
    }
    if (problems.length > 0) {
      renderProvider(res, 'google', { problems, values: { clientId, allowedDomains: allowedDomains.join('\n') } }, 400);
      return;
    }

    await updateSettings(
      { google: { clientId, allowedDomains, ...(clientSecret ? { clientSecret } : {}) } },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.google.changed',
      targetType: 'settings',
      detail: { clientId, allowedDomains, secretChanged: clientSecret !== '' },
    });
    flash(req, 'success', settings().google.configured ? 'Google sign-in saved and available.' : 'Google settings saved.');
    res.redirect('/admin/settings/integrations/google');
  }),
);

settingsRouter.get('/integrations/okta', (_req: Request, res: Response) => {
  renderProvider(res, 'okta');
});

settingsRouter.post(
  '/integrations/okta',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const domain = bareHost(text(body.domain));
    const authServer = text(body.authServer);
    const clientId = text(body.clientId);
    const clientSecret = text(body.clientSecret);

    const problems: string[] = [];
    if (domain && !HOSTNAME.test(domain)) problems.push('The Okta domain must be a host name, e.g. example.okta.com.');
    if (!/^[A-Za-z0-9_-]{0,64}$/.test(authServer)) {
      problems.push('The authorisation server ID may contain only letters, digits, dashes and underscores.');
    }
    if (clientId && clientId.length > 300) problems.push('The client ID is too long.');
    if (problems.length > 0) {
      renderProvider(res, 'okta', { problems, values: { domain, authServer, clientId } }, 400);
      return;
    }

    await updateSettings(
      { okta: { domain, authServer, clientId, ...(clientSecret ? { clientSecret } : {}) } },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.okta.changed',
      targetType: 'settings',
      detail: { domain, authServer, clientId, secretChanged: clientSecret !== '' },
    });
    flash(req, 'success', settings().okta.configured ? 'Okta sign-in saved and available.' : 'Okta settings saved.');
    res.redirect('/admin/settings/integrations/okta');
  }),
);

settingsRouter.get('/integrations/openid', (_req: Request, res: Response) => {
  renderProvider(res, 'generic');
});

settingsRouter.post(
  '/integrations/openid',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = text(body.name).replace(/\s+/g, ' ').slice(0, 60);
    const issuer = issuerOf(text(body.issuer));
    const clientId = text(body.clientId);
    const clientSecret = text(body.clientSecret);
    const scopes = text(body.scopes).split(/[\s,]+/).filter(Boolean).join(' ') || 'openid profile email';
    const allowedDomains = parseList(body.allowedDomains, 50).map((d) => bareHost(d));

    const problems: string[] = [];
    if (issuer) {
      let url: URL | null = null;
      try {
        url = new URL(issuer);
      } catch {
        url = null;
      }
      if (!url || url.protocol !== 'https:' || url.search || url.hash) {
        problems.push('The issuer must be an https address with no query, e.g. https://id.example.com/realms/staff.');
      }
    }
    if (clientId.length > 300) problems.push('The client ID is too long.');
    if (!/^[A-Za-z0-9_:./-]+( [A-Za-z0-9_:./-]+)*$/.test(scopes)) problems.push('Scopes are words separated by spaces, e.g. openid profile email.');
    const badDomain = allowedDomains.find((d) => !HOSTNAME.test(d));
    if (badDomain) problems.push('"' + badDomain + '" is not a domain name, e.g. example.com.');
    if (problems.length > 0) {
      renderProvider(res, 'generic', { problems, values: { name, issuer, clientId, scopes, allowedDomains: allowedDomains.join('\n') } }, 400);
      return;
    }

    await updateSettings(
      { genericOidc: { name, issuer, clientId, scopes, allowedDomains, ...(clientSecret ? { clientSecret } : {}) } },
      req.currentUser?.id ?? null,
    );
    auditRequest(req, {
      action: 'settings.generic_oidc.changed',
      targetType: 'settings',
      detail: { name, issuer, clientId, scopes, allowedDomains, secretChanged: clientSecret !== '' },
    });
    // Saved either way; but a provider that cannot be read is said here,
    // where it can be fixed, rather than as a failed sign-in later.
    let unreadable = '';
    if (settings().genericOidc.configured) {
      try {
        await discover('generic');
      } catch (err) {
        unreadable = (err as Error).message;
      }
    }
    if (unreadable) {
      flash(req, 'error', 'Saved, but sign-in will not work yet: the provider\'s discovery document at ' + settings().genericOidc.discoveryUrl + ' could not be used (' + unreadable + '). Check the issuer.');
    } else {
      flash(req, 'success', settings().genericOidc.configured ? 'OpenID Connect sign-in saved and available.' : 'OpenID Connect settings saved.');
    }
    res.redirect('/admin/settings/integrations/openid');
  }),
);

settingsRouter.post(
  '/integrations/:provider/secret/clear',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const provider =
      req.params.provider === 'okta' ? 'okta'
        : req.params.provider === 'google' ? 'google'
          : req.params.provider === 'openid' ? 'openid'
            : null;
    if (!provider) throw notFound('No such integration.');
    await clearSecret(
      provider === 'okta' ? 'oktaClientSecret' : provider === 'openid' ? 'genericClientSecret' : 'googleClientSecret',
      req.currentUser?.id ?? null,
    );
    auditRequest(req, { action: 'settings.' + provider + '.secret.cleared', targetType: 'settings' });
    flash(req, 'success', 'Client secret removed. Sign-in with this provider is off until a new one is saved.');
    res.redirect('/admin/settings/integrations/' + provider);
  }),
);

settingsRouter.get('/integrations/entra', (_req: Request, res: Response) => {
  res.redirect('/admin/settings/integrations/entra/authentication');
});

// The two pages that used to be sections of their own. Whole subtrees, 308,
// as for every other move (trap 7).
for (const [from, to] of [
  ['/authentication', '/admin/settings/integrations/entra/authentication'],
  ['/provisioning', '/admin/settings/integrations/entra/provisioning'],
] as const) {
  settingsRouter.use(from, (req: Request, res: Response) => {
    const rest = req.path === '/' ? '' : req.path;
    const at = req.originalUrl.indexOf('?');
    res.redirect(308, to + rest + (at >= 0 ? req.originalUrl.slice(at) : ''));
  });
}

settingsRouter.get('/integrations/entra/authentication', (_req: Request, res: Response) => {
  render(res, 'authentication', authenticationView());
});

settingsRouter.post(
  '/oidc',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const newSecret = text(body.clientSecret);

    const candidate = {
      ...currentCandidate(),
      authMode: 'oidc' as const,
      oidc: {
        tenantId: text(body.tenantId),
        clientId: text(body.clientId),
        hasSecret: newSecret !== '' || hasOidcClientSecret(),
      },
    };

    const problems = settingsProblems(candidate);
    if (problems.length > 0) {
      render(res, 'authentication', authenticationView({ problems }), 400);
      return;
    }

    await updateSettings(
      {
        oidc: {
          tenantId: candidate.oidc.tenantId,
          clientId: candidate.oidc.clientId,
          scopes: parseScopes(body.scopes),
          extraIssuers: parseList(body.extraIssuers),
          ...(newSecret !== '' ? { clientSecret: newSecret } : {}),
        },
      },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.oidc.changed',
      targetType: 'settings',
      detail: {
        tenantId: candidate.oidc.tenantId,
        clientId: candidate.oidc.clientId,
        // Never record the secret itself, only that it changed.
        clientSecretReplaced: newSecret !== '',
      },
    });

    flash(req, 'success', 'OpenID Connect settings saved and applied.');
    res.redirect('/admin/settings/integrations/entra/authentication');
  }),
);

settingsRouter.post(
  '/secret/:which/clear',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const which = z.enum(['oidcClientSecret']).safeParse(req.params.which);
    if (!which.success) throw notFound('No such secret.');

    await clearSecret(which.data, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.secret.cleared',
      targetType: 'settings',
      detail: { secret: which.data },
    });
    flash(req, 'success', 'Stored secret removed.');
    res.redirect('/admin/settings/integrations/entra/authentication');
  }),
);

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

const provisioningView = (extra: Record<string, unknown> = {}) => ({
  scim: settings().scim,
  // Shown once, immediately after generation, and never again.
  issuedToken: null as string | null,
  ...extra,
});

settingsRouter.get('/integrations/entra/provisioning', (_req: Request, res: Response) => {
  render(res, 'provisioning', provisioningView());
});

settingsRouter.post(
  '/integrations/entra/provisioning',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const jitEnabled = checkbox(body.jitEnabled);
    const scimEnabled = checkbox(body.scimEnabled);

    const problems = settingsProblems({
      ...currentCandidate(),
      provisioning: { jitEnabled },
      scim: { enabled: scimEnabled, configured: settings().scim.configured },
    });
    if (problems.length > 0) {
      render(res, 'provisioning', provisioningView({ problems }), 400);
      return;
    }

    await updateSettings(
      {
        provisioning: { jitEnabled },
        scim: { enabled: scimEnabled, disableOnDelete: checkbox(body.disableOnDelete) },
      },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.provisioning.changed',
      targetType: 'settings',
      detail: { jitEnabled, scimEnabled },
    });

    flash(req, 'success', 'Provisioning settings saved. They apply from the next sign-in.');
    res.redirect('/admin/settings/integrations/entra/provisioning');
  }),
);

/**
 * Issues a SCIM bearer token and shows it exactly once.
 *
 * Rendered rather than redirected, because a redirect would put the token
 * in a flash message and therefore in the session store. This way it exists
 * in one response and nowhere else.
 */
settingsRouter.post(
  '/scim/token',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const token = await generateScimToken(req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.scim.token.generated',
      targetType: 'settings',
    });
    render(res, 'provisioning', provisioningView({ issuedToken: token }));
  }),
);

settingsRouter.post(
  '/scim/token/revoke',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await revokeScimToken(req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.scim.token.revoked',
      targetType: 'settings',
    });
    flash(
      req,
      'success',
      'The SCIM token was revoked and provisioning switched off. Entra will start reporting failures until a new token is set there.',
    );
    res.redirect('/admin/settings/integrations/entra/provisioning');
  }),
);
// ---------------------------------------------------------------------------
// Customisation
// ---------------------------------------------------------------------------

function customizationView(extra: Record<string, unknown> = {}) {
  const branding = settings().branding;
  return {
    quickColours: QUICK_COLOURS,
    colours: themeColours(),
    modes: modeColours(),
    colourModes: branding.colourModes ?? 'both',
    defaultMode: branding.defaultMode ?? 'light',
    logoExtensions: LOGO_EXTENSIONS.join(','),
    faviconExtensions: FAVICON_EXTENSIONS.join(','),
    maxBrandingKb: Math.round(MAX_BRANDING_BYTES / 1024),
    fonts: FONTS,
    hasLogo: branding.logo !== null,
    hasFavicon: branding.favicon !== null,
    ...extra,
  };
}

settingsRouter.get('/customization', (_req: Request, res: Response) => {
  render(res, 'customization', customizationView());
});

settingsRouter.post(
  '/customization',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const appName = text(body.appName).slice(0, 60);

    // Each colour has two inputs: a native picker, which always submits a
    // valid hex, and an optional text box for a typed hex or RGB value. The
    // typed value wins when it is filled in, so either way of working is
    // possible without any client-side JavaScript.
    const brandInput = text(body.brandColourTyped) || text(body.brandColour);
    const inkInput = text(body.inkColourTyped) || text(body.inkColour);
    const brand = parseColour(brandInput);
    const ink = parseColour(inkInput);

    // The font has its own form now; a colour save leaves it alone.
    const font = settingsDocument().branding.font ?? 'system';
    const problems: string[] = [];
    if (appName.length === 0) problems.push('Enter an application name.');

    if (!brand) problems.push('The brand colour is not a valid hex or RGB value.');
    if (!ink) problems.push('The text colour is not a valid hex or RGB value.');
    // It is the colour of every word on a white page: a light one hides them.
    else if (contrastRatio(ink, { r: 255, g: 255, b: 255 }) < 4.5) {
      problems.push('The text colour is too light: text drawn in it cannot be read on white. Choose a dark colour, such as the default ' + '#16181d' + '.');
    }
    // Light and dark mode: which are offered, and each one's own colours when
    // "Use my own colours" is ticked (empty otherwise: worked out).
    const colourModes = (['both', 'light', 'dark'] as const).find((m) => m === text(body.colourModes)) ?? 'both';
    const defaultMode =
      (['system', 'light', 'dark'] as const).find((m) => m === text(body.defaultMode)) ??
      settings().branding.defaultMode ??
      'light';
    const palette = (mode: 'light' | 'dark') => {
      if (body[mode + 'Own'] !== 'on') return { background: '', surface: '', text: '' };
      const read = (name: string, label: string) => {
        const c = parseColour(text(body[mode + name]));
        if (!c) problems.push('The ' + mode + ' mode ' + label + ' is not a valid colour.');
        return c;
      };
      const bg = read('Background', 'background'), surface = read('Surface', 'card colour'), fg = read('Text', 'text colour');
      if (surface && fg && contrastRatio(surface, fg) < 4.5) {
        problems.push('In ' + mode + ' mode the text colour does not stand out from the card colour: choose a ' + (mode === 'light' ? 'darker text or a lighter card' : 'lighter text or a darker card') + '.');
      }
      return { background: bg ? toHex(bg) : '', surface: surface ? toHex(surface) : '', text: fg ? toHex(fg) : '' };
    };
    const light = palette('light');
    const dark = palette('dark');

    if (problems.length > 0 || !brand || !ink) {
      render(res, 'customization', customizationView({ problems }), 400);
      return;
    }

    await updateSettings(
      {
        branding: {
          appName,
          // Stored normalised, so nothing typed reaches the stylesheet verbatim.
          brandColour: toHex(brand),
          inkColour: toHex(ink),
          font: font || 'system',
          colourModes,
          defaultMode,
          light,
          dark,
        },
      },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.branding.changed',
      targetType: 'settings',
      detail: { appName, brandColour: toHex(brand), inkColour: toHex(ink), font: font || 'system', colourModes, light, dark },
    });

    flash(req, 'success', 'Appearance saved.');
    res.redirect('/admin/settings/customization');
  }),
);

/**
 * The quick colours on Appearance: one click sets the brand colour and
 * nothing else. The same validation as the full form - a preset is a value
 * like any other once it is posted.
 */
export const QUICK_COLOURS = [
  { hex: '#1a5d74', label: 'Petrol' },
  { hex: '#2f6b4f', label: 'Forest' },
  { hex: '#8a5a12', label: 'Ochre' },
  { hex: '#5b4a8c', label: 'Plum' },
] as const;

/**
 * The font, on its own.
 *
 * It used to be a field of the colour form, which meant a helpdesk whose
 * stored text colour the policy now refuses could not change its font
 * either: the save checked everything and refused everything. Reported
 * 15 Oct 2026. Nothing here touches a colour.
 */
settingsRouter.post(
  '/customization/font',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const font = text((req.body as Record<string, unknown>)?.font);
    if (!font || !FONTS.some((f) => f.key === font)) {
      render(res, 'customization', customizationView({ problems: ['Choose one of the fonts listed.'] }), 400);
      return;
    }

    await updateSettings({ branding: { font } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.branding.changed', targetType: 'settings', detail: { font } });
    flash(req, 'success', 'Font changed.');
    res.redirect('/admin/settings/customization');
  }),
);

settingsRouter.post(
  '/customization/colour',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const brand = parseColour(text((req.body as Record<string, unknown>)?.brandColour));
    if (!brand) {
      render(res, 'customization', customizationView({ problems: ['That is not a colour.'] }), 400);
      return;
    }
    await updateSettings({ branding: { brandColour: toHex(brand) } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.branding.changed', targetType: 'settings', detail: { brandColour: toHex(brand) } });
    flash(req, 'success', 'Colour changed.');
    res.redirect('/admin/settings/customization');
  }),
);

/** Logo and favicon uploads. Memory storage, so bytes are verified first. */
function brandingUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BRANDING_BYTES, files: 1, fields: 5, parts: 8 },
  }).single('image');
}

settingsRouter.post(
  '/customization/:kind/upload',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const kind = z.enum(['logo', 'favicon']).safeParse(req.params.kind);
    if (!kind.success) throw notFound('No such image.');

    await new Promise<void>((resolve, reject) => {
      brandingUpload()(req, res, (err: unknown) => {
        if (!err) {
          resolve();
          return;
        }
        if (err instanceof multer.MulterError) {
          reject(
            badRequest(
              err.code === 'LIMIT_FILE_SIZE'
                ? 'Images must be ' + Math.round(MAX_BRANDING_BYTES / 1024) + ' KB or smaller.'
                : 'The upload could not be read.',
              'upload_rejected',
            ),
          );
          return;
        }
        reject(err);
      });
    });

    // The global CSRF middleware runs before any multipart parser, so the
    // token is checked here instead, once the body exists.
    assertCsrfToken(req);

    const file = req.file;
    if (!file) {
      render(
        res,
        'customization',
        customizationView({ problems: ['Choose an image to upload.'] }),
        400,
      );
      return;
    }

    const stored = storeBrandingAsset(kind.data, file.originalname, file.buffer);
    const previous = settings().branding[kind.data];

    await updateSettings({ branding: { [kind.data]: stored } }, req.currentUser?.id ?? null);
    if (previous) await removeBrandingAsset(previous);

    auditRequest(req, {
      action: 'settings.branding.' + kind.data + '.uploaded',
      targetType: 'settings',
      detail: {
        originalName: stored.originalName,
        contentType: stored.contentType,
        bytes: stored.byteSize,
        sha256: stored.sha256,
      },
    });

    flash(req, 'success', kind.data === 'logo' ? 'Logo updated.' : 'Favicon updated.');
    res.redirect('/admin/settings/customization');
  }),
);

settingsRouter.post(
  '/customization/:kind/remove',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const kind = z.enum(['logo', 'favicon']).safeParse(req.params.kind);
    if (!kind.success) throw notFound('No such image.');

    const existing = settings().branding[kind.data];
    if (existing) {
      await updateSettings({ branding: { [kind.data]: null } }, req.currentUser?.id ?? null);
      await removeBrandingAsset(existing);
      auditRequest(req, {
        action: 'settings.branding.' + kind.data + '.removed',
        targetType: 'settings',
      });
    }

    flash(
      req,
      'success',
      kind.data === 'logo'
        ? 'Logo removed. The application name is shown instead.'
        : 'Favicon removed. A plain square in the brand colour is used instead.',
    );
    res.redirect('/admin/settings/customization');
  }),
);

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

// Adding, translating and scoping a language. Mounted under the same path as
// the page it draws on.
settingsRouter.use('/customization/locale', languageAdminRouter);

/**
 * The locale page: the clock, the date, and the languages.
 *
 * One page about how the service desk reads, rather than two. `language`
 * is everything the languages card needs; languages-admin.ts calls this
 * when it has to re-render a refused form beside its own control (trap 6).
 */
async function renderLocale(
  res: Response,
  problems: string[] = [],
  status?: number,
  typed?: Partial<LocaleSettings>,
  language: { errors?: Record<string, string>; openDialog?: string | null; typed?: Record<string, string> } = {},
): Promise<void> {
  if (status) res.status(status);
  const current = { ...settings().locale, ...typed };
  const sample = new Date();
  res.render(
    'admin/settings/locale',
    settingsView('customization', {
      problems,
      locale: current,
      ...(await languageLocals(language)),
      timeZones: timeZoneOptions(current.timeZone),
      // Each format shown as it would print now, so the choice is concrete.
      dateFormats: DATE_FORMATS.map((f) => ({
        value: f,
        example: formatDateIn(sample, { ...current, dateFormat: f }),
      })),
      timeExamples: {
        '24h': formatDateTimeIn(sample, { ...current, timeFormat: '24h' }),
        '12h': formatDateTimeIn(sample, { ...current, timeFormat: '12h' }),
      },
    }),
  );
}

/**
 * Exported for languages-admin.ts, which imports it **dynamically**: this
 * file mounts that router, and a static import the other way would be a
 * circular import - in ESM a crash at start-up, not a warning (trap 4).
 */
export function renderLocaleWith(
  _req: Request,
  res: Response,
  language: { errors?: Record<string, string>; openDialog?: string | null; typed?: Record<string, string> },
  status?: number,
): Promise<void> {
  return renderLocale(res, [], status, undefined, language);
}

settingsRouter.get(
  '/customization/locale',
  asyncHandler(async (_req: Request, res: Response) => {
    await renderLocale(res);
  }),
);

settingsRouter.post(
  '/customization/locale',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const timeZone = text(body.timeZone);
    const dateFormat = text(body.dateFormat);
    const timeFormat = text(body.timeFormat);

    const problems: string[] = [];
    if (!timeZoneOptions(settings().locale.timeZone).some((z) => z.value === timeZone)) {
      problems.push('Choose a time zone from the list.');
    }
    if (!(DATE_FORMATS as readonly string[]).includes(dateFormat)) problems.push('Choose a date format.');
    if (timeFormat !== '24h' && timeFormat !== '12h') problems.push('Choose a 24-hour or 12-hour clock.');
    if (problems.length > 0) {
      await renderLocale(res, problems, 400);
      return;
    }

    const locale = {
      timeZone,
      dateFormat: dateFormat as LocaleSettings['dateFormat'],
      timeFormat: timeFormat as LocaleSettings['timeFormat'],
      // Whether a reader with no language of their own, and no group or
      // domain that names one, is served what their browser asks for.
      followBrowser: text(body.followBrowser) === 'on',
    };
    await updateSettings({ locale }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.locale.changed', targetType: 'settings', detail: locale });
    flash(req, 'success', 'Locale saved. Dates everywhere, and SLA business hours, now use it.');
    res.redirect('/admin/settings/customization/locale');
  }),
);

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

// A tab of Customisation now, not a section of its own. The page keeps its
// view; only the sidebar entry it highlights and the URL moved.
function renderAttachments(res: Response, problems: string[] = [], status?: number): void {
  if (status) res.status(status);
  res.render(
    'admin/settings/attachments',
    settingsView('customization', {
      problems,
      attachmentMaxMegabytes: (settings().attachments.maxBytes / (1024 * 1024)).toFixed(1),
    }),
  );
}

settingsRouter.get('/customization/attachments', (_req: Request, res: Response) => {
  renderAttachments(res);
});

settingsRouter.post(
  '/customization/attachments',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Refused on the page rather than thrown: a thrown 400 is a standalone
    // error page, and the administrator would lose what they typed.
    const maxMb = z.coerce.number().min(0.1).max(100).safeParse(body.maxMegabytes);
    const maxPerTicket = z.coerce.number().int().min(1).max(200).safeParse(body.maxPerTicket);
    const problems: string[] = [];
    if (!maxMb.success) problems.push('The maximum file size must be between 0.1 and 100 MB.');
    if (!maxPerTicket.success) problems.push('The per-ticket limit must be between 1 and 200.');
    if (!maxMb.success || !maxPerTicket.success) {
      renderAttachments(res, problems, 400);
      return;
    }

    const enabled = checkbox(body.enabled);
    await updateSettings(
      {
        attachments: {
          enabled,
          maxBytes: Math.round(maxMb.data * 1024 * 1024),
          maxPerTicket: maxPerTicket.data,
        },
      },
      req.currentUser?.id ?? null,
    );

    auditRequest(req, {
      action: 'settings.attachments.changed',
      targetType: 'settings',
      detail: { enabled, maxMegabytes: maxMb.data, maxPerTicket: maxPerTicket.data },
    });

    flash(req, 'success', 'Attachment settings saved.');
    res.redirect('/admin/settings/customization/attachments');
  }),
);
