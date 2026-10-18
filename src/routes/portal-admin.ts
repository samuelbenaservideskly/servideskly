import { Router, type Request, type Response } from 'express';
import { dashboardIds, listDashboards } from '../services/dashboards.js';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { allowFramingBySelf, allowOwnFrames, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { listActiveTemplates } from '../services/templates.js';
import { listActiveUserGroups } from '../services/user-groups.js';
import {
  PORTAL_PAGES,
  STANDARD_PORTAL,
  createPortal,
  deletePortal,
  duplicatePortal,
  findPortal,
  hasHomePage,
  listPortalAssignments,
  listPortals,
  partProblems,
  partsFor,
  portalGroupCount,
  portalProtectedReason,
  renamePortal,
  resetPortalDesign,
  sampleTicketId,
  savePortalPart,
  setDefaultPortal,
  setPortalGroups,
  variablesFor,
  type PortalKind,
  type PortalPart,
  type PortalRow,
} from '../services/portal.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { composeApprovalLocals, renderAsSource } from './portal.js';
import { settingsView } from './settings-shared.js';

/**
 * The list and the editor for a kind of portal.
 *
 * One definition, mounted twice: Settings - Customisation - Requester portal,
 * and Settings - Mail - Approval page. The list is where a design is chosen
 * (a choice *between* them, like the default template); each design has an
 * editor split between its code and a preview.
 *
 * What differs by kind is small and lives in `PortalAdminConfig`: where it
 * is mounted, which tabs frame it, and how the preview finds a page to show.
 * Group assignment is the requester portal's alone - an approver is not
 * somebody whose groups this desk knows.
 */
export interface PortalAdminConfig {
  kind: PortalKind;
  /** Where the router is mounted, for links and redirects. */
  base: string;
  /** The settings section it belongs to, for the sidebar. */
  section: 'customization' | 'mail';
  /** The tab strip partial, and which of its tabs is this one. */
  tabs: string;
  tab: string;
  /** "portal" or "approval page", for the words on the screen. */
  noun: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function nameProblem(name: string): string | null {
  if (name.length === 0) return 'Give it a name.';
  if (name.length > 80) return 'Keep the name to 80 characters or fewer.';
  return null;
}

/** A stand-in request, for previewing an approval page with nothing pending. */
const SAMPLE_APPROVAL = {
  reference: 'SR-000123',
  title: 'New laptop for the finance team',
  requesterName: 'Jana Nováková',
  approverEmail: 'line.manager@example.com',
};

/**
 * Every dashboard, and whether this portal writes {{dashboard:<id>}} for it.
 *
 * The parts are read as text rather than composed: the point is what the
 * author typed, not what a particular reader would be shown.
 */
async function portalDashboards(portal: {
  layout_html: string;
  pages: Record<string, string>;
}): Promise<{ id: string; name: string; enabled: boolean; used: boolean }[]> {
  const written = [portal.layout_html, ...Object.values(portal.pages ?? {})].join('\n');
  return (await listDashboards()).map((dashboard) => ({
    id: dashboard.id,
    name: dashboard.name,
    enabled: dashboard.is_enabled,
    used: written.includes('{{dashboard:' + dashboard.id + '}}'),
  }));
}

export function makePortalAdminRouter(cfg: PortalAdminConfig): Router {
  const router = Router();
  const { kind, base } = cfg;
  const Noun = cfg.noun.charAt(0).toUpperCase() + cfg.noun.slice(1);

  /** Locals every page of this router passes to its views. */
  const common = () => ({
    kind,
    base,
    noun: cfg.noun,
    Noun,
    tabsPartial: cfg.tabs,
    tabKey: cfg.tab,
    withGroups: kind === 'requester',
  });

  async function own(id: string): Promise<PortalRow> {
    const portal = await findPortal(id);
    if (!portal || portal.kind !== kind) throw notFound('That ' + cfg.noun + ' no longer exists.');
    return portal;
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  async function renderList(
    res: Response,
    extra: { openDialog?: string | null; errors?: FieldErrors; values?: Record<string, string> } = {},
    status?: number,
  ): Promise<void> {
    const portals = await listPortals(kind);
    const fallback = portals.find((p) => p.is_active);

    // Which groups follow each portal, and - for the dialog - which portal
    // each group follows now, so ticking it says where it moves from.
    const groupsByPortal: Record<string, string[]> = {};
    const portalOfGroup: Record<string, { id: string; name: string }> = {};
    let userGroups: unknown[] = [];
    if (kind === 'requester') {
      const nameOf = (id: string) =>
        id === STANDARD_PORTAL ? 'Standard' : (portals.find((p) => p.id === id)?.name ?? '');
      for (const a of await listPortalAssignments()) {
        (groupsByPortal[a.portal_id] ??= []).push(a.group_name);
        portalOfGroup[a.group_id] = { id: a.portal_id, name: nameOf(a.portal_id) };
      }
      userGroups = await listActiveUserGroups();
    }

    if (status) res.status(status);
    res.render(
      'admin/settings/portal',
      settingsView(cfg.section, {
        ...common(),
        portals,
        defaultId: fallback ? fallback.id : STANDARD_PORTAL,
        userGroups,
        groupsByPortal,
        portalOfGroup,
        openDialog: extra.openDialog ?? null,
        errors: extra.errors ?? {},
        values: extra.values ?? {},
        protectedReason: portalProtectedReason,
      }),
    );
  }

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      await renderList(res);
    }),
  );

  router.post(
    '/',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const name = text((req.body as Record<string, unknown>)?.name);
      const refuse = (errors: FieldErrors) =>
        renderList(res, { openDialog: 'new-portal', errors, values: { name } }, 400);

      const problem = nameProblem(name);
      if (problem) {
        await refuse({ name: problem });
        return;
      }
      const created = await attempt(() =>
        createPortal(name, req.currentUser?.id ?? null, undefined, kind),
      );
      if (!created.ok) {
        await refuse(created.errors);
        return;
      }
      flash(
        req,
        'success',
        kind === 'requester'
          ? 'Portal created. Requesters will not see it until you set it as default or assign it to a group.'
          : 'Approval page created. Approvers will not see it until you set it as default.',
      );
      res.redirect(base + '/' + created.value.id);
    }),
  );

  if (kind === 'requester') {
    /** Leaves the full-screen preview. Before '/:id', which would read "preview" as an id. */
    router.post('/preview/exit', (req: Request, res: Response) => {
      const id = req.session.portalPreview;
      delete req.session.portalPreview;
      res.redirect(id && id !== STANDARD_PORTAL ? base + '/' + encodeURIComponent(id) : base);
    });
  }

  router.post(
    '/:id/default',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      await setDefaultPortal(id, req.currentUser?.id ?? null, kind);
      flash(
        req,
        'success',
        (id === STANDARD_PORTAL ? 'The standard ' + cfg.noun : 'This ' + cfg.noun) +
          ' is now the default.' +
          (kind === 'requester' ? ' Groups assigned to another portal keep theirs.' : ''),
      );
      res.redirect(base);
    }),
  );

  if (kind === 'requester') {
    /** The groups that follow this portal - exactly the ticked ones. */
    router.post(
      '/:id/groups',
      writeLimiter,
      asyncHandler(async (req, res) => {
        const raw = (req.body as Record<string, unknown>)?.groups;
        const ids = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
          (v): v is string => typeof v === 'string' && v !== '',
        );
        const result = await attempt(() =>
          setPortalGroups(String(req.params.id), ids, req.currentUser?.id ?? null),
        );
        if (result.ok) flash(req, 'success', 'Groups saved.');
        else flash(req, 'error', result.errors.form ?? Object.values(result.errors)[0] ?? '');
        res.redirect(base);
      }),
    );
  }

  router.post(
    '/:id/duplicate',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (id !== STANDARD_PORTAL) await own(id);
      const copy = await duplicatePortal(id, req.currentUser?.id ?? null, kind);
      flash(req, 'success', 'Created "' + copy.name + '".');
      res.redirect(base + '/' + copy.id);
    }),
  );

  router.post(
    '/:id/delete',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (id !== STANDARD_PORTAL) await own(id);
      const result = await attempt(() => deletePortal(id, req.currentUser?.id ?? null));
      if (result.ok) {
        flash(
          req,
          'success',
          result.value > 0
            ? Noun + ' removed. ' + result.value + ' group' + (result.value === 1 ? '' : 's') +
                ' assigned to it now see the default.'
            : Noun + ' removed.',
        );
      } else {
        flash(req, 'error', result.errors.form ?? Object.values(result.errors)[0] ?? '');
      }
      res.redirect(base);
    }),
  );

  /**
   * Full-screen preview.
   *
   * The requester portal: the real requester pages, drawn in this portal, for
   * this administrator only until they leave it - real pages, so working
   * buttons and real forms, which the banner says. The approval page: a
   * stand-in request in the approval page, since a real one would be
   * somebody else's to answer.
   */
  router.post(
    '/:id/preview',
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      if (id !== STANDARD_PORTAL) await own(id);
      if (kind === 'requester') {
        req.session.portalPreview = id;
        res.redirect('/home');
      } else {
        res.redirect(base + '/' + encodeURIComponent(id) + '/sample');
      }
    }),
  );

  if (kind === 'approval') {
    /**
     * The approval page with a stand-in request. `?frame=1` for the editor's
     * split view, which is the only time it may be framed (by our own page).
     */
    router.get(
      '/:id/sample',
      asyncHandler(async (req, res) => {
        const id = String(req.params.id);
        const portal = id === STANDARD_PORTAL ? undefined : await own(id);
        const framed = req.query.frame === '1';
        if (framed) allowFramingBySelf(res);
        if (framed && req.query.source === '1') renderAsSource(req, res);

        res.locals.portal = null;
        res.locals.portalFrame = framed;
        res.locals.portalPreview = framed
          ? null
          : {
              id,
              name: portal ? portal.name : 'Standard',
              editUrl: portal ? base + '/' + portal.id : base,
              exitAction: null,
            };
        if (portal) composeApprovalLocals(req, res, portal, SAMPLE_APPROVAL);

        res.render('approval', {
          title: 'Approval ' + SAMPLE_APPROVAL.reference,
          ticket: {
            reference: SAMPLE_APPROVAL.reference,
            title: SAMPLE_APPROVAL.title,
            description:
              'Three laptops for the new starters in finance, to arrive before the 1st.',
            created_at: new Date().toISOString(),
            approval_status: 'pending',
          },
          typeLabel: 'Service request',
          token: 'sample',
          decided: false,
          sample: true,
          errors: {},
        });
      }),
    );
  }

  // -------------------------------------------------------------------------
  // The editor
  // -------------------------------------------------------------------------

  /** Which page the frame shows for a part, or why it shows none. */
  async function previewFor(
    portal: PortalRow,
    part: PortalPart,
  ): Promise<{ src: string | null; note: string | null }> {
    if (kind === 'approval') {
      return { src: base + '/' + encodeURIComponent(portal.id) + '/sample?frame=1', note: null };
    }
    const frame = '?portalFrame=' + encodeURIComponent(portal.id);
    const landing = hasHomePage(portal) ? '/home' : '/tickets';

    if (part === 'layout' || part === 'css') return { src: landing + frame, note: null };
    if (part === 'js') {
      return {
        src: landing + frame,
        note: 'Scripts do not run in this preview. Use Full-screen preview to see them work.',
      };
    }
    if (part === 'home') {
      return hasHomePage(portal)
        ? { src: '/home' + frame, note: null }
        : {
            src: '/tickets' + frame,
            note: 'Home is blank, so requesters go straight to My tickets.',
          };
    }
    if (part === 'ticket') {
      const id = await sampleTicketId();
      return id
        ? { src: '/tickets/' + encodeURIComponent(id) + frame, note: null }
        : { src: null, note: 'There are no tickets yet, so there is nothing to show here.' };
    }
    const page = PORTAL_PAGES.find((p) => p.key === part)!;
    return { src: page.path + frame, note: null };
  }

  function partCode(portal: PortalRow, part: PortalPart): string {
    if (part === 'layout') return portal.layout_html;
    if (part === 'css') return portal.css;
    if (part === 'js') return portal.script ?? '';
    const own = portal.pages[part] ?? '';
    // Blank means "just the page" - so show that, as HTML to build on,
    // rather than an empty box. Saving it unchanged means the same thing.
    // Home is the exception: blank there means "no home page".
    return own.trim() === '' && part !== 'home' ? '{{content}}' : own;
  }

  function partOf(value: unknown): PortalPart {
    const parts = partsFor(kind);
    return (parts.find((p) => p.key === value) ?? parts[0]!).key;
  }

  async function renderEditor(
    res: Response,
    portal: PortalRow,
    part: PortalPart,
    extra: { code?: string; problems?: string[]; nameError?: string; name?: string } = {},
    status?: number,
  ): Promise<void> {
    const preview = await previewFor(portal, part);
    const templates =
      kind === 'requester'
        ? (await listActiveTemplates()).map((t) => ({ id: t.id, name: t.name }))
        : [];
    const parts = partsFor(kind);
    if (status) res.status(status);
    res.render(
      'admin/settings/portal-edit',
      settingsView(cfg.section, {
        ...common(),
        wide: true,
        groupCount: kind === 'requester' ? await portalGroupCount(portal.id) : 0,
        portal,
        part,
        parts,
        partLabel: parts.find((p) => p.key === part)!.label,
        code: extra.code ?? partCode(portal, part),
        codeProblems: extra.problems ?? [],
        nameValue: extra.name ?? portal.name,
        nameError: extra.nameError ?? null,
        previewSrc: preview.src,
        previewNote: preview.note,
        variables: variablesFor(kind),
        // Only a requester portal can carry one; an approval page cannot.
        dashboards: kind === 'approval' ? [] : await portalDashboards(portal),
        templates,
      }),
    );
  }

  router.get(
    '/:id',
    allowOwnFrames(),
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      // The standard design is the code; there is nothing of it to edit.
      if (id === STANDARD_PORTAL) {
        res.redirect(base);
        return;
      }
      const portal = await own(id);
      await renderEditor(res, portal, partOf(req.query.part));
    }),
  );

  router.post(
    '/:id/parts/:part',
    writeLimiter,
    allowOwnFrames(),
    asyncHandler(async (req, res) => {
      const portal = await own(String(req.params.id));
      const part = req.params.part;
      if (!partsFor(kind).some((p) => p.key === part)) throw notFound('No such part.');
      const key = part as PortalPart;

      const raw = (req.body as Record<string, unknown>)?.code;
      // Line endings from a textarea arrive as CRLF; store what was meant.
      const code = (typeof raw === 'string' ? raw : '').replace(/\r\n/g, '\n');

      const active = new Set((await listActiveTemplates()).map((t) => t.id));
      const problems = partProblems(key, code, active, kind, await dashboardIds());
      if (problems.length > 0) {
        await renderEditor(res, portal, key, { code, problems }, 400);
        return;
      }

      await savePortalPart(portal.id, key, code, req.currentUser?.id ?? null);
      const live =
        portal.is_active || (kind === 'requester' && (await portalGroupCount(portal.id)) > 0);
      flash(
        req,
        'success',
        live ? 'Saved. ' + (kind === 'requester' ? 'Requesters' : 'Approvers') + ' see this change now.' : 'Saved.',
      );
      res.redirect(base + '/' + portal.id + '?part=' + key + '#editor');
    }),
  );

  /**
   * "Start again from the current design".
   *
   * Behind a confirmation, because it replaces work: the layout, the CSS
   * and the Home page go back to what a new portal starts from. Offered
   * because a portal written before the 2026 design keeps its own markup by
   * design, and the only alternative was copying the starter by hand.
   */
  router.post(
    '/:id/reset-design',
    writeLimiter,
    allowOwnFrames(),
    asyncHandler(async (req, res) => {
      const portal = await own(String(req.params.id));
      const part = partOf(req.query.part);
      await resetPortalDesign(portal.id, req.currentUser?.id ?? null);
      flash(req, 'success', 'This portal is back to the design a new one starts from.');
      res.redirect(cfg.base + '/' + portal.id + '?part=' + part);
    }),
  );

  router.post(
    '/:id/rename',
    writeLimiter,
    allowOwnFrames(),
    asyncHandler(async (req, res) => {
      const portal = await own(String(req.params.id));
      const part = partOf(req.query.part);
      const name = text((req.body as Record<string, unknown>)?.name);

      const problem = nameProblem(name);
      if (problem) {
        await renderEditor(res, portal, part, { name, nameError: problem }, 400);
        return;
      }
      const renamed = await attempt(() =>
        renamePortal(portal.id, name, req.currentUser?.id ?? null),
      );
      if (!renamed.ok) {
        await renderEditor(
          res,
          portal,
          part,
          { name, nameError: renamed.errors.name ?? renamed.errors.form },
          400,
        );
        return;
      }
      flash(req, 'success', 'Renamed.');
      res.redirect(base + '/' + portal.id + '?part=' + part);
    }),
  );

  return router;
}

export const portalAdminRouter = makePortalAdminRouter({
  kind: 'requester',
  base: '/admin/settings/customization/portal',
  section: 'customization',
  tabs: '_customization-tabs',
  tab: 'portal',
  noun: 'portal',
});

export const approvalPageAdminRouter = makePortalAdminRouter({
  kind: 'approval',
  base: '/admin/settings/mail/approval',
  section: 'mail',
  tabs: '_mail-tabs',
  tab: 'approval',
  noun: 'approval page',
});
