import { Router, type Request } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { formatDateIn } from '../lib/format.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { findUserById, isStaff, type UserRow } from '../services/users.js';
import { settings } from '../settings/index.js';
import {
  AVAILABILITY_STATUSES,
  WEEKDAYS,
  addEntry,
  deleteEntry,
  findDashboard,
  isAvailabilityStatus,
  isDate,
  listLocations,
  setUsualWeek,
  statusLabel,
  todayIn,
  upcomingEntries,
  usualWeek,
} from '../services/dashboards.js';

/**
 * A technician's availability (Settings - Dashboards - Technician
 * availability): their usual week and dated entries.
 *
 * One router, mounted twice: on the technician's own profile, and on their
 * page under Settings - Users, where an administrator can set it for them -
 * somebody off sick is the person least likely to log in and say so.
 */

/** Whether this person states their availability: staff, while the dashboard is on. */
export async function tracksAvailability(user: Pick<UserRow, 'role'>): Promise<boolean> {
  if (!isStaff(user.role)) return false;
  return (await findDashboard('technician-availability'))?.is_enabled === true;
}

/** What the availability card shows. `base` is where its forms post. */
export async function availabilityView(userId: string, base: string, ownPage: boolean) {
  const locale = settings().locale;
  const today = todayIn(locale.timeZone);
  const [week, entries, locations] = await Promise.all([usualWeek(userId), upcomingEntries(userId, today), listLocations()]);
  const names = new Map(locations.map((l) => [l.id, l.name]));
  const show = (d: string) => formatDateIn(new Date(d + 'T12:00:00Z'), { ...locale, timeZone: 'UTC' });
  return {
    base,
    ownPage,
    today,
    locations,
    statuses: AVAILABILITY_STATUSES,
    weeklyStatuses: AVAILABILITY_STATUSES.filter((s) => s.weekly),
    week: WEEKDAYS.map((name, i) => {
      const row = week.find((w) => w.weekday === i + 1);
      return { weekday: i + 1, name, status: row?.status ?? '', locationId: row?.location_id ?? null };
    }),
    entries: entries.map((e) => ({
      id: e.id,
      when: e.starts_on === e.ends_on ? show(e.starts_on) : show(e.starts_on) + ' - ' + show(e.ends_on),
      label: statusLabel(e.status),
      location: e.location_id ? names.get(e.location_id) ?? '' : '',
    })),
  };
}

/**
 * The routes. `whose` finds the account being edited and refuses if the
 * caller may not; `back` is the page to return to.
 */
export function availabilityRouter(options: {
  whose: (req: Request) => Promise<UserRow>;
  back: (req: Request) => string;
}): Router {
  const router = Router({ mergeParams: true });

  async function target(req: Request): Promise<UserRow> {
    const user = await options.whose(req);
    if (!(await tracksAvailability(user))) throw forbidden();
    return user;
  }

  /** Audited when somebody sets another person's availability. */
  function note(req: Request, user: UserRow, what: string): void {
    if (req.currentUser?.id !== user.id) {
      auditRequest(req, { action: 'availability.' + what, targetType: 'user', targetId: user.id, detail: { email: user.email } });
    }
  }

  router.post(
    '/week',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const user = await target(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const locations = new Set((await listLocations()).map((l) => l.id));
      const weekly = new Set<string>(AVAILABILITY_STATUSES.filter((s) => s.weekly).map((s) => s.key));
      const days = WEEKDAYS.map((_, i) => {
        const status = String(body['status_' + (i + 1)] ?? '');
        const location = String(body['location_' + (i + 1)] ?? '');
        return {
          weekday: i + 1,
          // Anything not offered on the form is treated as "not set".
          status: weekly.has(status) && isAvailabilityStatus(status) ? status : ('' as const),
          locationId: locations.has(location) ? location : null,
        };
      });
      await setUsualWeek(user.id, days);
      note(req, user, 'week_changed');
      flash(req, 'success', 'The usual week is saved.', 'availability');
      res.redirect(options.back(req) + '#availability');
    }),
  );

  router.post(
    '/entries',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const user = await target(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const startsOn = String(body.startsOn ?? '');
      const endsRaw = String(body.endsOn ?? '');
      const endsOn = endsRaw === '' ? startsOn : endsRaw;
      const status = String(body.status ?? '');
      const location = String(body.locationId ?? '');
      const locations = new Set((await listLocations()).map((l) => l.id));

      let problem: string | null = null;
      if (!isDate(startsOn) || !isDate(endsOn)) problem = 'Choose the dates from the calendar.';
      else if (endsOn < startsOn) problem = 'The end date is before the start date.';
      else if (endsOn < todayIn(settings().locale.timeZone)) problem = 'That period is already over.';
      else if (!isAvailabilityStatus(status)) problem = 'Choose a status.';
      if (problem) {
        flash(req, 'error', problem, 'availability');
        res.redirect(options.back(req) + '#availability');
        return;
      }
      await addEntry(user.id, {
        startsOn,
        endsOn,
        status: status as Parameters<typeof addEntry>[1]['status'],
        locationId: locations.has(location) ? location : null,
      });
      note(req, user, 'entry_added');
      flash(req, 'success', statusLabel(status) + ' added.', 'availability');
      res.redirect(options.back(req) + '#availability');
    }),
  );

  router.post(
    '/entries/:entryId/delete',
    writeLimiter,
    asyncHandler(async (req, res) => {
      const user = await target(req);
      await deleteEntry(user.id, String(req.params.entryId));
      note(req, user, 'entry_removed');
      flash(req, 'success', 'Removed.', 'availability');
      res.redirect(options.back(req) + '#availability');
    }),
  );

  return router;
}

/** For Settings - Users - <someone>: the account in the path. */
export async function userInPath(req: Request): Promise<UserRow> {
  const user = await findUserById(String(req.params.id));
  if (!user) throw notFound('No such user.');
  return user;
}
