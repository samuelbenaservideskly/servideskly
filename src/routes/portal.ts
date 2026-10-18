import { Router, type Request, type RequestHandler, type Response } from 'express';
import { dashboardsForPortal } from '../services/dashboards.js';
import { asyncHandler } from '../lib/async-handler.js';
import { logger } from '../lib/logger.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { allowFramingBySelf, allowPortalScripts } from '../middleware/security.js';
import { settings } from '../settings/index.js';
import { brandingVersion } from '../services/branding.js';
import { listActiveTemplates } from '../services/templates.js';
import { ticketByApprovalToken } from '../services/tickets.js';
import { findUserById } from '../services/users.js';
import {
  STANDARD_PORTAL,
  portalRunsScript,
  composePortal,
  defaultPortal,
  findPortal,
  portalForUser,
  hasHomePage,
  portalVersion,
  usesTemplates,
  type PortalPage,
  type PortalRow,
} from '../services/portal.js';

const log = logger.child({ module: 'routes/portal' });

/**
 * Which page of the portal a request is, from where it is going.
 *
 * A POST to /tickets is raising a ticket, so a refusal re-rendering the form
 * is the New ticket page; anything below a ticket's id is that ticket.
 */
function pageFor(req: Request): PortalPage {
  const path = req.baseUrl + req.path;
  if (path.startsWith('/login/password')) return 'login_password';
  if (path.startsWith('/login/code')) return 'login_code';
  if (path.startsWith('/login')) return 'login';
  if (path.startsWith('/home')) return 'home';
  if (path.startsWith('/profile')) return 'profile';
  if (path === '/tickets/new' || (path === '/tickets' && req.method === 'POST')) return 'new';
  if (path === '/tickets' || path === '/tickets/') return 'tickets';
  return 'ticket';
}

const PAGE_TITLES: Record<PortalPage, string> = {
  home: 'Home',
  tickets: 'My tickets',
  new: 'New ticket',
  ticket: 'Ticket',
  profile: 'Profile',
  login: 'Sign in',
  login_password: 'Enter your password',
  login_code: 'Enter your code',
};

/**
 * Decides which portal this response is drawn in, and composes it.
 *
 * - A requester sees the portal assigned to one of their user groups, or
 *   else the default one, which may be the built-in one.
 * - Staff always see the built-in one: the portal is the requester's view of
 *   the service desk, and a technician working a queue needs the real one.
 * - An administrator sees another portal only when they asked to: in the
 *   editor's frame (`?portalFrame=<id>`), or in a full-screen preview held in
 *   their session, with a banner saying so on every page.
 *
 * A portal that cannot be composed falls back to the built-in look. A broken
 * design must not stop anybody raising a ticket.
 */
export function portalPresentation(): RequestHandler {
  return (req, res, next) => {
    res.locals.portal = null;
    res.locals.portalFrame = false;
    res.locals.portalPreview = null;

    const user = req.currentUser;
    const onLogin = (req.baseUrl + req.path).startsWith('/login');
    // Signed out, only the sign-in page is dressed; everything else redirects
    // to it anyway.
    if (!user && !onLogin) {
      next();
      return;
    }

    void (async () => {
      let portal: PortalRow | undefined;
      const frame = typeof req.query.portalFrame === 'string' ? req.query.portalFrame : '';

      if (!user) {
        // The sign-in page: the default portal, for everybody.
        portal = await defaultPortal('requester');
      } else if (user.role === 'admin' && frame) {
        // The editor's split view. Framed by our own settings page only.
        allowFramingBySelf(res);
        res.locals.portalFrame = true;
        if (req.query.source === '1') renderAsSource(req, res);
        portal = frame === STANDARD_PORTAL ? undefined : await requesterPortal(frame);
      } else if (user.role === 'admin' && req.session.portalPreview) {
        const id = req.session.portalPreview;
        portal = id === STANDARD_PORTAL ? undefined : await requesterPortal(id);
        if (id !== STANDARD_PORTAL && !portal) {
          // Deleted while being previewed: nothing left to show.
          delete req.session.portalPreview;
        } else {
          res.locals.portalPreview = {
            id,
            name: portal ? portal.name : 'Standard',
            editUrl: portal ? '/admin/settings/customization/portal/' + portal.id : null,
            exitAction: '/admin/settings/customization/portal/preview/exit',
          };
        }
      } else if (user.role === 'user') {
        portal = await portalForUser(user.id);
      }

      if (!portal) return;

      const page = pageFor(req);
      const branding = settings().branding;
      const templates = usesTemplates(portal)
        ? new Map((await listActiveTemplates()).map((t) => [t.id, t.name]))
        : new Map<string, string>();

      const sources = [portal.layout_html, ...Object.values(portal.pages)];
      const dashboards = sources.some((s) => s.includes('{{dashboard') || /\{\{\s*dashboard/.test(s))
        ? await dashboardsForPortal(sources, user ?? null)
        : new Map<string, string>();

      /*
       * A sign-in page has nobody signed in - whoever is looking at it.
       *
       * In the editor's frame an administrator *is* signed in, so the layout
       * filled {{user_name}}, {{nav}} and {{button_sign_out}} with their own
       * account and drew a Sign out button on the page that asks for a
       * password (reported 16 Oct 2026). The preview has to be what a
       * requester gets, and for a requester there is nobody yet.
       */
      const signInPage = page === 'login' || page === 'login_password' || page === 'login_code';

      const { head, foot } = composePortal(portal, page, {
        dashboards,
        appName: branding.appName,
        logoUrl: branding.logo ? '/branding/logo?v=' + brandingVersion() : null,
        userName: signInPage ? '' : user?.display_name ?? '',
        userEmail: signInPage ? '' : user?.email ?? '',
        signedIn: Boolean(user) && !signInPage,
        pageTitle: PAGE_TITLES[page],
        currentPath: req.baseUrl + req.path,
        csrfToken: String(res.locals.csrfToken ?? ''),
        templates,
      });

      res.locals.portal = {
        id: portal.id,
        head,
        foot,
        hasHome: hasHomePage(portal),
        stylesheet: '/portal/' + portal.id + '/theme.css?v=' + portalVersion(portal),
        script: null as string | null,
      };

      // The portal's own script: only for a signed-in person, never on the
      // sign-in page (passwords are typed there) and never in the editor's
      // frame (a picture, sandboxed). Settings - Advanced - JavaScript.
      if (user && !onLogin && !res.locals.portalFrame && portalRunsScript(portal)) {
        allowPortalScripts(res, settings().portalScripts.allowedOrigins);
        res.locals.portal.script = '/portal/' + portal.id + '/script.js?v=' + portalVersion(portal);
      }
    })()
      .catch((err: unknown) => {
        log.error({ err }, 'requester portal could not be composed; using the standard look');
        res.locals.portal = null;
      })
      .finally(() => next());
  };
}

/**
 * Turns this response into its own markup, as plain text: the editor's HTML
 * view. Only ever for an administrator's framed preview. Whatever the route
 * renders is sent as text instead of being drawn.
 */
export function renderAsSource(req: Request, res: Response): void {
  const render = res.render.bind(res);
  (res as { render: unknown }).render = (view: string, options?: object) => {
    render(view, options ?? {}, (err: Error | null, html?: string) => {
      if (err) {
        req.next?.(err);
        return;
      }
      res.type('text/plain; charset=utf-8').send(html ?? '');
    });
  };
}

/** A requester portal by id; an approval page is not one. */
async function requesterPortal(id: string): Promise<PortalRow | undefined> {
  const portal = await findPortal(id);
  return portal?.kind === 'requester' ? portal : undefined;
}

/** The request an approval page is about, for its variables. */
export interface ApprovalTicket {
  reference: string;
  title: string;
  requesterName: string;
  approverEmail: string;
}

/**
 * res.locals.portal for an approval page drawn in `portal`. Shared by the
 * real page and the administrator's sample, so the two cannot drift.
 */
export function composeApprovalLocals(
  req: Request,
  res: Response,
  portal: PortalRow,
  ticket: ApprovalTicket,
): void {
  const user = req.currentUser;
  const branding = settings().branding;
  const { head, foot } = composePortal(portal, 'home', {
    appName: branding.appName,
    logoUrl: branding.logo ? '/branding/logo?v=' + brandingVersion() : null,
    userName: user?.display_name ?? '',
    userEmail: user?.email ?? '',
    pageTitle: 'Approval',
    currentPath: req.baseUrl + req.path,
    csrfToken: String(res.locals.csrfToken ?? ''),
    templates: new Map(),
    ticket,
  });
  res.locals.portal = {
    id: portal.id,
    head,
    foot,
    hasHome: false,
    stylesheet: '/portal/' + portal.id + '/theme.css?v=' + portalVersion(portal),
  };
}

/**
 * The approval page's design: the default approval page, for whoever opens
 * it - an approver can be anybody, so there is no per-role rule here. Like
 * the portal, a design that cannot be composed falls back to the standard.
 */
export function approvalPresentation(): RequestHandler {
  return (req, res, next) => {
    res.locals.portal = null;
    res.locals.portalFrame = false;
    res.locals.portalPreview = null;
    void (async () => {
      const portal = await defaultPortal('approval');
      if (!portal) return;
      const ticket = await ticketByApprovalToken(String(req.params.token ?? ''));
      if (!ticket) return;
      composeApprovalLocals(req, res, portal, {
        reference: ticket.reference,
        title: ticket.title,
        requesterName: (await findUserById(ticket.requester_id))?.display_name ?? '',
        approverEmail: ticket.approval_email,
      });
    })()
      .catch((err: unknown) => {
        log.error({ err }, 'approval page design could not be composed; using the standard look');
        res.locals.portal = null;
      })
      .finally(() => next());
  };
}

/** The portal's script, when scripts are allowed. Never inline: a file. */
export const portalScriptRouter = Router();

portalScriptRouter.get(
  '/:id/script.js',
  requireAuth(),
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const user = req.currentUser!;
    // An administrator may fetch any (the full-screen preview); anybody else
    // only the portal they are shown.
    const portal = user.role === 'admin' ? await findPortal(id) : await portalForUser(user.id);
    if (!portal || portal.id !== id || !portalRunsScript(portal)) throw notFound('No such script.');
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Cache-Control',
      typeof req.query.v === 'string' ? 'private, max-age=604800, immutable' : 'private, no-cache',
    );
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    res.send(portal.script);
  }),
);

/** The portal's stylesheet. The CSP forbids inline styles, so it is a file. */
export const portalRouter = Router();

portalRouter.get(
  '/:id/theme.css',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const user = req.currentUser;
    if (!user) {
      // Signed out, the one sheet anybody may have is the default portal's:
      // the sign-in page is drawn in it. Drafts stay private.
      const fallback = await defaultPortal('requester');
      if (!fallback || fallback.id !== id) throw notFound('No such stylesheet.');
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.removeHeader('Pragma');
      res.removeHeader('Expires');
      res.send(fallback.css);
      return;
    }
    // An administrator may fetch any (the editor and previews need them); a
    // requester only the one they are shown - drafts are nobody else's
    // business.
    // The default approval page's sheet is for whoever is approving, which
    // can be anybody signed in.
    const approval = await defaultPortal('approval');
    const portal =
      user.role === 'admin'
        ? await findPortal(id)
        : approval?.id === id
          ? approval
          : await portalForUser(user.id);
    if (!portal || portal.id !== id) {
      throw notFound('No such stylesheet.');
    }
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Versioned by content in the link, so it can be kept; private, because
    // it is served to signed-in people only.
    res.setHeader(
      'Cache-Control',
      typeof req.query.v === 'string' ? 'private, max-age=604800, immutable' : 'private, no-cache',
    );
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    res.send(portal.css);
  }),
);

/**
 * The portal's home page.
 *
 * Only a portal can have one; with the built-in look, or a portal whose Home
 * is blank, this is My tickets - which is where everybody landed before.
 */
export const homeRouter = Router();

homeRouter.get('/', requireAuth(), (_req: Request, res: Response) => {
  const portal = res.locals.portal as { hasHome: boolean } | null;
  if (!portal || !portal.hasHome) {
    res.redirect('/tickets');
    return;
  }
  res.render('portal-home', { title: 'Home' });
});
