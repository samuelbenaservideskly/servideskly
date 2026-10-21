import { config } from '../config.js';
import { settings, settingsDocument, settingsUpdatedAt } from '../settings/index.js';

/**
 * The settings shell, shared by every section.
 *
 * Users, technician groups, templates and the audit trail all live under
 * Settings now, and they are separate routers, so the sidebar and the values
 * every section page needs are defined here rather than in any one of them.
 */

/** The sections, in the order the sidebar shows them. */
export const SETTINGS_SECTIONS = [
  // Each blurb names the section's scope, not today's contents, so it stays
  // true as the section grows (Integrations will hold more than Entra ID).
  { slug: 'integrations', title: 'Integrations', blurb: 'Identity providers and connected services' },
  { slug: 'users', title: 'Users', blurb: 'Accounts, roles and access' },
  { slug: 'groups', title: 'Groups', blurb: 'Technician groups and user groups' },
  { slug: 'templates', title: 'Tickets', blurb: 'Request forms, the catalogue, categories and service levels' },
  { slug: 'mail', title: 'Mail', blurb: 'Mailboxes, notifications and approvals' },
  { slug: 'customization', title: 'Customisation', blurb: 'Branding, portal, images and locale' },
  { slug: 'dashboards', title: 'Dashboards', blurb: 'Dashboards shown to requesters, and locations' },
  { slug: 'assets', title: 'Assets', blurb: 'Asset columns, statuses and documents' },
  { slug: 'advanced', title: 'Advanced settings', blurb: 'Portal scripting, automation and connections' },
  { slug: 'audit', title: 'Audit trail', blurb: 'Record of administrative activity' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['slug'];

/** Values every settings page needs, plus whatever the section adds. */
export function settingsView(
  section: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const effective = settings();
  const meta = SETTINGS_SECTIONS.find((s) => s.slug === section);
  return {
    title: 'Settings - ' + (meta?.title ?? 'Settings'),
    sections: SETTINGS_SECTIONS,
    section,
    sectionTitle: meta?.title ?? 'Settings',
    doc: settingsDocument(),
    effective,
    problems: [] as string[],
    updatedAt: settingsUpdatedAt(),
    isProduction: config.isProduction,
    fixed: {
      publicOrigin: config.publicOrigin,
      redirectUri: effective.oidc.redirectUri,
      scimEndpoint: effective.scim.endpoint,
      environment: config.env,
      host: config.host,
      port: config.port,
    },
    ...extra,
  };
}
