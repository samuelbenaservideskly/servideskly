/**
 * The administrators the customer portal manages (asked for 17 Oct 2026).
 *
 * A hosted helpdesk has no break-glass account. Its owner lists the people
 * who administer it in the customer portal, and the portal sends that whole
 * list here as a signed request; this file applies it.
 *
 * - **Signed with this helpdesk's own key**: HMAC-SHA256 with a key derived
 *   from SESSION_SECRET ("helpdesk-portal-admins-v1"). Only the helpdesk and
 *   the portal's provisioner can read that secret (Key Vault). The signature
 *   covers a timestamp, which must be within five minutes and newer than the
 *   last list applied, so a captured request cannot be replayed.
 * - **The whole list, every time.** Sending it twice changes nothing; an
 *   address that left the list is demoted to a plain user.
 * - **Only its own addresses.** An administrator promoted under Settings -
 *   Users is not on the list and is left alone. One on the list is the
 *   portal's: nobody here can demote, disable or remove them.
 * - **An address with no account yet is invited**: a link to set a password
 *   (/setup). Somebody who signs in through an identity provider needs none -
 *   their account becomes an administrator when it arrives (promoteIfListed).
 *
 * A role comes from here and from Settings - Users, never from a token: an
 * identity provider asserts who somebody is, and this list - kept by the
 * customer in the portal - says what they may do.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { execute } from '../db/index.js';
import { normaliseEmail } from '../lib/util.js';
import { settings, updateSettings } from '../settings/index.js';
import { findUserByEmail, setUserRole, type UserRow } from '../services/users.js';
import { clearGroupsForUser } from '../services/groups.js';
import { applyAllTechnicianRules } from '../services/technician-rules.js';
import { defaultMailbox } from '../services/mail/mailboxes.js';
import { relayForGroup } from '../services/mail/relay.js';
import { queueMail, sendSoon } from '../services/mail/outbox.js';
import { emailButton, emailFrame } from '../services/mail/notifications.js';
import { BREAK_GLASS_FILE, findLocalAdmin, isLocalAccount } from './local-accounts.js';
import { signSetupToken } from './setup-token.js';

const log = logger.child({ module: 'portal-admins' });

/** How far the portal's clock may be from ours. */
const SKEW_MS = 5 * 60_000;
/** An invitation link lasts a week: people are away. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ADMINS = 50;

function key(): Buffer {
  return createHmac('sha256', config.session.keys[0]!).update('helpdesk-portal-admins-v1').digest();
}

/** The signature header the portal sends: `t=<ms>,v1=<base64url HMAC of "t.body">`. Also for tests. */
export function signPortalRequest(body: string, at = Date.now()): string {
  return 't=' + at + ',v1=' + createHmac('sha256', key()).update(at + '.' + body).digest('base64url');
}

/** The timestamp of a valid, fresh signature over this body; undefined otherwise. */
export function verifyPortalRequest(body: string, header: unknown): number | undefined {
  if (typeof header !== 'string' || header.length > 300) return undefined;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const at = Number(parts.t);
  if (!Number.isSafeInteger(at) || !parts.v1) return undefined;
  if (Math.abs(Date.now() - at) > SKEW_MS) return undefined;
  const expected = Buffer.from(createHmac('sha256', key()).update(at + '.' + body).digest('base64url'));
  const given = Buffer.from(parts.v1);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  // Newer than the last list applied: a replay of an older one is refused.
  if (at <= settings().provisioning.portalAdminsAt) return undefined;
  return at;
}

/** Whether the portal lists this address as an administrator. */
/**
 * Whether the customer portal keeps this helpdesk's administrators: it has
 * sent a list at least once. From then on nobody is made an administrator
 * here - the portal is where they are added, and it hands out the link to
 * set a password, which is the only way in while no mailbox is set up
 * (asked for 18 Oct 2026).
 */
export function portalManagesAdmins(): boolean {
  return settings().provisioning.portalAdminsAt > 0;
}

export const ADMINS_IN_PORTAL = 'Administrators of this helpdesk are added in the customer portal, which gives each one a link to set their password.';

export function isPortalAdmin(email: string): boolean {
  const e = normaliseEmail(email);
  return settings().provisioning.portalAdmins.includes(e);
}

/** Makes a listed person an administrator when their account appears or signs in. */
export async function promoteIfListed(user: UserRow): Promise<UserRow> {
  if (user.role === 'admin' || !isPortalAdmin(user.email)) return user;
  await setUserRole(user.id, 'admin', true);
  await applyAllTechnicianRules(user.id);
  audit({ action: 'user.role.changed', targetType: 'user', targetId: user.id, detail: { email: user.email, from: user.role, to: 'admin', by: 'portal' } });
  return { ...user, role: 'admin', role_locked: true };
}

export type AdminState = 'active' | 'invited';

/** Applies the portal's list; what each address now is, for the portal to show. */
export async function applyPortalAdmins(raw: unknown, at: number): Promise<Record<string, AdminState>> {
  const list = [...new Set((Array.isArray(raw) ? raw : []).map((e) => normaliseEmail(String(e))).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, MAX_ADMINS);
  const before = settings().provisioning.portalAdmins;
  await updateSettings({ provisioning: { portalAdmins: list, portalAdminsAt: at } }, null);

  const states: Record<string, AdminState> = {};
  for (const email of list) {
    const user = await findUserByEmail(email);
    const isNew = !before.includes(email);
    if (user) {
      await promoteIfListed(user);
      states[email] = 'active';
      if (isNew) await tell(email, isLocalAccount(user) ? 'local' : 'directory');
    } else {
      states[email] = 'invited';
      if (isNew) await tell(email, 'invite');
    }
  }

  for (const email of before.filter((e) => !list.includes(e))) {
    const user = await findUserByEmail(email);
    if (user?.role === 'admin') {
      await setUserRole(user.id, 'user', true);
      // A plain user has no queue: technician groups mean nothing to them.
      await clearGroupsForUser(user.id);
      audit({ action: 'user.role.changed', targetType: 'user', targetId: user.id, detail: { email, from: 'admin', to: 'user', by: 'portal' } });
    }
  }

  audit({ action: 'portal.admins.applied', detail: { count: list.length, added: list.filter((e) => !before.includes(e)).length, removed: before.filter((e) => !list.includes(e)).length } });
  if (list.length > 0) await retireBreakGlass();
  return states;
}

/**
 * A hosted helpdesk made before this has a break-glass account. Once the
 * portal names at least one administrator, it is no longer the way in, and
 * it goes. Production only: development keeps admin@local to sign in with.
 */
async function retireBreakGlass(): Promise<void> {
  if (!config.isProduction) return;
  const account = await findLocalAdmin();
  if (!account) return;
  await execute('DELETE FROM local_credentials WHERE user_id = ?', [account.id]);
  try {
    await execute('DELETE FROM users WHERE id = ?', [account.id]);
  } catch {
    // Something it did still points at it: keep the row, and no way to sign in to it.
    await execute("UPDATE users SET status = 'disabled' WHERE id = ?", [account.id]);
  }
  fs.rmSync(BREAK_GLASS_FILE, { force: true });
  audit({ action: 'local_admin.retired', targetType: 'user', targetId: account.id });
  log.info('the break-glass account was removed: the customer portal names the administrators now');
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** "You are an administrator of ...", with a way in that fits the account. */
async function tell(email: string, kind: 'invite' | 'local' | 'directory'): Promise<void> {
  try {
    const options = settings().smtpRelay;
    const relay = options.useForCodes || options.relaysOnly ? await relayForGroup(null) : undefined;
    const mailbox = relay ? undefined : await defaultMailbox();
    const anyRelay = relay ?? (mailbox ? undefined : await relayForGroup(null));
    if (!anyRelay && !mailbox) {
      log.warn({ kind }, 'an administrator was added, and there is no mailbox or relay to tell them');
      return;
    }
    const appName = settings().branding.appName;
    const name = esc(appName);
    const sso = settings().anySsoConfigured;
    const signIn = config.publicOrigin + '/login';
    const inner =
      kind === 'invite'
        ? `<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#101828">You are an administrator of ${name}</h1>
           <p style="margin:0 0 4px">You have been added as an administrator of the ${name} service desk. Choose a password to sign in with <strong>${esc(email)}</strong>.</p>` +
          emailButton('Set up your password', config.publicOrigin + '/setup?t=' + encodeURIComponent(signSetupToken(email, Date.now() + INVITE_TTL_MS, randomBytes(9).toString('base64url')))) +
          `<p style="margin:20px 0 0;color:#667085;font-size:13px">The link works for 7 days.${sso ? ' If your organisation signs in to it with its own accounts, you can use that instead and need no password.' : ''}</p>`
        : `<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#101828">You are an administrator of ${name}</h1>
           <p style="margin:0 0 4px">You have been added as an administrator of the ${name} service desk. ${kind === 'directory' ? 'Sign in with your organisation account, as you do now.' : 'Sign in with your email address and your password, as you do now.'} Settings are in the menu once you are in.</p>` +
          emailButton('Sign in', signIn);
    await queueMail({
      mailboxId: mailbox?.id ?? null,
      ...(anyRelay ? { viaRelay: true, relayId: anyRelay.id } : {}),
      urgent: true,
      ticketId: null,
      to: email,
      subject: 'You are an administrator of ' + appName.replace(/[\r\n]/g, ' '),
      bodyHtml: emailFrame(inner, { signature: false }),
    });
    sendSoon();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'the administrator message could not be queued');
  }
}
