import { execute, query } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/util.js';
import { settings } from '../settings/index.js';
import { announce } from './events.js';
import { notifyTicket } from './mail/outbox.js';
import { slaFor } from './sla.js';
import { getTicketById } from './tickets.js';

const log = logger.child({ module: 'sla-alerts' });

const CLOCK_WORDS = { response: 'first response', resolution: 'resolution' } as const;

/**
 * Tells group managers about breaches. A sweep, like auto-close: one query
 * for the tickets that could be late, and a restart cannot lose an alarm that
 * only existed in memory. Each (ticket, clock) is told once - the row in
 * sla_notifications is written before the mail is queued, so a crash between
 * the two errs on the side of one missed email rather than a repeat.
 *
 * Only tickets that are still open and routed to a group with a manager:
 * there is nobody else this alert is for.
 */
/** A breach older than this when first seen is recorded but starts nothing. */
const ANNOUNCE_WITHIN_MS = 24 * 60 * 60_000;

/**
 * The "SLA is breached" automation trigger: every open ticket, each clock
 * that has run out, announced once (sla_breaches is written first, like
 * sla_notifications).
 *
 * A breach first seen more than a day after it happened is recorded quietly.
 * Otherwise the first sweep after SLA - or this trigger - is switched on
 * would start an automation for every ticket that ever ran late.
 */
export async function announceSlaBreaches(now: Date = new Date()): Promise<number> {
  if (!settings().sla.enabled) return 0;
  const candidates = await query<{ id: string }>(
    `SELECT t.id FROM tickets t
      WHERE t.parent_id IS NULL
        AND t.status IN ('open', 'in_progress', 'pending')`,
  );
  let announced = 0;
  for (const { id } of candidates) {
    const ticket = await getTicketById(id);
    if (!ticket) continue;
    const clocks = await slaFor(ticket, now);
    if (!clocks) continue;
    for (const key of ['response', 'resolution'] as const) {
      const c = clocks[key];
      if (c.state !== 'breached' || c.doneAt) continue;
      const claimed = await execute(
        'INSERT INTO sla_breaches (ticket_id, clock, detected_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [id, key, nowIso()],
      );
      if (claimed === 0 || now.getTime() - c.due.getTime() > ANNOUNCE_WITHIN_MS) continue;
      await announce({ kind: 'sla.breached', ticketId: id, actorId: null, clock: key });
      announced += 1;
    }
  }
  return announced;
}

export async function notifySlaBreaches(now: Date = new Date()): Promise<number> {
  const sla = settings().sla;
  if (!sla.enabled || !sla.notifyManager) return 0;

  const candidates = await query<{ id: string }>(
    `SELECT t.id FROM tickets t
       JOIN technician_groups g ON g.id = t.group_id
      WHERE EXISTS (SELECT 1 FROM technician_group_managers gm WHERE gm.group_id = g.id)
        AND t.parent_id IS NULL
        AND t.status IN ('open', 'in_progress', 'pending')`,
  );

  let sent = 0;
  for (const { id } of candidates) {
    const ticket = await getTicketById(id);
    if (!ticket) continue;
    const clocks = await slaFor(ticket, now);
    if (!clocks) continue;
    for (const key of ['response', 'resolution'] as const) {
      const c = clocks[key];
      if (c.state !== 'breached' || c.doneAt) continue;
      const claimed = await execute(
        'INSERT INTO sla_notifications (ticket_id, clock, notified_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [id, key, nowIso()],
      );
      if (claimed === 0) continue;
      try {
        await notifyTicket('ticket.sla.breached', id, {
          slaClock: CLOCK_WORDS[key],
          slaDue: c.due.toISOString(),
        });
        sent += 1;
      } catch (err) {
        log.warn({ err, ticketId: id, clock: key }, 'SLA breach notification could not be queued');
      }
    }
  }
  return sent;
}
