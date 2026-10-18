import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { notFound } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { SLA_STATE_LABELS } from '../services/sla.js';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from '../services/tickets.js';
import { settings } from '../settings/index.js';
import { queryOne } from '../db/index.js';
import { listPins } from '../services/boards.js';
import {
  ACTIVITY_KINDS,
  activityChoice,
  canUseWorkDashboard,
  managedGroups,
  managerView,
  myWork,
} from '../services/work-dashboard.js';
import { execute } from '../db/index.js';
import { flash } from '../middleware/view-locals.js';
import { writeLimiter } from '../middleware/security.js';
import { canUseDirectory } from './people.js';

/**
 * /dashboard - My work, and Manager for a group's manager. See
 * services/work-dashboard.ts. Anybody else gets a 404: it is not their page.
 */
export const workDashboardRouter = Router();

workDashboardRouter.use(requireAuth());

/** Offers the Dashboard link in the header to those it is for. */
export function workDashboardLink() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.locals.showWorkDashboard = await canUseWorkDashboard(req.currentUser);
      // ...and the People link, to whoever the directory is open to.
      res.locals.canUseDirectory = req.currentUser ? canUseDirectory(req.currentUser) : false;
      // The sidebar's badge on Tickets: staff, what is open and assigned to
      // them; a requester, their own open tickets. One indexed count; a page
      // that is not GET (a form post) does not draw the sidebar, so skips it.
      const user = req.currentUser;
      if (user && req.method === 'GET') {
        const column = user.role === 'user' ? 'requester_id' : 'assignee_id';
        const row = await queryOne<{ n: number }>(
          `SELECT count(*) AS n FROM tickets WHERE ${column} = ? AND parent_id IS NULL AND status IN ('open', 'in_progress', 'pending')`,
          [user.id],
        );
        res.locals.sidebarTicketCount = Number(row?.n ?? 0);
        // Their pins, for the sidebar's Pinned section; and where they are,
        // to mark the current pin.
        if (user.role !== 'user') res.locals.sidebarPins = await listPins(user.id);
        res.locals.currentUrl = req.originalUrl;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

const LABELS = { statusLabels: STATUS_LABELS, priorityLabels: PRIORITY_LABELS, slaStateLabels: SLA_STATE_LABELS, typeLabels: TYPE_LABELS };

/** Good morning / afternoon / evening, by the clock of the Locale time zone. */
function greeting(now = new Date()): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: settings().locale.timeZone }).format(now));
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

workDashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = req.currentUser!;
    if (!(await canUseWorkDashboard(user))) throw notFound();
    const [work, managing] = await Promise.all([myWork(user), managedGroups(user)]);
    // A manager who is in no group of their own has no "my work": straight
    // to the manager's view.
    if (work.groups.length === 0 && work.mine.length === 0 && managing.length > 0) {
      res.redirect('/dashboard/manager');
      return;
    }
    res.render('work-dashboard', {
      title: 'Dashboard',
      tab: 'mine',
      work,
      greeting: greeting(),
      firstName: (user.display_name.split(/\s+/)[0] || user.display_name),
      canManage: managing.length > 0,
      // The pen beside the Activity heading: the kinds this person may see,
      // and the ones they have kept.
      activityKinds: ACTIVITY_KINDS.filter((k) => k.key !== 'automations' || user.role === 'admin'),
      activityChosen: activityChoice(user),
      ...LABELS,
    });
  }),
);

/**
 * What this person keeps in their Activity feed.
 *
 * Their own choice, on their own dashboard - no permission to check beyond
 * being allowed the page at all, and `activityChoice` narrows whatever is
 * stored to the kinds they may see, so a technician cannot keep automation
 * lines by posting the value.
 */
workDashboardRouter.post(
  '/activity',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = req.currentUser;
    if (!user) throw notFound();

    const raw = (req.body ?? {}) as Record<string, unknown>;
    const ticked = Array.isArray(raw.kinds)
      ? raw.kinds.map(String)
      : typeof raw.kinds === 'string'
        ? [String(raw.kinds)]
        : [];
    const kinds = ACTIVITY_KINDS.map((k) => k.key).filter((key) => ticked.includes(key));

    // Everything ticked is the same as nothing stored, and reads better on
    // the next upgrade that adds a kind: they get the new one too.
    const stored = kinds.length === ACTIVITY_KINDS.length ? '' : kinds.join(',');
    await execute('UPDATE users SET activity_kinds = ?, updated_at = ? WHERE id = ?', [
      stored,
      new Date().toISOString(),
      user.id,
    ]);

    flash(req, 'success', 'Saved.');
    res.redirect('/dashboard#activity');
  }),
);

workDashboardRouter.get(
  '/manager',
  asyncHandler(async (req, res) => {
    const user = req.currentUser!;
    // A repeated ?group= is an array; one is a string; neither is required.
    const asked = req.query.group;
    const view = await managerView(
      user,
      Array.isArray(asked) ? asked.map(String) : typeof asked === 'string' ? asked : undefined,
    );
    if (!view) throw notFound();
    res.render('work-dashboard', {
      title: 'Dashboard - manager',
      tab: 'manager',
      manager: view,
      canManage: true,
      ...LABELS,
    });
  }),
);
