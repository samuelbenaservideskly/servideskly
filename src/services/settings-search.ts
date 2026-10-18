/**
 * Searching Settings (asked for 18 Oct 2026).
 *
 * Settings has some forty pages behind nine sections and their tabs, and
 * the question an administrator arrives with is "where is the password
 * policy?", not "which section would that be under?". This is the list of
 * places, each with the words somebody might type for it - including the
 * ones the page itself does not use ("SSO", "logo", "SMTP").
 *
 * A static list on purpose: the pages are code, so their addresses are too,
 * and a search that read every view would find hints and placeholders rather
 * than places. A new settings page belongs here; the test walks every entry
 * and asks for its address.
 */
import { SETTINGS_SECTIONS } from '../routes/settings-shared.js';

export interface SettingsPlace {
  /** What the page or panel is called on screen. */
  title: string;
  /** Its section's slug (SETTINGS_SECTIONS). */
  section: string;
  /** The tab or panel above it, when it is not the section's own page. */
  under?: string;
  href: string;
  /** Other words for it: what somebody might type who does not know its name. */
  words: string;
}

export const SETTINGS_PLACES: SettingsPlace[] = [
  // Integrations
  { title: 'Microsoft Entra ID sign-in', section: 'integrations', under: 'Microsoft Entra ID', href: '/admin/settings/integrations/entra/authentication', words: 'sso single sign-on openid oidc azure ad active directory microsoft 365 office tenant client id secret redirect uri app registration' },
  { title: 'Provisioning (SCIM)', section: 'integrations', under: 'Microsoft Entra ID', href: '/admin/settings/integrations/entra/provisioning', words: 'scim sync directory enterprise application token just-in-time jit accounts automatic' },
  { title: 'Google Workspace', section: 'integrations', href: '/admin/settings/integrations/google', words: 'sso single sign-on gmail google domain oidc' },
  { title: 'Okta', section: 'integrations', href: '/admin/settings/integrations/okta', words: 'sso single sign-on oidc' },
  { title: 'OpenID Connect', section: 'integrations', href: '/admin/settings/integrations/openid', words: 'sso single sign-on oidc generic keycloak adfs authentik ping identity provider' },

  // Users
  { title: 'Local users', section: 'users', href: '/admin/settings/users', words: 'accounts people password accounts roles administrator agent technician import csv new account' },
  { title: 'Identity provider users', section: 'users', href: '/admin/settings/users/entra', words: 'directory accounts entra google okta sso people' },
  { title: 'Display name format', section: 'users', under: 'Other settings', href: '/admin/settings/users/other', words: 'names first last company how names are shown' },
  { title: 'Let people create their own account', section: 'users', under: 'Other settings', href: '/admin/settings/users/other#registration', words: 'registration register sign up self-service create account' },
  { title: 'Conditional access', section: 'users', under: 'Other settings', href: '/admin/settings/users/other#access', words: 'ip address range network office allowed cidr location mfa two-factor' },
  { title: 'People directory', section: 'users', under: 'Other settings', href: '/admin/settings/users/other#directory', words: 'search people staff list who can look up' },
  { title: 'People may change their own details', section: 'users', under: 'Other settings', href: '/admin/settings/users/other#self-edit', words: 'profile phone department job title office company self edit' },
  { title: 'Sign in with a code sent by email', section: 'users', under: 'Other settings', href: '/admin/settings/users/other#sign-in-codes', words: 'one-time code otp passwordless email code mfa two-factor' },
  { title: 'Password policy', section: 'users', under: 'Other settings', href: '/admin/settings/users/other#password-policy', words: 'password length complexity expiry expire symbols digits upper lower case common phrases' },

  // Groups
  { title: 'Technician groups', section: 'groups', href: '/admin/settings/groups', words: 'teams queues agents managers routing members' },
  { title: 'User groups', section: 'groups', href: '/admin/settings/groups/users', words: 'requesters members rules dynamic departments' },

  // Tickets
  { title: 'Ticket templates', section: 'templates', href: '/admin/settings/templates', words: 'forms request forms fields builder incident service request change task default form' },
  { title: 'Categories', section: 'templates', href: '/admin/settings/templates/categories', words: 'category subcategory sub category item catalogue tree classification' },
  { title: 'Service catalogue', section: 'templates', href: '/admin/settings/templates/catalogue', words: 'tiles new ticket page buttons grid icons' },
  { title: 'Custom fields', section: 'templates', href: '/admin/settings/templates/custom-fields', words: 'questions field library choice dropdown date number' },
  { title: 'Reference prefixes', section: 'templates', under: 'Other settings', href: '/admin/settings/templates/other#prefixes', words: 'ticket number reference inc sr chg prefix numbering' },
  { title: 'Service levels (SLA)', section: 'templates', under: 'Other settings', href: '/admin/settings/templates/other#sla', words: 'sla targets response resolution business hours holidays breach pause on hold' },
  { title: 'Status notes', section: 'templates', under: 'Other settings', href: '/admin/settings/templates/other#status-notes', words: 'cancel cancellation resolve resolution note reason required' },
  { title: 'Delete closed tickets', section: 'templates', under: 'Other settings', href: '/admin/settings/templates/other#retention', words: 'retention cleanup purge old tickets days gdpr' },

  // Mail
  { title: 'Mailboxes', section: 'mail', href: '/admin/settings/mail', words: 'email inbox microsoft 365 graph imap smtp outlook exchange gmail mailbox' },
  { title: 'Mail - general', section: 'mail', under: 'Other settings', href: '/admin/settings/mail/automation', words: 'known senders auto-close reopen replies closed tickets' },
  { title: 'Notifications', section: 'mail', under: 'Other settings', href: '/admin/settings/mail/notifications', words: 'email templates messages wording subject body sent when alerts' },
  { title: 'Approval page', section: 'mail', under: 'Other settings', href: '/admin/settings/mail/approval', words: 'approve approvals approver design page' },
  { title: 'SMTP relays', section: 'mail', under: 'Other settings', href: '/admin/settings/mail/relay', words: 'smtp relay send port 25 tls starttls server' },
  { title: 'Signature stripping', section: 'mail', under: 'Advanced settings', href: '/admin/settings/mail/advanced/signatures', words: 'signature kind regards replies cut patterns' },
  { title: 'Mail automation', section: 'mail', under: 'Advanced settings', href: '/admin/settings/mail/advanced/rules', words: 'rules incoming mail subject sender template routing' },

  // Customisation
  { title: 'Appearance', section: 'customization', href: '/admin/settings/customization', words: 'branding logo colour color theme font dark mode light mode favicon name brand' },
  { title: 'Attachments', section: 'customization', href: '/admin/settings/customization/attachments', words: 'files uploads size limit types attachments per ticket' },
  { title: 'Requester portal', section: 'customization', href: '/admin/settings/customization/portal', words: 'portal design html css layout home page requesters' },
  { title: 'Custom images', section: 'customization', href: '/admin/settings/customization/images', words: 'images pictures upload email images' },
  { title: 'Locale', section: 'customization', href: '/admin/settings/customization/locale', words: 'time zone timezone date format language translation languages' },

  // Dashboards
  { title: 'User dashboards', section: 'dashboards', href: '/admin/settings/dashboards/user', words: 'dashboard availability announcements notices my tickets at a glance' },
  { title: 'Locations', section: 'dashboards', href: '/admin/settings/dashboards/locations', words: 'offices sites places availability' },

  // Advanced
  { title: 'JavaScript', section: 'advanced', href: '/admin/settings/advanced/javascript', words: 'portal scripts script code' },
  { title: 'Automation', section: 'advanced', href: '/admin/settings/advanced/automation', words: 'workflows rules triggers actions http webhooks canvas' },
  { title: 'Connections', section: 'advanced', href: '/admin/settings/advanced/connections', words: 'oauth api key basic certificate credentials integrations' },
  { title: 'API keys', section: 'advanced', href: '/admin/settings/advanced/api-keys', words: 'api key token rest hooks read tickets' },
  { title: 'Data', section: 'advanced', href: '/admin/settings/advanced/data', words: 'export backup download delete everything reset' },

  // Audit
  { title: 'Audit trail', section: 'audit', href: '/admin/settings/audit', words: 'audit log history who changed activity events' },
];

/** Lower case, accents off: "Přihlášení" and "prihlaseni" are one search. */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface SettingsHit extends SettingsPlace {
  sectionTitle: string;
}

/**
 * Every place whose name, section, tab or other words contain every word of
 * the query (each word may be the start of a longer one), best first: a word
 * in the name counts most.
 */
export function searchSettings(query: string, limit = 20): SettingsHit[] {
  const words = fold(query).split(/[^a-z0-9]+/).filter((w) => w.length > 0).slice(0, 8);
  if (words.length === 0) return [];
  const scored: { hit: SettingsHit; score: number; at: number }[] = [];
  SETTINGS_PLACES.forEach((place, at) => {
    const sectionTitle = SETTINGS_SECTIONS.find((s) => s.slug === place.section)?.title ?? place.section;
    const title = fold(place.title);
    const rest = fold([sectionTitle, place.under ?? '', place.words].join(' '));
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += title.startsWith(w) || title.includes(' ' + w) ? 4 : 3;
      else if (rest.includes(w)) score += 1;
      else return;
    }
    scored.push({ hit: { ...place, sectionTitle }, score, at });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, limit)
    .map((s) => s.hit);
}
