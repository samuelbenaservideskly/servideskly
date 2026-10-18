import { queryOne, query } from '../db/index.js';
import { settings, type SlaSettings } from '../settings/index.js';
import type { TicketPriority, TicketStatus } from './tickets.js';

/**
 * Service level targets.
 *
 * Settings - Tickets - Other settings - SLA: for each priority, how
 * long the service desk has to **respond** and to **resolve**, counted in
 * business time - only inside the working days and hours, in one time zone.
 * An urgent ticket raised at 16:55 on a Friday with a 30-minute response
 * target is due at 08:25 on Monday, not at 17:25 on Friday.
 *
 * Nothing is stored per ticket. The two due moments follow from when it was
 * raised and its priority; the two "done" moments are facts already on
 * record - the first public reply or status change by somebody other than
 * the requester, and resolved_at. So a ticket raised before SLA was switched
 * on still gets a sensible reading, and changing a target re-reads every
 * ticket rather than leaving old ones on old rules.
 *
 * Not modelled, on purpose for now: pausing the clock while a ticket is On
 * hold, and public holidays. Both are the next things an SLA usually grows.
 */

export type SlaState = 'met' | 'breached' | 'due' | 'at_risk' | 'paused';

export interface SlaClock {
  due: Date;
  /** When it was done, if it has been. */
  doneAt: Date | null;
  state: SlaState;
}

export interface TicketSla {
  response: SlaClock;
  resolution: SlaClock;
}

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Time zones without a library
// ---------------------------------------------------------------------------

/**
 * One formatter per time zone, kept: building an Intl.DateTimeFormat is far
 * slower than using one, and the business-time arithmetic asks for offsets
 * several times per day of every clock - a report over a few hundred
 * tickets spent over a second here before this cache.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
/** Offsets by zone and quarter hour: no zone changes offset inside one. */
const offsets = new Map<string, number>();

/** The offset of `timeZone` from UTC at an instant, in minutes. */
function offsetMinutes(at: Date, timeZone: string): number {
  const bucket = timeZone + '|' + Math.floor(at.getTime() / (15 * MINUTE));
  const known = offsets.get(bucket);
  if (known !== undefined) return known;
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const minutes = Math.round((asUtc - at.getTime()) / MINUTE);
  // Bounded: a long-running process must not grow it for ever.
  if (offsets.size > 50_000) offsets.clear();
  offsets.set(bucket, minutes);
  return minutes;
}

/** The instant a wall-clock time in `timeZone` names. Correct across DST. */
function zoned(year: number, month: number, day: number, minutes: number, timeZone: string): Date {
  const guess = Date.UTC(year, month, day, 0, minutes);
  const first = guess - offsetMinutes(new Date(guess), timeZone) * MINUTE;
  // Once more at the result: the offset can differ either side of a change.
  return new Date(guess - offsetMinutes(new Date(first), timeZone) * MINUTE);
}

/** The local calendar date of an instant in `timeZone`. */
function localDate(at: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(at.getTime() + offsetMinutes(at, timeZone) * MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when the string is a time zone this runtime knows. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Business time
// ---------------------------------------------------------------------------

/**
 * `start` plus `minutes` of business time.
 *
 * Walks forward a working day at a time, spending the minutes inside each
 * day's window. Bounded, so a calendar with no working days returns rather
 * than loops: such a target is simply never due.
 */
/** Whether a local date is a day off: "2026-12-24" that day, "12-25" every year. */
function isHoliday(d: { year: number; month: number; day: number }, holidays: readonly string[] | undefined): boolean {
  if (!holidays || holidays.length === 0) return false;
  // localDate's month is 0-based, as Date's is.
  const md = String(d.month + 1).padStart(2, '0') + '-' + String(d.day).padStart(2, '0');
  return holidays.includes(md) || holidays.includes(d.year + '-' + md);
}

/** Business minutes between two moments: the inverse of addBusinessMinutes. */
export function businessMinutesBetween(from: Date, to: Date, cal: SlaSettings): number {
  if (to <= from) return 0;
  const open = clockMinutes(cal.start);
  const close = clockMinutes(cal.end);
  if (close <= open || cal.days.length === 0) return 0;
  let total = 0;
  let cursor = from;
  for (let i = 0; i < 800 && cursor < to; i += 1) {
    const d = localDate(cursor, cal.timeZone);
    if (cal.days.includes(d.weekday) && !isHoliday(d, cal.holidays)) {
      const windowStart = zoned(d.year, d.month, d.day, open, cal.timeZone);
      const windowEnd = zoned(d.year, d.month, d.day, close, cal.timeZone);
      const a = cursor > windowStart ? cursor : windowStart;
      const b = to < windowEnd ? to : windowEnd;
      if (b > a) total += b.getTime() - a.getTime();
    }
    cursor = zoned(d.year, d.month, d.day + 1, 0, cal.timeZone);
  }
  return Math.round(total / MINUTE);
}

export function addBusinessMinutes(start: Date, minutes: number, cal: SlaSettings): Date {
  const open = clockMinutes(cal.start);
  const close = clockMinutes(cal.end);
  if (close <= open || cal.days.length === 0) return new Date(8_640_000_000_000_000);

  let left = minutes * MINUTE;
  let cursor = start;
  for (let i = 0; i < 800; i += 1) {
    const d = localDate(cursor, cal.timeZone);
    if (cal.days.includes(d.weekday) && !isHoliday(d, cal.holidays)) {
      const windowStart = zoned(d.year, d.month, d.day, open, cal.timeZone);
      const windowEnd = zoned(d.year, d.month, d.day, close, cal.timeZone);
      const from = cursor > windowStart ? cursor : windowStart;
      if (from < windowEnd) {
        const available = windowEnd.getTime() - from.getTime();
        if (left <= available) return new Date(from.getTime() + left);
        left -= available;
      }
    }
    // Midnight of the next local day.
    cursor = zoned(d.year, d.month, d.day + 1, 0, cal.timeZone);
  }
  return new Date(8_640_000_000_000_000);
}

// ---------------------------------------------------------------------------
// A ticket's clocks
// ---------------------------------------------------------------------------

/**
 * When somebody other than the requester first answered: a public comment,
 * or a status change by a person. Internal notes do not count - the
 * requester cannot see them - and neither does anything automatic: an
 * automation acts as a real account, so what it writes is marked
 * `automatic` (asAutomatic in events.ts) and skipped here.
 */
export async function firstResponseAt(ticket: { id: string; requester_id: string }): Promise<Date | null> {
  const row = await queryOne<{ at: string | null }>(
    `SELECT min(at) AS at FROM (
       SELECT min(created_at) AS at FROM ticket_comments
        WHERE ticket_id = ? AND is_internal = 0 AND automatic = 0 AND author_id <> ?
       UNION ALL
       SELECT min(created_at) AS at FROM ticket_events
        WHERE ticket_id = ? AND kind = 'field_changed' AND field = 'status'
          AND actor_id IS NOT NULL AND actor_id <> ? AND automatic = 0
     )`,
    [ticket.id, ticket.requester_id, ticket.id, ticket.requester_id],
  );
  return row?.at ? new Date(row.at) : null;
}

/**
 * The periods a ticket spent on hold, from its status history; one still
 * running ends now.
 */
export async function holdPeriods(ticketId: string, now: Date): Promise<{ from: Date; to: Date }[]> {
  const changes = await query<StatusChange>(
    `SELECT old_value, new_value, created_at FROM ticket_events
      WHERE ticket_id = ? AND kind = 'field_changed' AND field = 'status' ORDER BY created_at`,
    [ticketId],
  );
  return holdPeriodsFrom(changes, now);
}

export interface StatusChange {
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

/** The on-hold periods in a ticket's status changes, oldest first. */
export function holdPeriodsFrom(changes: StatusChange[], now: Date): { from: Date; to: Date }[] {
  const periods: { from: Date; to: Date }[] = [];
  let since: Date | null = null;
  for (const c of changes) {
    if (c.new_value === 'pending' && since === null) since = new Date(c.created_at);
    else if (c.old_value === 'pending' && since !== null) {
      periods.push({ from: since, to: new Date(c.created_at) });
      since = null;
    }
  }
  if (since !== null) periods.push({ from: since, to: now });
  return periods;
}

/** The last fifth of a target counts as "at risk". */
const AT_RISK_SHARE = 0.2;

function clock(start: Date, due: Date, doneAt: Date | null, now: Date): SlaClock {
  if (doneAt) return { due, doneAt, state: doneAt <= due ? 'met' : 'breached' };
  if (now > due) return { due, doneAt: null, state: 'breached' };
  const total = due.getTime() - start.getTime();
  const left = due.getTime() - now.getTime();
  return { due, doneAt: null, state: total > 0 && left / total <= AT_RISK_SHARE ? 'at_risk' : 'due' };
}

/**
 * Both clocks for one ticket, or null when SLA is off or does not apply - a
 * cancelled ticket was withdrawn, and a task is measured through its parent.
 */
export async function slaFor(
  ticket: {
    id: string;
    requester_id: string;
    priority: TicketPriority;
    status: TicketStatus;
    created_at: string;
    resolved_at: string | null;
    closed_at: string | null;
    parent_id?: string | null;
  },
  now: Date = new Date(),
): Promise<TicketSla | null> {
  const cal = settings().sla;
  if (!cal.enabled || ticket.status === 'cancelled' || ticket.parent_id) return null;
  const responded = await firstResponseAt(ticket);
  const changes = cal.pauseOnHold
    ? await query<StatusChange>(
        `SELECT old_value, new_value, created_at FROM ticket_events
          WHERE ticket_id = ? AND kind = 'field_changed' AND field = 'status' ORDER BY created_at`,
        [ticket.id],
      )
    : [];
  return slaFromFacts(ticket, responded, changes, now);
}

/**
 * The same clocks, from facts already loaded: the first response and the
 * status changes (oldest first). Reports load these for every ticket in two
 * queries rather than two per ticket.
 */
export function slaFromFacts(
  ticket: {
    priority: TicketPriority;
    status: TicketStatus;
    created_at: string;
    resolved_at: string | null;
    closed_at: string | null;
    parent_id?: string | null;
  },
  responded: Date | null,
  changes: StatusChange[],
  now: Date = new Date(),
): TicketSla | null {
  const cal = settings().sla;
  if (!cal.enabled || ticket.status === 'cancelled' || ticket.parent_id) return null;

  const target = cal.targets[ticket.priority];
  const created = new Date(ticket.created_at);
  const resolved = ticket.resolved_at
    ? new Date(ticket.resolved_at)
    : ticket.closed_at
      ? new Date(ticket.closed_at)
      : null;

  // On hold: the business time spent waiting is added to the resolution
  // target, and while it waits the clock says so instead of running down.
  let held = 0;
  if (cal.pauseOnHold) {
    for (const p of holdPeriodsFrom(changes, resolved ?? now)) held += businessMinutesBetween(p.from, p.to, cal);
  }
  const resolution = clock(created, addBusinessMinutes(created, target.resolution + held, cal), resolved, now);
  return {
    response: clock(created, addBusinessMinutes(created, target.response, cal), responded ?? resolved, now),
    resolution:
      cal.pauseOnHold && !resolved && ticket.status === 'pending' ? { ...resolution, state: 'paused' } : resolution,
  };
}

export const SLA_STATE_LABELS: Record<SlaState, string> = {
  met: 'Met',
  breached: 'Breached',
  due: 'On track',
  at_risk: 'At risk',
  paused: 'Paused while on hold',
};

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/**
 * Each ticket's first response and status changes, for many tickets at once:
 * the first public comment by somebody other than the requester, and every
 * status change (the first by somebody other than the requester is also a
 * response - as in firstResponseAt()). Two queries per 500 tickets, never two
 * per ticket: Reports and the ticket list's SLA filter both read it.
 */
export async function loadSlaFacts(tickets: readonly { id: string; requester_id: string }[]): Promise<Map<string, { responded: Date | null; changes: StatusChange[] }>> {
  const facts = new Map<string, { responded: Date | null; changes: (StatusChange & { actor_id: string | null; automatic: boolean })[] }>();
  for (const t of tickets) facts.set(t.id, { responded: null, changes: [] });
  const requesterOf = new Map(tickets.map((t) => [t.id, t.requester_id]));
  for (let i = 0; i < tickets.length; i += 500) {
    const ids = tickets.slice(i, i + 500).map((t) => t.id);
    const comments = await query<{ ticket_id: string; author_id: string; created_at: string }>(
      `SELECT ticket_id, author_id, created_at FROM ticket_comments
        WHERE is_internal = 0 AND automatic = 0 AND ticket_id IN (${marks(ids.length)}) ORDER BY created_at`,
      ids,
    );
    for (const c of comments) {
      const f = facts.get(c.ticket_id)!;
      if (!f.responded && c.author_id !== requesterOf.get(c.ticket_id)) f.responded = new Date(c.created_at);
    }
    const events = await query<StatusChange & { ticket_id: string; actor_id: string | null; automatic: boolean }>(
      `SELECT ticket_id, actor_id, automatic, old_value, new_value, created_at FROM ticket_events
        WHERE kind = 'field_changed' AND field = 'status' AND ticket_id IN (${marks(ids.length)}) ORDER BY created_at`,
      ids,
    );
    for (const e of events) facts.get(e.ticket_id)!.changes.push(e);
  }
  for (const [id, f] of facts) {
    // Every status change counts for time on hold; only a person's is a response.
    const byStaff = f.changes.find((e) => e.actor_id && e.actor_id !== requesterOf.get(id) && !e.automatic);
    if (byStaff && (!f.responded || new Date(byStaff.created_at) < f.responded)) f.responded = new Date(byStaff.created_at);
  }
  return facts;
}


/** The ticket list's SLA filter. */
export const SLA_FILTERS = ['attention', 'breached', 'at_risk', 'on_track'] as const;
export type SlaFilter = (typeof SLA_FILTERS)[number];

/**
 * Whether a ticket's clocks match the filter. Breached means either target
 * missed - finished late, or still running past it - as on Reports; at risk
 * means a clock still running in its last fifth, with none breached; on
 * track is everything else that has a clock.
 */
export function slaMatches(sla: TicketSla, filter: SlaFilter): boolean {
  const clocks = [sla.response, sla.resolution];
  const breached = clocks.some((c) => c.state === 'breached');
  const atRisk = !breached && clocks.some((c) => !c.doneAt && c.state === 'at_risk');
  if (filter === 'breached') return breached;
  if (filter === 'at_risk') return atRisk;
  if (filter === 'attention') return breached || atRisk;
  return !breached && !atRisk;
}
