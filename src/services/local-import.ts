import type { Role } from '../config.js';
import { queryOne } from '../db/index.js';
import { csvField, parseCsv } from '../lib/csv.js';
import { normaliseEmail, normaliseLine } from '../lib/util.js';
import { createLocalAccount, isEmailAddress } from '../auth/local-accounts.js';
import { setProfileAttributes } from './users.js';
import { generatePassword, passwordProblems } from '../auth/password.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { settings } from '../settings/index.js';
import { queueMail, sendSoon } from './mail/outbox.js';
import { defaultMailbox } from './mail/mailboxes.js';
import { relayForGroup } from './mail/relay.js';
import { ADMINS_IN_PORTAL, portalManagesAdmins } from '../auth/portal-admins.js';

const importLog = logger.child({ module: 'local-import' });

/**
 * Creating password accounts from a spreadsheet.
 *
 * Settings - Users - Local users. The file is checked whole before anything
 * is written: a sheet with one bad row creates nobody, so fixing that row and
 * uploading again is the whole of the recovery - there is no half-imported
 * state to reason about. An address that already has an account is skipped
 * rather than refused, so uploading the same sheet twice is harmless.
 *
 * A role in the sheet is honoured. That is not the directory deciding a
 * role - it is an administrator, in Settings, which is where roles are set.
 */

export const IMPORT_COLUMNS = [
  'email',
  'first_name',
  'last_name',
  'display_name',
  'company',
  'role',
  'password',
  'phone',
  'department',
  'job_title',
  'office',
  'extension_attribute_1',
  'extension_attribute_2',
  'extension_attribute_3',
] as const;

/** The columns that describe the person; an empty cell leaves it empty. */
const ATTRIBUTE_COLUMNS = ['first_name', 'last_name', 'company', 'phone', 'department', 'job_title', 'office', 'extension_attribute_1', 'extension_attribute_2', 'extension_attribute_3'] as const;
type AttributeColumn = (typeof ATTRIBUTE_COLUMNS)[number];

/** Enough for a department; a larger sheet is several uploads. */
export const MAX_IMPORT_ROWS = 500;

/** The file offered for download: the header and two rows to overwrite. */
export function importTemplateCsv(): string {
  const lines = [
    IMPORT_COLUMNS.join(','),
    ['jana.novakova@example.com', 'Jana', 'Nováková', 'Jana Nováková', 'Contoso', 'user', '', '+420 123 456 789', 'Finance', 'Accountant', 'Prague', '', '', ''].map(csvField).join(','),
    ['petr.svoboda@example.com', 'Petr', 'Svoboda', '', 'Contoso', 'agent', '', '', 'IT', '', 'Brno', '', '', ''].map(csvField).join(','),
  ];
  // The byte-order mark is what makes Excel read the file as UTF-8, so a
  // name with a háček survives the round trip.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const ROLE_WORDS: Record<string, Role> = {
  '': 'user',
  user: 'user',
  requester: 'user',
  agent: 'agent',
  technician: 'agent',
  admin: 'admin',
  administrator: 'admin',
};

/** Column name as typed -> ours. "Display name", "display_name", "Name". */
function columnKey(header: string): string {
  const key = header.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'email' || key === 'emailaddress' || key === 'mail') return 'email';
  if (key === 'displayname' || key === 'name' || key === 'fullname') return 'display_name';
  if (key === 'role') return 'role';
  if (key === 'firstname' || key === 'givenname' || key === 'first') return 'first_name';
  if (key === 'lastname' || key === 'surname' || key === 'familyname' || key === 'last') return 'last_name';
  if (key === 'company' || key === 'companyname' || key === 'organisation' || key === 'organization') return 'company';
  if (key === 'password') return 'password';
  if (key === 'phone' || key === 'telephone' || key === 'phonenumber' || key === 'mobile') return 'phone';
  if (key === 'department') return 'department';
  if (key === 'jobtitle' || key === 'title') return 'job_title';
  if (key === 'office' || key === 'location') return 'office';
  const ext = /^extension(?:attribute)?([123])$/.exec(key);
  if (ext) return 'extension_attribute_' + ext[1];
  return '';
}

export interface ImportRow {
  line: number;
  email: string;
  displayName: string;
  role: Role;
  /** Empty means "generate one". */
  password: string;
  /** Only the columns the sheet filled in. */
  attributes: Partial<Record<AttributeColumn, string>>;
}

export interface ImportPlan {
  create: ImportRow[];
  /** Addresses that already have an account, left as they are. */
  skipped: string[];
  /** Why the file cannot be imported. Non-empty means nothing is created. */
  problems: string[];
}

/** Reads and checks a sheet. Writes nothing. */
export async function planImport(text: string): Promise<ImportPlan> {
  const plan: ImportPlan = { create: [], skipped: [], problems: [] };
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) {
    plan.problems.push('The file is empty.');
    return plan;
  }

  const index: Record<string, number> = {};
  header.forEach((h, i) => {
    const key = columnKey(h);
    if (key && index[key] === undefined) index[key] = i;
  });
  if (index.email === undefined) {
    plan.problems.push(
      'The first line must name the columns, and one of them must be "email". ' +
        'Download the template to see the layout.',
    );
    return plan;
  }
  if (rows.length === 0) plan.problems.push('There are no accounts in the file, only the header.');
  if (rows.length > MAX_IMPORT_ROWS) {
    plan.problems.push(
      'At most ' + MAX_IMPORT_ROWS + ' accounts per file; this one has ' + rows.length + '.',
    );
    return plan;
  }

  const cell = (row: string[], key: string) =>
    index[key] === undefined ? '' : normaliseLine(row[index[key]!] ?? '');
  const seen = new Set<string>();

  for (const [i, row] of rows.entries()) {
    const line = i + 2;
    const email = normaliseEmail(cell(row, 'email'));
    const where = 'Line ' + line + ': ';

    if (!isEmailAddress(email)) {
      plan.problems.push(where + '"' + (email || '(blank)') + '" is not an email address.');
      continue;
    }
    if (email.endsWith('@example.com')) {
      plan.problems.push(where + 'replace the example row (' + email + ') with a real person.');
      continue;
    }
    if (seen.has(email)) {
      plan.problems.push(where + email + ' appears twice in the file.');
      continue;
    }
    seen.add(email);

    const roleWord = cell(row, 'role').toLowerCase();
    const role = ROLE_WORDS[roleWord];
    if (!role) {
      plan.problems.push(where + 'the role must be user, agent or admin, not "' + roleWord + '".');
      continue;
    }
    if (role === 'admin' && portalManagesAdmins()) {
      plan.problems.push(where + ADMINS_IN_PORTAL);
      continue;
    }

    const password = index.password === undefined ? '' : (row[index.password] ?? '');
    if (password !== '') {
      const weak = passwordProblems(password, { email });
      if (weak.length > 0) {
        plan.problems.push(where + weak[0]!.message);
        continue;
      }
    }

    const taken = await queryOne<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE u.email = ?
           OR u.id IN (SELECT user_id FROM local_credentials WHERE username = ?)`,
      [email, email],
    );
    if (taken) {
      plan.skipped.push(email);
      continue;
    }

    // No display name: the first and last name, else the address's local part.
    const fromParts = [cell(row, 'first_name'), cell(row, 'last_name')].filter(Boolean).join(' ');
    const displayName = (cell(row, 'display_name') || fromParts).slice(0, 120) || email.split('@')[0]!;
    const attributes: Partial<Record<AttributeColumn, string>> = {};
    for (const column of ATTRIBUTE_COLUMNS) {
      const value = cell(row, column);
      if (value) attributes[column] = value.slice(0, column === 'phone' ? 40 : column === 'first_name' || column === 'last_name' ? 100 : 200);
    }
    plan.create.push({ line, email, displayName, role, password, attributes });
  }
  return plan;
}

export interface ImportedAccount {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  /** Set only when it was generated here; shown once, never stored readable. */
  generatedPassword: string | null;
  /** Whether the temporary password was queued to them. */
  mailed: boolean;
}

/** Mails one new account the password this import made for it. */
async function mailTemporaryPassword(
  account: { email: string; displayName: string },
  password: string,
): Promise<boolean> {
  const options = settings().smtpRelay;
  const relay = options.useForCodes || options.relaysOnly ? await relayForGroup(null) : undefined;
  const mailbox = relay ? undefined : await defaultMailbox();
  if (!relay && !mailbox) return false;

  const safe = (value: string): string => value.replace(/[<>&"]/g, '');
  const appName = safe(settings().branding.appName);

  await queueMail({
    mailboxId: mailbox?.id ?? null,
    ...(relay ? { viaRelay: true, relayId: relay.id } : {}),
    urgent: true,
    ticketId: null,
    to: account.email,
    subject: 'Your ' + appName + ' account',
    bodyHtml:
      '<p>An account has been created for you on ' + appName + '.</p>' +
      '<p>Sign in with <strong>' + safe(account.email) + '</strong> and this temporary password:</p>' +
      '<p style="font-size:18px"><strong>' + safe(password) + '</strong></p>' +
      '<p>You will be asked to choose your own password the first time you sign in.</p>' +
      '<p><a href="' + config.publicOrigin + '/login" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1a5d74;color:#ffffff;text-decoration:none;font-weight:bold">Sign in</a></p>',
  });
  return true;
}

/** Creates what planImport approved. Every password must be changed at first sign-in. */
export async function runImport(
  rows: readonly ImportRow[],
  actorId: string | null,
  options: { mailPassword?: boolean } = {},
): Promise<ImportedAccount[]> {
  const created: ImportedAccount[] = [];
  for (const row of rows) {
    const generated = row.password === '' ? generatePassword() : null;
    const user = await createLocalAccount(
      {
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        password: generated ?? row.password,
        mustChange: true,
        ...(row.attributes.first_name ? { firstName: row.attributes.first_name } : {}),
        ...(row.attributes.last_name ? { lastName: row.attributes.last_name } : {}),
        ...(row.attributes.company ? { company: row.attributes.company } : {}),
      },
      actorId,
    );
    const a = row.attributes;
    if (Object.keys(a).length > 0) {
      await setProfileAttributes(
        user.id,
        {
          department: a.department ?? '',
          jobTitle: a.job_title ?? '',
          office: a.office ?? '',
          phone: a.phone ?? '',
          extension1: a.extension_attribute_1 ?? '',
          extension2: a.extension_attribute_2 ?? '',
          extension3: a.extension_attribute_3 ?? '',
        },
        actorId,
      );
    }
    let mailed = false;
    if (options.mailPassword && generated) {
      try {
        mailed = await mailTemporaryPassword({ email: row.email, displayName: row.displayName }, generated);
      } catch (err) {
        // The account exists and its password is on the result page; a
        // mailbox that is down must not undo an import.
        importLog.warn({ err }, 'could not queue the temporary password for an imported account');
      }
    }

    created.push({
      userId: user.id,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      mailed,
      generatedPassword: generated,
    });
  }
  if (created.some((account) => account.mailed)) sendSoon();
  return created;
}
