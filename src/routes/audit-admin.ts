import { Router } from 'express';
import { z } from 'zod';
import { count, query } from '../db/index.js';
import { asyncHandler } from '../lib/async-handler.js';
import { settingsView } from './settings-shared.js';

/**
 * The audit trail, as a settings section.
 *
 * Its own module rather than part of admin.ts: admin.ts mounts the settings
 * router, and the settings router mounts this, so sharing a file would be a
 * cycle - and in ESM a cycle here is a TDZ crash at start-up, not a warning.
 */
// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

const PER_PAGE = 50;

const auditQuery = z.object({
  action: z.string().trim().max(100).optional(),
  outcome: z.enum(['success', 'failure', 'any']).default('any'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

interface AuditRow {
  id: string;
  created_at: string;
  actor_email: string | null;
  action: string;
  outcome: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  detail: string | null;
}

export const auditRouter = Router();

auditRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = auditQuery.safeParse(req.query);
    const filters = parsed.success ? parsed.data : auditQuery.parse({});

    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.action) {
      where.push("action LIKE ? ESCAPE '\\'");
      params.push(filters.action.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    }
    if (filters.outcome !== 'any') {
      where.push('outcome = ?');
      params.push(filters.outcome);
    }

    const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';

    const total = await count('SELECT count(*) AS c FROM audit_log' + whereSql, params);
    const pageCount = Math.max(Math.ceil(total / PER_PAGE), 1);
    const page = Math.min(filters.page, pageCount);

    const entries = await query<AuditRow>(
      `SELECT id, created_at, actor_email, action, outcome, target_type, target_id, ip, detail
         FROM audit_log` +
        whereSql +
        ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      [...params, PER_PAGE, (page - 1) * PER_PAGE],
    );

    const actionRows = await query<{ action: string }>(
      'SELECT DISTINCT action FROM audit_log ORDER BY action',
    );

    res.render(
      'admin/settings/audit',
      settingsView('audit', {
        entries,
        total,
        page,
        pageCount,
        filters,
        actionGroups: groupActions(actionRows.map((r) => r.action), filters.action ?? ''),
      }),
    );
  }),
);

/** Readable names for the first part of an action, the area it belongs to. */
const AREA_LABELS: Record<string, string> = {
  auth: 'Sign-in',
  authz: 'Access',
  automation: 'Automation',
  category: 'Categories',
  custom_image: 'Custom images',
  group: 'Technician groups',
  local_account: 'Local accounts',
  local_admin: 'Local administrator',
  mail: 'Mail',
  mailbox: 'Mailboxes',
  portal: 'Portals',
  request: 'Requests',
  scim: 'SCIM',
  settings: 'Settings',
  template: 'Templates',
  ticket: 'Tickets',
  user: 'Users',
  user_group: 'User groups',
};

/** "login.success" -> "Login success". */
function humanise(rest: string): string {
  const words = rest.replace(/[._]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

export interface ActionGroup {
  label: string;
  /** The prefix that selects the whole area, e.g. "ticket." */
  prefix: string;
  actions: { value: string; label: string }[];
}

/**
 * The Action filter as a grouped dropdown rather than a free-text box with a
 * datalist - which every browser draws its own way and none lets a page
 * style. The filter matches by prefix, so "All tickets" is just "ticket.".
 * A value in the address that is not in the list is kept, so an old link
 * still shows what it filters on.
 */
function groupActions(actions: string[], current: string): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  for (const action of actions) {
    const dot = action.indexOf('.');
    const area = dot > 0 ? action.slice(0, dot) : action;
    if (!groups.has(area)) {
      groups.set(area, { label: AREA_LABELS[area] ?? humanise(area), prefix: area + '.', actions: [] });
    }
    groups.get(area)!.actions.push({ value: action, label: humanise(dot > 0 ? action.slice(dot + 1) : action) });
  }
  const list = Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
  const known = list.some((g) => g.prefix === current || g.actions.some((a) => a.value === current));
  if (current && !known) {
    list.unshift({ label: 'Current filter', prefix: '', actions: [{ value: current, label: current }] });
  }
  return list;
}
