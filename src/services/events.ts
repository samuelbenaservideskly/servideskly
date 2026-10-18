import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../lib/logger.js';
import type { AppliedChange } from './tickets.js';

const log = logger.child({ module: 'events' });

/**
 * Ticket events, for whoever wants to react to them - today, automations.
 *
 * The ticket service announces; it does not know who listens. That keeps the
 * import graph one-way (an automation acts on tickets, so tickets importing
 * automations would be a cycle - trap 4) and makes every way a ticket
 * changes - the web form, an email, the API of a later day - announce the
 * same events.
 *
 * Announced **after** the write commits, and awaited, so a listener sees the
 * saved ticket and a test sees the outcome. A listener that fails is logged
 * and skipped: a broken automation must never undo or block the change that
 * set it off.
 */
export type TicketEvent =
  | { kind: 'ticket.created'; ticketId: string; actorId: string | null }
  | { kind: 'ticket.updated'; ticketId: string; actorId: string | null; changes: AppliedChange[] }
  | { kind: 'comment.added'; ticketId: string; actorId: string | null; isInternal: boolean }
  // Found by the SLA sweep, not by a change: nobody did anything, which is the point.
  | { kind: 'sla.breached'; ticketId: string; actorId: null; clock: 'response' | 'resolution' };

type Listener = (event: TicketEvent) => Promise<void>;

const listeners: Listener[] = [];

/** Registers a listener once; the same function twice is ignored. */
export function onTicketEvent(listener: Listener): void {
  if (!listeners.includes(listener)) listeners.push(listener);
}

/**
 * Marks work done *by* an automation. Changes made inside it still happen and
 * are still recorded, but they announce nothing - otherwise "when a ticket
 * changes, change it" would chase its own tail.
 */
const quiet = new AsyncLocalStorage<true>();

export function withoutEvents<T>(work: () => Promise<T>): Promise<T> {
  return quiet.run(true, work);
}

/**
 * Marks what is written as automatic: an automation's run, or the service
 * desk closing a ticket by itself. Comments and events written inside carry
 * `automatic = 1`, and none of them is a first response (services/sla.ts) -
 * an automation acts as a real account, so the author alone cannot tell.
 */
const automaticWork = new AsyncLocalStorage<true>();

export function asAutomatic<T>(work: () => Promise<T>): Promise<T> {
  return automaticWork.run(true, work);
}

export function isAutomatic(): boolean {
  return automaticWork.getStore() === true;
}

export async function announce(event: TicketEvent): Promise<void> {
  if (quiet.getStore()) return;
  for (const listener of listeners) {
    try {
      await listener(event);
    } catch (err) {
      log.error({ err, event: event.kind, ticketId: event.ticketId }, 'a ticket event listener failed');
    }
  }
}
