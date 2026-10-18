import type { Request } from 'express';
import { execute } from '../db/index.js';
import { newId, nowIso } from './util.js';
import { logger } from './logger.js';
import { sealText } from './field-crypto.js';

const log = logger.child({ module: 'audit' });

const INSERT = `
  INSERT INTO audit_log
    (id, created_at, actor_id, actor_email, action, outcome, target_type, target_id,
     ip, user_agent, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export interface AuditEntry {
  action: string;
  outcome?: 'success' | 'failure';
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Appends one entry to the audit trail.
 *
 * Deliberately fire-and-forget: auditing must never fail or delay the request
 * that triggered it, and every caller is on a path where the action has
 * already happened. A write that fails is reported to the log, which is the
 * one place left to say so.
 *
 * Use `auditAndWait` where a test or a shutdown path needs the row to exist
 * before it continues.
 */
/** Writes still on their way to the database, so they can be awaited. */
const inFlight = new Set<Promise<void>>();

export function audit(entry: AuditEntry): void {
  const write = auditAndWait(entry).finally(() => inFlight.delete(write));
  inFlight.add(write);
}

/**
 * Waits until every fire-and-forget audit write has reached the database.
 *
 * Used by the shutdown path, so a container that stops mid-request still
 * records what happened, and by tests that assert on the trail.
 */
export async function flushAudit(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight]);
  }
}

/** The same write, awaitable. */
export async function auditAndWait(entry: AuditEntry): Promise<void> {
  try {
    // Who, from where and the detail are personal data: encrypted at rest
    // (lib/field-crypto.ts). The action, outcome and target stay readable -
    // the trail is filtered by action.
    await execute(INSERT, [
      newId(),
      nowIso(),
      entry.actorId ?? null,
      sealText(entry.actorEmail ?? null),
      entry.action,
      entry.outcome ?? 'success',
      entry.targetType ?? null,
      entry.targetId ?? null,
      sealText(entry.ip ?? null),
      sealText(entry.userAgent ? entry.userAgent.slice(0, 300) : null),
      sealText(entry.detail ? JSON.stringify(entry.detail) : null),
    ]);
  } catch (err) {
    log.error({ err, action: entry.action }, 'failed to write audit entry');
  }
}

/** Audit entry enriched from the request: actor, client IP and user agent. */
export function auditRequest(req: Request, entry: AuditEntry): void {
  void auditRequestAndWait(req, entry);
}

export function auditRequestAndWait(req: Request, entry: AuditEntry): Promise<void> {
  const user = req.currentUser;
  return auditAndWait({
    ...entry,
    actorId: entry.actorId ?? user?.id ?? null,
    actorEmail: entry.actorEmail ?? user?.email ?? null,
    ip: entry.ip ?? req.ip ?? null,
    userAgent: entry.userAgent ?? req.get('user-agent') ?? null,
  });
}
