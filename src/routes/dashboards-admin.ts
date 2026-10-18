import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { allowFramingBySelf, allowOwnFrames, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { listGroups } from '../services/groups.js';
import { listUserGroups } from '../services/user-groups.js';
import { findPortal } from '../services/portal.js';
import {
  AVAILABILITY_STATUSES,
  BUILT_IN_DASHBOARDS,
  COPYABLE_KINDS,
  createDashboard,
  deleteDashboard,
  renameDashboard,
  saveServiceDeskGroups,
  serviceDeskGroups,
  VARIABLES_BY_KIND,
  SEVERITIES,
  announcementProblems,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  todayIn,
  type Severity,
  availabilityOptions,
  createLocation,
  deleteLocation,
  designProblems,
  findDashboard,
  isAvailabilityStatus,
  listDashboards,
  listLocations,
  renderDashboard,
  saveAvailabilityOptions,
  saveDashboardDesign,
  setDashboardEnabled,
  updateLocation,
  type AvailabilityOptions,
  type AvailabilityStatus,
  type LocationInput,
} from '../services/dashboards.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { settingsView } from './settings-shared.js';
import { settings } from '../settings/index.js';

/**
 * Settings - Dashboards. Two tabs: User dashboards (what requesters are
 * shown) and Locations (where technicians can be, and who may read which).
 */
export const dashboardsAdminRouter = Router();

const BASE = '/admin/settings/dashboards';

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

dashboardsAdminRouter.get('/', (_req: Request, res: Response) => {
  res.redirect(BASE + '/user');
});

// ---------------------------------------------------------------------------
// User dashboards
// ---------------------------------------------------------------------------

async function renderList(
  res: Response,
  extra: { status?: number; openDialog?: string | null; errors?: FieldErrors; values?: Record<string, unknown> } = {},
): Promise<void> {
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/dashboards',
    settingsView('dashboards', {
      dashboards: await listDashboards(),
      builtIn: BUILT_IN_DASHBOARDS,
      kinds: COPYABLE_KINDS,
      kindLabels: {
        technician_availability: 'Technician availability',
        my_tickets: 'My tickets',
        announcements: 'Announcements',
        service_desk: 'Service desk at a glance',
      },
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
    }),
  );
}

dashboardsAdminRouter.get('/user', asyncHandler(async (_req, res) => renderList(res)));

dashboardsAdminRouter.post(
  '/user',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === 'string' ? body.name : '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const values = { name, kind };
    if (!name) {
      return renderList(res, { status: 400, openDialog: 'new-dashboard', errors: { name: 'Name the dashboard.' }, values });
    }
    const done = await attempt(() => createDashboard(name, kind, req.currentUser?.id ?? null));
    if (!done.ok) {
      return renderList(res, { status: 400, openDialog: 'new-dashboard', errors: { name: Object.values(done.errors)[0] ?? 'It could not be made.' }, values });
    }
    flash(req, 'success', 'Dashboard created, switched off. Choose its technicians, then turn it on.');
    res.redirect(BASE + '/user/' + done.value);
  }),
);

dashboardsAdminRouter.post(
  '/user/:id/name',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === 'string' ? body.name : '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) {
      return renderEdit(req, res, { status: 400, errors: { name: 'Name the dashboard.' }, values: { name } });
    }
    const done = await attempt(() => renameDashboard(id, name, req.currentUser?.id ?? null));
    if (!done.ok) {
      return renderEdit(req, res, { status: 400, errors: { name: Object.values(done.errors)[0] ?? 'It could not be renamed.' }, values: { name } });
    }
    flash(req, 'success', 'Dashboard renamed.');
    res.redirect(BASE + '/user/' + id);
  }),
);

dashboardsAdminRouter.post(
  '/user/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await deleteDashboard(String(req.params.id), req.currentUser?.id ?? null);
    flash(req, 'success', 'Dashboard deleted. A portal that named it now shows nothing in its place.');
    res.redirect(BASE + '/user');
  }),
);

dashboardsAdminRouter.post(
  '/user/:id/enabled',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const enabled = (req.body as Record<string, unknown>)?.enabled === 'on';
    await setDashboardEnabled(id, enabled, req.currentUser?.id ?? null);
    flash(
      req,
      'success',
      enabled
        ? 'The dashboard is shown to requesters. Technicians set their availability on their profile page.'
        : 'The dashboard is no longer shown.',
    );
    const back = (req.body as Record<string, unknown>)?.back === 'edit' ? BASE + '/user/' + id : BASE + '/user';
    res.redirect(back);
  }),
);

/**
 * The portal a dashboard page was opened from, as a link.
 *
 * An id, never a path: anything else is ignored, so the parameter cannot be
 * turned into a redirect to somewhere off this site.
 */
async function portalBackLink(from: unknown): Promise<{ href: string; label: string } | null> {
  if (typeof from !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(from)) return null;
  const portal = await findPortal(from);
  if (!portal || portal.kind !== 'requester') return null;
  return {
    href: '/admin/settings/customization/portal/' + portal.id,
    label: 'Back to ' + portal.name,
  };
}

async function renderEdit(
  req: Request,
  res: Response,
  extra: {
    status?: number;
    designErrors?: string[];
    typedHtml?: string;
    typedDesign?: string;
    openDialog?: string | null;
    errors?: FieldErrors;
    values?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const row = await findDashboard(String(req.params.id));
  if (!row) throw notFound('No such dashboard.');
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/dashboard-edit',
    settingsView('dashboards', {
      sectionTitle: row.name,
      dashboard: row,
      options: availabilityOptions(row),
      statuses: AVAILABILITY_STATUSES,
      variables: VARIABLES_BY_KIND[row.kind],
      announcements: row.kind === 'announcements' ? await listAnnouncements(row.id) : [],
      scopedGroups: serviceDeskGroups(row),
      severities: SEVERITIES,
      today: todayIn(settings().locale.timeZone),
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
      technicianGroups: await listGroups(),
      designErrors: extra.designErrors ?? [],
      typedHtml: extra.typedHtml ?? row.custom_html,
      typedDesign: extra.typedDesign ?? row.design,
      // The preview is framed, so the page may frame one page of ours.
      previewUrl: BASE + '/user/' + row.id + '/preview?v=' + encodeURIComponent(row.updated_at),
      // Where this was opened from, when it was a portal (?from=<id>).
      fromPortal: await portalBackLink(req.query.from),
    }),
  );
}

dashboardsAdminRouter.get('/user/:id', allowOwnFrames(), asyncHandler(async (req, res) => renderEdit(req, res)));

dashboardsAdminRouter.post(
  '/user/:id/options',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await findDashboard(String(req.params.id));
    if (!row) throw notFound('No such dashboard.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const known = new Set((await listGroups()).map((g) => g.id));
    if (row.kind === 'service_desk') {
      await saveServiceDeskGroups(row.id, list(body.groupIds).filter((g) => known.has(g)), req.currentUser?.id ?? null);
      flash(req, 'success', 'Dashboard options saved.');
      res.redirect(BASE + '/user/' + row.id);
      return;
    }
    if (row.kind !== 'technician_availability') throw notFound('This dashboard has no options.');
    const options: AvailabilityOptions = {
      view: body.view === 'week' ? 'week' : 'today',
      statuses: list(body.statuses).filter(isAvailabilityStatus) as AvailabilityStatus[],
      showLocation: body.showLocation === 'on',
      groupIds: list(body.groupIds).filter((g) => known.has(g)),
    };
    await saveAvailabilityOptions(row.id, options, req.currentUser?.id ?? null);
    flash(req, 'success', 'Dashboard options saved.');
    res.redirect(BASE + '/user/' + row.id);
  }),
);

dashboardsAdminRouter.post(
  '/user/:id/design',
  writeLimiter,
  allowOwnFrames(),
  asyncHandler(async (req, res) => {
    const row = await findDashboard(String(req.params.id));
    if (!row) throw notFound('No such dashboard.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const design = body.design === 'custom' ? 'custom' : 'standard';
    const html = (typeof body.html === 'string' ? body.html : '').replace(/\r\n/g, '\n');
    const problems = designProblems(html, row.kind);
    if (design === 'custom' && html.trim() === '') problems.push('Write the HTML, or choose the standard design.');
    if (problems.length > 0) {
      await renderEdit(req, res, { status: 400, designErrors: problems, typedHtml: html, typedDesign: design });
      return;
    }
    await saveDashboardDesign(row.id, design, html, req.currentUser?.id ?? null);
    flash(req, 'success', 'Design saved.');
    res.redirect(BASE + '/user/' + row.id + '#design');
  }),
);

// Announcements: what the Announcements dashboard shows.
dashboardsAdminRouter.post(
  '/user/:id/announcements',
  writeLimiter,
  allowOwnFrames(),
  asyncHandler(async (req, res) => {
    const row = await findDashboard(String(req.params.id));
    if (!row || row.kind !== 'announcements') throw notFound('No such dashboard.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const input = { title: s('title').trim(), body: s('body').replace(/\r\n/g, '\n').trim(), severity: s('severity'), startsOn: s('startsOn'), endsOn: s('endsOn') };
    const errors = announcementProblems(input);
    if (Object.keys(errors).length > 0) {
      await renderEdit(req, res, { status: 400, openDialog: 'new-announcement', errors, values: body });
      return;
    }
    await createAnnouncement(row.id, { ...input, severity: input.severity as Severity }, req.currentUser?.id ?? null);
    flash(req, 'success', 'Announcement "' + input.title + '" added.');
    res.redirect(BASE + '/user/' + row.id + '#announcements');
  }),
);

dashboardsAdminRouter.post(
  '/user/:id/announcements/:announcementId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await deleteAnnouncement(String(req.params.id), String(req.params.announcementId), req.currentUser?.id ?? null);
    flash(req, 'success', 'Announcement removed.');
    res.redirect(BASE + '/user/' + String(req.params.id) + '#announcements');
  }),
);

/**
 * The preview: the dashboard as a requester in no user group sees it,
 * whether or not it is switched on. Framed by the edit page only, so a
 * custom design's stray tag cannot reach the settings page around it.
 */
dashboardsAdminRouter.get(
  '/user/:id/preview',
  asyncHandler(async (req, res) => {
    const row = await findDashboard(String(req.params.id));
    if (!row) throw notFound('No such dashboard.');
    allowFramingBySelf(res);
    res.render('admin/settings/dashboard-preview', {
      markup: await renderDashboard(row, null, { ignoreEnabled: true }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

async function renderLocations(
  res: Response,
  extra: { status?: number; openDialog?: string | null; errors?: FieldErrors; values?: Record<string, unknown> } = {},
): Promise<void> {
  if (extra.status) res.status(extra.status);
  res.render(
    'admin/settings/locations',
    settingsView('dashboards', {
      locations: await listLocations(),
      userGroups: await listUserGroups(),
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
    }),
  );
}

dashboardsAdminRouter.get('/locations', asyncHandler(async (_req, res) => renderLocations(res)));

async function readLocation(body: Record<string, unknown>): Promise<{ input: LocationInput; errors: FieldErrors }> {
  const name = (typeof body.name === 'string' ? body.name : '').trim();
  const everyone = body.everyone === 'on';
  const known = new Set((await listUserGroups()).map((g) => g.id));
  const groupIds = list(body.groupIds).filter((g) => known.has(g));
  const errors: FieldErrors = {};
  if (!name) errors.name = 'Give the location a name.';
  else if (name.length > 100) errors.name = 'Keep the name under 100 characters.';
  if (!everyone && groupIds.length === 0) errors.groupIds = 'Choose who may see it: everyone, or at least one user group.';
  return { input: { name, everyone, groupIds }, errors };
}

dashboardsAdminRouter.post(
  '/locations',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { input, errors } = await readLocation(body);
    const refuse = (errs: FieldErrors) => renderLocations(res, { status: 400, openDialog: 'new-location', errors: errs, values: body });
    if (Object.keys(errors).length > 0) return refuse(errors);
    const attempted = await attempt(() => createLocation(input, req.currentUser?.id ?? null));
    if (!attempted.ok) return refuse(attempted.errors);
    flash(req, 'success', 'Location "' + input.name + '" added.');
    res.redirect(BASE + '/locations');
  }),
);

dashboardsAdminRouter.post(
  '/locations/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { input, errors } = await readLocation(body);
    const refuse = (errs: FieldErrors) =>
      renderLocations(res, { status: 400, openDialog: 'location-' + id, errors: errs, values: body });
    if (Object.keys(errors).length > 0) return refuse(errors);
    const attempted = await attempt(() => updateLocation(id, input, req.currentUser?.id ?? null));
    if (!attempted.ok) return refuse(attempted.errors);
    flash(req, 'success', 'Location saved.');
    res.redirect(BASE + '/locations');
  }),
);

dashboardsAdminRouter.post(
  '/locations/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    await deleteLocation(String(req.params.id), req.currentUser?.id ?? null);
    flash(req, 'success', 'Location removed. Technicians who used it are shown without a location.');
    res.redirect(BASE + '/locations');
  }),
);
