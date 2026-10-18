import type { NextFunction, Request, Response } from 'express';
import { queryOne } from '../db/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'last-change' });

/**
 * "Last changed 5 minutes ago by admin@local" on every settings page.
 *
 * It used to be the time the one settings document was last saved, shown on
 * every page alike - so saving Locale "changed" the Users page, and editing a
 * template, which lives in its own table, changed nothing at all. Now each
 * page asks the audit trail: the newest successful entry among the actions
 * that change *what this page shows*.
 *
 * One table, longest path first. A detail page (one user, one template, one
 * portal) narrows further to entries about that item, by target id.
 */
interface PageRule {
  /** Path under /admin/settings, matched as a prefix. */
  path: string;
  /** Audit actions that change this page, as prefixes ('template.' ...). */
  actions: string[];
  /** A detail page: only entries whose target is the id in the URL. */
  byTarget?: boolean;
  /** Portal pages: which kind of design the target must be. */
  portalKind?: 'requester' | 'approval';
}

const USER_ACTIONS = [
  'user.role.',
  'user.status.',
  'user.groups.',
  'user.profile.',
  'local_account.created',
  'local_account.deleted',
  'local_account.disabled',
  'local_account.email.',
  'local_account.imported',
  'local_account.password.reset',
];

const RULES: PageRule[] = [
  { path: '/integrations/entra/authentication', actions: ['settings.oidc.', 'settings.secret.'] },
  {
    path: '/integrations/entra/provisioning',
    actions: ['settings.provisioning.', 'settings.scim.', 'scim.token.'],
  },
  {
    path: '/integrations',
    actions: ['settings.oidc.', 'settings.secret.', 'settings.provisioning.', 'settings.scim.', 'scim.token.'],
  },
  { path: '/users/entra', actions: [...USER_ACTIONS, 'scim.user.', 'user.provisioned.'] },
  { path: '/users/', actions: USER_ACTIONS, byTarget: true },
  { path: '/users', actions: [...USER_ACTIONS, 'settings.local_signin.'] },
  { path: '/groups/users/', actions: ['user_group.'], byTarget: true },
  { path: '/groups/users', actions: ['user_group.'] },
  { path: '/groups/', actions: ['group.'], byTarget: true },
  { path: '/groups', actions: ['group.'] },
  { path: '/templates/categories', actions: ['category.'] },
  // Other settings is one page now, so its line covers everything
  // decided on it: the prefixes, the service levels, the status notes and
  // how long a closed ticket is kept.
  {
    path: '/templates/other',
    actions: [
      'settings.ticket_prefixes.',
      'settings.sla.',
      'settings.cancel_note.',
      'settings.resolve_note.',
      'settings.ticket_retention.',
    ],
  },
  { path: '/templates/catalogue', actions: ['settings.catalogue.'] },
  { path: '/templates/', actions: ['template.'], byTarget: true },
  { path: '/templates', actions: ['template.'] },
  { path: '/mail/approval/', actions: ['portal.'], byTarget: true, portalKind: 'approval' },
  { path: '/mail/approval', actions: ['portal.'], portalKind: 'approval' },
  { path: '/mail/notifications/', actions: ['mail.notification.'], byTarget: true },
  { path: '/mail/notifications', actions: ['mail.notification.'] },
  { path: '/mail/automation', actions: ['settings.mail_automation.'] },
  { path: '/mail/relay', actions: ['settings.smtp_relay.'] },
  { path: '/mail/advanced/rules', actions: ['mail.rule.'] },
  { path: '/mail/advanced/signatures', actions: ['settings.mail_automation.phrase'] },
  { path: '/mail', actions: ['mailbox.'] },
  { path: '/customization/attachments', actions: ['settings.attachments.'] },
  { path: '/customization/portal/', actions: ['portal.'], byTarget: true, portalKind: 'requester' },
  { path: '/customization/portal', actions: ['portal.'], portalKind: 'requester' },
  { path: '/customization/images', actions: ['custom_image.'] },
  { path: '/customization/locale', actions: ['settings.locale.'] },
  { path: '/advanced/automation/', actions: ['automation.'], byTarget: true },
  { path: '/advanced/automation', actions: ['automation.', 'settings.http_requests.'] },
  { path: '/advanced/connections', actions: ['automation_connection.'] },
  { path: '/advanced', actions: ['settings.portal_scripts.'] },
  { path: '/dashboards/locations', actions: ['location.'] },
  { path: '/dashboards', actions: ['dashboard.'] },
  { path: '/customization', actions: ['settings.branding.'] },
];

export interface LastChange {
  at: string;
  /** An email address, or null when the system did it. */
  by: string | null;
}

/** The rule for a path under /admin/settings, longest match first. */
function ruleFor(path: string): PageRule | undefined {
  // A rule ending in / is a detail page and needs something after it.
  return RULES.filter((r) =>
    r.path.endsWith('/') ? path.startsWith(r.path) : path === r.path || path.startsWith(r.path + '/'),
  ).sort((a, b) => b.path.length - a.path.length)[0];
}

/** The id a detail page is about: the first path segment after the rule's. */
function targetOf(path: string, rule: PageRule): string | null {
  const rest = path.slice(rule.path.length).split('/')[0] ?? '';
  return rest !== '' ? decodeURIComponent(rest) : null;
}

export async function lastChangeFor(path: string): Promise<LastChange | null> {
  const rule = ruleFor(path);
  if (!rule) return null;

  // Conditions and parameters pushed together, so the positional ? cannot
  // drift from its value (trap 1).
  const where: string[] = ["a.outcome = 'success'"];
  const params: unknown[] = [];
  // Each action is a prefix; its own _ and % are escaped to match literally.
  where.push('(' + rule.actions.map(() => "a.action LIKE ? ESCAPE '\\'").join(' OR ') + ')');
  params.push(...rule.actions.map((a) => a.replace(/[\\%_]/g, (c) => '\\' + c) + '%'));

  if (rule.byTarget) {
    const target = targetOf(path, rule);
    if (!target) return null;
    where.push('a.target_id = ?');
    params.push(target);
  }
  if (rule.portalKind) {
    // 'standard' is the built-in design, which is every kind's.
    where.push(
      "(a.target_id = 'standard' OR a.target_id IN (SELECT id FROM portal_themes WHERE kind = ?))",
    );
    params.push(rule.portalKind);
  }

  const row = await queryOne<{ at: string; by: string | null }>(
    `SELECT a.created_at AS at, COALESCE(a.actor_email, u.email) AS by
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE ` + where.join(' AND ') + `
      ORDER BY a.created_at DESC
      LIMIT 1`,
    params,
  );
  return row ? { at: row.at, by: row.by } : null;
}

/** Sets res.locals.lastChange for the settings page about to render. */
export function lastChangeLocal() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    lastChangeFor(req.path)
      .then((change) => {
        res.locals.lastChange = change;
      })
      .catch((err: unknown) => {
        // A missing "last changed" line is not worth a broken page.
        log.warn({ err, path: req.path }, 'could not read the last change');
        res.locals.lastChange = null;
      })
      .finally(() => next());
  };
}
