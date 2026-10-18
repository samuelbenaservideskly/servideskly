import { audit } from '../lib/audit.js';
import { settings } from '../settings/index.js';
import { fontProblems, modePalettes } from './branding.js';
import { mix, parseColour, readableOn, toHex } from '../lib/color.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso, sha256 } from '../lib/util.js';
import { execute, query, queryOne, transaction } from '../db/index.js';

/**
 * Requester portals.
 *
 * An administrator can replace what a requester sees *around* their pages -
 * the masthead, the navigation, a footer, a home page with large buttons -
 * with HTML and CSS of their own. What they cannot replace is the working
 * part of a page: the ticket list, the form, a ticket's conversation. That
 * arrives as `{{content}}`, rendered by the same views as always, so a portal
 * can restyle the service desk but cannot break raising a ticket.
 *
 * Three things keep this safe enough to hand to an administrator:
 *
 * - The pages keep `script-src 'none'` and `style-src 'self'`. A portal is
 *   markup and a stylesheet served from this origin, nothing else, and a
 *   save that contains script, an inline handler or an inline style is
 *   refused rather than stored to fail silently in the browser.
 * - Every value a variable inserts is escaped. The administrator's HTML is
 *   trusted as written; a requester's name is not.
 * - The built-in look is not a row. It is the code, so it cannot be deleted
 *   or broken, and "no portal is active" always has a meaning.
 */

/** The id the built-in portal answers to. Never a row in the table. */
export const STANDARD_PORTAL = 'standard';

/**
 * Two kinds share this machinery: the requester portal (Customisation) and
 * the approval page (Mail). Same table, same editor, same preview; what
 * differs is which parts there are and which variables they may use.
 */
export type PortalKind = 'requester' | 'approval';

export function isPortalKind(value: unknown): value is PortalKind {
  return value === 'requester' || value === 'approval';
}

/** The requester pages a portal can dress, in the order the editor shows them. */
export const PORTAL_PAGES = [
  { key: 'home', label: 'Home', path: '/home' },
  { key: 'tickets', label: 'My tickets', path: '/tickets' },
  { key: 'new', label: 'New ticket', path: '/tickets/new' },
  { key: 'ticket', label: 'Ticket', path: null },
  { key: 'profile', label: 'Profile', path: '/profile' },
  // Before anyone signs in, so it is drawn in the *default* portal: there is
  // nobody yet whose groups could choose another.
  { key: 'login', label: 'Sign-in', path: '/login' },
  // The two second steps of signing in (email first, then one of these).
  // Blank, each is drawn with the Sign-in part instead.
  { key: 'login_password', label: 'Sign-in password', path: '/login/password' },
  { key: 'login_code', label: 'Sign-in code', path: '/login/code' },
] as const;

export type PortalPage = (typeof PORTAL_PAGES)[number]['key'];

/** Everything the editor has a tab for: the two shared parts, then each page. */
export const PORTAL_PARTS = [
  { key: 'layout', label: 'Layout' },
  { key: 'css', label: 'CSS' },
  // Offered only while Settings - Advanced - JavaScript is on (partsFor).
  { key: 'js', label: 'JavaScript' },
  ...PORTAL_PAGES.map((p) => ({ key: p.key, label: p.label })),
] as const;

export type PortalPart = 'layout' | 'css' | 'js' | PortalPage;

/**
 * The editor's tabs for a kind. The approval page is one page, so it has a
 * layout - with {{content}} where the request and its form go - and CSS.
 */
export function partsFor(kind: PortalKind): readonly { key: PortalPart; label: string }[] {
  if (kind === 'approval') {
    return [
      { key: 'layout', label: 'Layout' },
      { key: 'css', label: 'CSS' },
    ];
  }
  // The JavaScript tab exists only while scripts are allowed at all.
  return settings().portalScripts.enabled ? PORTAL_PARTS : PORTAL_PARTS.filter((p) => p.key !== 'js');
}

export function isPortalPart(value: unknown): value is PortalPart {
  return PORTAL_PARTS.some((p) => p.key === value);
}

export function isPortalPage(value: unknown): value is PortalPage {
  return PORTAL_PAGES.some((p) => p.key === value);
}

export interface PortalRow {
  id: string;
  name: string;
  kind: PortalKind;
  layout_html: string;
  css: string;
  /** The portal's own script; runs only while portal scripts are allowed. */
  script: string;
  pages: Partial<Record<PortalPage, string>>;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Large enough for any real page, small enough not to be a storage problem. */
export const MAX_PART_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// Starting point
// ---------------------------------------------------------------------------

/**
 * What a new portal starts with. Deliberately plain: it shows how the
 * variables fit together, and an administrator replaces it rather than
 * deleting their way through somebody else's design.
 */
export const STARTER_LAYOUT = `<div class="portal-shell">
  <aside class="portal-side">
    <a class="portal-brand" href="{{url_home}}">{{logo}}</a>
    {{nav}}
    <div class="portal-account">
      <span class="portal-who">{{user_name}}</span>
      {{button_sign_out}}
    </div>
  </aside>

  <main class="portal-main">
    {{page}}
  </main>
</div>

<footer class="portal-footer">
  &copy; {{year}} {{app_name}}
</footer>
`;

export const STARTER_HOME = `<section class="portal-hero">
  <h1>How can we help, {{user_name}}?</h1>
  <p>Raise a request, or follow up on one you have already sent.</p>
  <div class="portal-actions">
    {{button_new_ticket}}
    {{button_tickets}}
  </div>
</section>

{{content}}
`;

/**
 * A new portal's stylesheet, with **the colours this service desk is set to
 * now** written into its :root block.
 *
 * A portal still does not read Customisation - Appearance: its CSS is the
 * whole of its design, which is what keeps a portal from depending on a page
 * its author does not control. But starting every one on the same hard-coded
 * navy meant a service desk with a chosen palette got a preview in somebody
 * else's colours and read it as the preview being broken (reported 16 Oct
 * 2026). So the colours are **copied in** when the portal is made: the
 * administrator owns them from then on, and changing Appearance afterwards
 * leaves this portal alone - which is what "Start again from the current
 * design" is for.
 */
function starterColours(): string {
  const branding = settings().branding;
  const brand = parseColour(branding.brandColour) ?? { r: 99, g: 91, b: 255 };
  const palette = modePalettes();
  const onBrand = readableOn(brand, palette.lightText);
  return [
    '  --brand: ' + toHex(brand) + ';',
    '  --brand-ink: ' + toHex(onBrand) + ';',
    '  --accent: ' + toHex(brand) + ';',
    '  --accent-text: ' + toHex(onBrand) + ';',
    '  --accent-soft: ' + toHex(mix(brand, palette.lightSurface, 0.9)) + ';',
    '  --surface: ' + toHex(palette.lightSurface) + ';',
    '  --text: ' + toHex(palette.lightText) + ';',
    '  --text-muted: ' + toHex(mix(palette.lightText, palette.lightSurface, 0.38)) + ';',
    '  --portal-page: ' + toHex(palette.lightBg) + ';',
    '  --portal-line: ' + toHex(mix(palette.lightText, palette.lightSurface, 0.88)) + ';',
    '  --portal-radius: 18px;',
  ].join('\n');
}

/** The requester portal's starting stylesheet. */
export function starterCss(): string {
  return `/* The standard stylesheet still applies, so the ticket list, the form and
   the conversation keep their layout. Anything here is added on top of it. */

/* This portal's colours, copied from Customisation - Appearance when it was
   created. A portal does not follow Appearance afterwards: these are the
   only colours it has, so change them here. */
:root {
${starterColours()}
}

body {
  background: var(--portal-page);
}

/* The shell: a sidebar beside the page, as the service desk itself has. */
.portal-shell {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  gap: 1.25rem;
  max-width: 78rem;
  margin: 0 auto;
  padding: 1.25rem;
  align-items: start;
}

.portal-side {
  position: sticky;
  top: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.1rem 1rem;
  background: var(--surface);
  border: 1px solid var(--portal-line);
  border-radius: var(--portal-radius);
}

/* A ground behind the logo, as the standard sidebar gives it - unless the
   logo brought its own transparency, which --logo-plate says. */
.portal-brand img {
  display: block;
  max-height: 2.1rem;
  padding: var(--logo-plate-pad, 0.2rem 0.45rem);
  background: var(--logo-plate, #fff);
  border-radius: 6px;
}

.portal-side nav {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.portal-side nav a {
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  color: var(--text);
  text-decoration: none;
  font-weight: 560;
}

.portal-side nav a:hover,
.portal-side nav a:focus-visible {
  background: var(--accent-soft);
}

.portal-side nav a[aria-current="page"] {
  background: var(--brand);
  color: var(--brand-ink);
}

.portal-account {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.5rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--portal-line);
}

.portal-who { font-weight: 560; }

.portal-main { min-width: 0; }

/* The greeting: one soft card rather than a band across the window. */
.portal-hero {
  padding: 2rem 1.75rem;
  margin-bottom: 1.25rem;
  background: var(--accent-soft);
  border: 1px solid var(--portal-line);
  border-radius: var(--portal-radius);
}

.portal-hero h1 {
  font-size: 1.9rem;
  margin: 0 0 0.4rem;
  letter-spacing: -0.02em;
}

.portal-hero p { color: var(--text-muted); margin: 0; }

.portal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1.25rem;
}

.portal-footer {
  padding: 1.5rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.85rem;
}

/* Narrow: the sidebar becomes the bar above the page. */
@media (max-width: 52rem) {
  .portal-shell { grid-template-columns: minmax(0, 1fr); }
  .portal-side { position: static; }
  .portal-side nav { flex-direction: row; flex-wrap: wrap; }
}
`;
}


export const STARTER_APPROVAL_LAYOUT = `<header class="approval-header">
  {{logo}}
</header>

<section class="approval-intro">
  <h1>Your approval is needed</h1>
  <p>{{requester_name}} has asked for <strong>{{ticket_title}}</strong> ({{ticket_reference}}).</p>
</section>

{{content}}

<footer class="approval-footer">
  Signed in as {{user_email}} {{button_sign_out}}
</footer>
`;

export function starterApprovalCss(): string {
  return `/* Added on top of the standard stylesheet. */

/* This portal's colours, copied from Customisation - Appearance when it was
   created. Change them here - a portal does not follow Appearance. */
:root {
${starterColours()}
}


.approval-header {
  display: flex;
  justify-content: center;
  padding: 1.25rem;
  border-bottom: 3px solid var(--brand);
  background: var(--surface);
}

.approval-header img {
  max-height: 2.5rem;
  padding: 0.2rem 0.45rem;
  background: #fff;
  border-radius: 4px;
}

.approval-intro {
  max-width: 720px;
  margin: 2rem auto 0;
  padding: 0 1.25rem;
  text-align: center;
}

.approval-footer {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.75rem;
  padding: 1.5rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}
`;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/** What a variable is replaced with, given the request it is drawn for. */
export interface PortalContext {
  appName: string;
  logoUrl: string | null;
  userName: string;
  userEmail: string;
  pageTitle: string;
  currentPath: string;
  csrfToken: string;
  /** Active template id -> name, for `{{button_template:<id>}}`. */
  templates: Map<string, string>;
  /** False on the sign-in page, where there is nobody yet. */
  signedIn?: boolean;
  /** Dashboard id -> markup already drawn for this reader (services/dashboards.ts). */
  dashboards?: Map<string, string>;
  /** On the approval page: the request being decided. */
  ticket?: {
    reference: string;
    title: string;
    requesterName: string;
    approverEmail: string;
  } | null;
}

/** The reference shown beside the editor. `arg` marks one taking an id. */
export const PORTAL_VARIABLES: {
  name: string;
  arg?: boolean;
  where: 'layout' | 'page' | 'any';
  gives: string;
}[] = [
  { name: 'page', where: 'layout', gives: 'Where each page goes. Required, once.' },
  {
    name: 'content',
    where: 'page',
    gives: "The page's own content - the list, the form, the ticket. Once per page.",
  },
  { name: 'app_name', where: 'any', gives: 'The application name from Appearance.' },
  { name: 'logo', where: 'any', gives: 'The uploaded logo, or the application name.' },
  { name: 'logo_url', where: 'any', gives: 'The address of the logo, for your own <img>.' },
  { name: 'page_title', where: 'any', gives: 'The name of the current page.' },
  { name: 'user_name', where: 'any', gives: "The signed-in requester's name." },
  { name: 'user_email', where: 'any', gives: "The signed-in requester's email address." },
  { name: 'year', where: 'any', gives: 'The current year.' },
  { name: 'nav', where: 'any', gives: 'Links to Home, My tickets, New ticket and Profile.' },
  { name: 'button_home', where: 'any', gives: 'A button to the home page.' },
  { name: 'button_tickets', where: 'any', gives: "A button to the requester's tickets." },
  { name: 'button_new_ticket', where: 'any', gives: 'A button to raise a ticket.' },
  { name: 'button_profile', where: 'any', gives: 'A button to the profile page.' },
  { name: 'button_sign_out', where: 'any', gives: 'A sign-out button.' },
  {
    name: 'button_template',
    arg: true,
    where: 'any',
    gives: 'A button that opens New ticket with that template chosen.',
  },
  { name: 'url_home', where: 'any', gives: 'The address of the home page, for your own link.' },
  { name: 'url_tickets', where: 'any', gives: 'The address of My tickets.' },
  { name: 'url_new_ticket', where: 'any', gives: 'The address of New ticket.' },
  { name: 'url_profile', where: 'any', gives: 'The address of the profile page.' },
  { name: 'url_template', arg: true, where: 'any', gives: 'New ticket with that template chosen.' },
  {
    name: 'dashboard',
    arg: true,
    where: 'any',
    gives: 'A dashboard from Settings - Dashboards, e.g. {{dashboard:technician-availability}}. Empty while it is switched off.',
  },
  { name: 'ticket_reference', where: 'any', gives: 'The reference of the request, e.g. SR-000123.' },
  { name: 'ticket_title', where: 'any', gives: 'The title of the request.' },
  { name: 'requester_name', where: 'any', gives: 'Who raised the request.' },
  { name: 'approver_email', where: 'any', gives: 'The address the approval was sent to.' },
];

/** What each kind may use. Anything else is refused on save. */
const KIND_VARIABLES: Record<PortalKind, ReadonlySet<string>> = {
  requester: new Set(
    PORTAL_VARIABLES.map((v) => v.name).filter(
      (n) => !['ticket_reference', 'ticket_title', 'requester_name', 'approver_email'].includes(n),
    ),
  ),
  approval: new Set([
    'content',
    'app_name',
    'logo',
    'logo_url',
    'page_title',
    'user_name',
    'user_email',
    'year',
    'button_sign_out',
    'ticket_reference',
    'ticket_title',
    'requester_name',
    'approver_email',
  ]),
};

/** The reference panel for a kind, worded for it. */
export function variablesFor(kind: PortalKind): typeof PORTAL_VARIABLES {
  return PORTAL_VARIABLES.filter((v) => KIND_VARIABLES[kind].has(v.name)).map((v) =>
    kind === 'approval' && v.name === 'content'
      ? { ...v, where: 'layout' as const, gives: 'The request and its Approve / Decline form. Required, once.' }
      : v,
  );
}

const VARIABLE = /\{\{\s*([a-z_]+)(?:\s*:\s*([A-Za-z0-9-]+))?\s*\}\}/g;
const CONTENT = /\{\{\s*content\s*\}\}/;
const CONTENT_ALL = /\{\{\s*content\s*\}\}/g;
const PAGE = /\{\{\s*page\s*\}\}/;
const PAGE_ALL = /\{\{\s*page\s*\}\}/g;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LINKS = [
  { key: 'home', label: 'Home', href: '/home' },
  { key: 'tickets', label: 'My tickets', href: '/tickets' },
  { key: 'new_ticket', label: 'New ticket', href: '/tickets/new' },
  { key: 'profile', label: 'Profile', href: '/profile' },
] as const;

function templateUrl(id: string): string {
  return '/tickets/new?template=' + encodeURIComponent(id);
}

/** One variable's markup, or null when the name is not one we know. */
function variableValue(name: string, arg: string | undefined, ctx: PortalContext): string | null {
  const link = LINKS.find((l) => 'url_' + l.key === name || 'button_' + l.key === name);
  if (link) {
    if (name.startsWith('url_')) return link.href;
    return '<a class="btn portal-button portal-button--' + link.key + '" href="' + link.href +
      '">' + link.label + '</a>';
  }

  switch (name) {
    case 'app_name':
      return escapeHtml(ctx.appName);
    case 'page_title':
      return escapeHtml(ctx.pageTitle);
    case 'user_name':
      return escapeHtml(ctx.userName);
    case 'user_email':
      return escapeHtml(ctx.userEmail);
    case 'year':
      return String(new Date().getUTCFullYear());
    case 'ticket_reference':
      return escapeHtml(ctx.ticket?.reference ?? '');
    case 'ticket_title':
      return escapeHtml(ctx.ticket?.title ?? '');
    case 'requester_name':
      return escapeHtml(ctx.ticket?.requesterName ?? '');
    case 'approver_email':
      return escapeHtml(ctx.ticket?.approverEmail ?? '');
    case 'logo_url':
      return ctx.logoUrl ? escapeHtml(ctx.logoUrl) : '';
    case 'logo':
      return ctx.logoUrl
        ? '<img class="portal-logo" src="' + escapeHtml(ctx.logoUrl) + '" alt="' +
            escapeHtml(ctx.appName) + '">'
        : '<span class="portal-logo portal-logo--text">' + escapeHtml(ctx.appName) + '</span>';
    case 'nav':
      // Every link in it needs an account, so before signing in there is
      // nothing to offer - and a row of dead ends is worse than no row.
      if (ctx.signedIn === false) return '';
      return (
        '<nav class="portal-nav" aria-label="Portal">' +
        LINKS.map((l) => {
          const current = ctx.currentPath === l.href ? ' aria-current="page"' : '';
          return '<a href="' + l.href + '"' + current + '>' + l.label + '</a>';
        }).join('') +
        '</nav>'
      );
    case 'button_sign_out':
      // Nobody to sign out on the sign-in page.
      if (ctx.signedIn === false) return '';
      return (
        '<form method="post" action="/auth/logout" class="inline-form portal-sign-out">' +
        '<input type="hidden" name="_csrf" value="' + escapeHtml(ctx.csrfToken) + '">' +
        '<button type="submit" class="btn btn--quiet">Sign out</button></form>'
      );
    case 'dashboard':
      // Drawn beforehand, because it reads the database and this does not.
      return arg ? (ctx.dashboards?.get(arg) ?? '') : '';
    case 'url_template':
    case 'button_template': {
      // A template retired since the portal was saved simply drops out,
      // rather than leaving a button to a form that is no longer offered.
      const label = arg ? ctx.templates.get(arg) : undefined;
      if (!arg || label === undefined) return '';
      if (name === 'url_template') return escapeHtml(templateUrl(arg));
      return '<a class="btn portal-button portal-button--template" href="' +
        escapeHtml(templateUrl(arg)) + '">' + escapeHtml(label) + '</a>';
    }
    default:
      return null;
  }
}

/** Replaces every variable except the structural two, which the caller places. */
function renderVariables(html: string, ctx: PortalContext): string {
  return html.replace(VARIABLE, (whole, name: string, arg: string | undefined) => {
    if (name === 'page' || name === 'content') return '';
    return variableValue(name, arg, ctx) ?? whole;
  });
}

/** True when any part of this portal asks for a template by id. */
export function usesTemplates(portal: PortalRow): boolean {
  const all = [portal.layout_html, ...Object.values(portal.pages)].join('\n');
  return /\{\{\s*(?:url|button)_template\s*:/.test(all);
}

/** The HTML a page shows, before variables: its own part, or just its content. */
function pageSource(portal: PortalRow, page: PortalPage): string {
  const own = portal.pages[page] ?? '';
  if (own.trim() !== '') return own;
  // A sign-in step left blank looks like the sign-in page.
  if (page === 'login_password' || page === 'login_code') {
    const signIn = portal.pages.login ?? '';
    if (signIn.trim() !== '') return signIn;
  }
  return '{{content}}';
}

/** Whether this portal gives requesters a home page at all. */
export function hasHomePage(portal: PortalRow): boolean {
  return (portal.pages.home ?? '').trim() !== '';
}

/**
 * The markup that goes before and after a page's own content.
 *
 * The layout's `{{page}}` takes the page's HTML, and that HTML's
 * `{{content}}` is where the page renders as it always has. A page with no
 * `{{content}}` - a home page can reasonably have none - gets its content
 * after everything else, where it holds no more than a "Saved" message.
 */
export function composePortal(
  portal: PortalRow,
  page: PortalPage,
  ctx: PortalContext,
): { head: string; foot: string } {
  let whole: string;
  if (portal.kind === 'approval') {
    // One page: the layout holds {{content}} itself.
    whole = CONTENT.test(portal.layout_html) ? portal.layout_html : '{{content}}';
  } else {
    const source = pageSource(portal, page);
    const layout = PAGE.test(portal.layout_html) ? portal.layout_html : '{{page}}';
    // A function, not a string: a replacement string would read `$&` and
    // `$'` in the administrator's HTML as instructions.
    whole = layout.replace(PAGE, () => source);
  }

  const at = whole.search(CONTENT);
  if (at < 0) return { head: renderVariables(whole, ctx), foot: '' };
  const marker = CONTENT.exec(whole)!;
  return {
    head: renderVariables(whole.slice(0, at), ctx),
    foot: renderVariables(whole.slice(at + marker[0].length), ctx),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Why a part cannot be saved, in words, or nothing.
 *
 * The page is served with a policy that blocks script and inline styles, so
 * markup relying on either would be stored, shown in the preview, and then
 * silently do nothing. Refusing it here says so while it can still be fixed.
 */
export function partProblems(
  part: PortalPart,
  code: string,
  activeTemplateIds: ReadonlySet<string>,
  kind: PortalKind = 'requester',
  dashboardIds: ReadonlySet<string> = new Set(),
): string[] {
  const problems: string[] = [];
  if (code.length > MAX_PART_LENGTH) {
    problems.push('This is longer than ' + MAX_PART_LENGTH.toLocaleString('en') + ' characters.');
  }
  if (part === 'js') {
    // Plain JavaScript in a file of its own; a <script> wrapper would be text.
    if (/<\/?\s*script\b/i.test(code)) {
      problems.push('Write the script on its own, without a <script> tag around it.');
    }
    return problems;
  }
  if (part === 'css') {
    if (/<\/?\s*style\b/i.test(code)) {
      problems.push('Write the rules on their own, without a <style> tag around them.');
    }
    // Fonts: no @font-face, no @import, and only families this service desk
    // is licensed to name. See ALLOWED_FONTS in services/branding.ts.
    problems.push(...fontProblems(code));
    return problems;
  }

  if (/<\s*script\b/i.test(code)) {
    problems.push('Scripts are not allowed. The portal is served with a policy that blocks them.');
  }
  if (/<[^>]*\son[a-z]+\s*=/i.test(code)) {
    problems.push('Event handlers such as onclick are not allowed - they would never run.');
  }
  if (/<\s*style\b/i.test(code) || /<[^>]*\sstyle\s*=/i.test(code)) {
    problems.push('Put styles in the CSS tab. Inline styles are blocked by the page\'s security policy.');
  }

  const pageCount = (code.match(PAGE_ALL) ?? []).length;
  const contentCount = (code.match(CONTENT_ALL) ?? []).length;

  if (kind === 'approval') {
    if (contentCount !== 1) {
      problems.push(
        'The layout needs {{content}} exactly once - it is where the request and the ' +
          'Approve / Decline form go.',
      );
    }
    if (pageCount > 0) problems.push('The approval page has no {{page}}. Use {{content}}.');
  } else if (part === 'layout') {
    if (pageCount !== 1) {
      problems.push('The layout needs {{page}} exactly once - it is where every page goes.');
    }
    if (contentCount > 0) {
      problems.push('{{content}} belongs in a page, not the layout. Use {{page}} here.');
    }
  } else {
    if (pageCount > 0) problems.push('{{page}} belongs in the layout. Use {{content}} here.');
    if (contentCount > 1) problems.push('{{content}} can appear only once.');
    if (part !== 'home' && code.trim() !== '' && contentCount === 0) {
      problems.push(
        'This page needs {{content}} - without it the requester would lose the ' +
          'page itself. Leave the box empty to show the standard page.',
      );
    }
  }

  const unknown = new Set<string>();
  for (const match of code.matchAll(VARIABLE)) {
    const [whole, name, arg] = match;
    const known = PORTAL_VARIABLES.find((v) => v.name === name && KIND_VARIABLES[kind].has(v.name));
    if (!known || Boolean(known.arg) !== Boolean(arg)) {
      unknown.add(whole);
    } else if (known.arg && arg && name === 'dashboard') {
      if (!dashboardIds.has(arg)) problems.push(whole + ' does not name a dashboard.');
    } else if (known.arg && arg && !activeTemplateIds.has(arg)) {
      problems.push(whole + ' does not name an active template.');
    }
  }
  if (unknown.size > 0) {
    problems.push('Not a variable this portal knows: ' + Array.from(unknown).join(', ') + '.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const SELECT = 'SELECT * FROM portal_themes';

function normalise(row: PortalRow | undefined): PortalRow | undefined {
  if (!row) return undefined;
  const pages = row.pages && typeof row.pages === 'object' ? row.pages : {};
  return { ...row, pages };
}

export async function listPortals(kind: PortalKind = 'requester'): Promise<PortalRow[]> {
  const rows = await query<PortalRow>(SELECT + ' WHERE kind = ? ORDER BY lower(name)', [kind]);
  return rows.map((r) => normalise(r)!);
}

export async function findPortal(id: string): Promise<PortalRow | undefined> {
  return normalise(await queryOne<PortalRow>(SELECT + ' WHERE id = ?', [id]));
}

/**
 * The default portal, or undefined for the built-in one. `is_active` is the
 * default flag; the column predates group assignment and kept its name.
 */
export async function defaultPortal(kind: PortalKind = 'requester'): Promise<PortalRow | undefined> {
  return normalise(
    await queryOne<PortalRow>(SELECT + ' WHERE is_active = 1 AND kind = ?', [kind]),
  );
}

/**
 * The portal one requester sees: their group's, or else the default.
 *
 * A requester in several assigned groups gets the portal of the group whose
 * name sorts first. Arbitrary, but stable - the same person never sees the
 * portal change from one page to the next - and the list page says so.
 * A retired group assigns nothing.
 */
export async function portalForUser(userId: string): Promise<PortalRow | undefined> {
  const assigned = await queryOne<{ portal_id: string }>(
    `SELECT a.portal_id
       FROM portal_group_assignments a
       JOIN user_groups g ON g.id = a.group_id AND g.is_active = 1
       JOIN user_group_members m ON m.group_id = a.group_id AND m.user_id = ?
       LEFT JOIN portal_themes p ON p.id = a.portal_id
      WHERE a.portal_id = ? OR p.kind = 'requester'
      ORDER BY lower(g.name)
      LIMIT 1`,
    [userId, STANDARD_PORTAL],
  );
  if (assigned) {
    return assigned.portal_id === STANDARD_PORTAL ? undefined : findPortal(assigned.portal_id);
  }
  return defaultPortal();
}

export interface PortalAssignment {
  group_id: string;
  group_name: string;
  portal_id: string;
}

/** Every group assignment, for the list page. */
export function listPortalAssignments(): Promise<PortalAssignment[]> {
  return query<PortalAssignment>(
    `SELECT a.group_id, g.name AS group_name, a.portal_id
       FROM portal_group_assignments a
       JOIN user_groups g ON g.id = a.group_id
      ORDER BY lower(g.name)`,
  );
}

/**
 * Sets which groups follow this portal - exactly the ones sent.
 *
 * The dialog lists every group, so "not ticked" means "not this portal": a
 * group that was assigned here and is now unticked goes back to the default.
 * Ticking a group that follows another portal moves it, since a group can
 * follow only one.
 */
export async function setPortalGroups(
  portalId: string,
  groupIds: readonly string[],
  actorId: string | null,
): Promise<void> {
  let name = 'Standard';
  if (portalId !== STANDARD_PORTAL) {
    const portal = await findPortal(portalId);
    if (!portal) throw notFound('That portal no longer exists.');
    name = portal.name;
  }
  const wanted = Array.from(new Set(groupIds));
  if (wanted.length > 0) {
    const known = await query<{ id: string }>(
      'SELECT id FROM user_groups WHERE id IN (' + wanted.map(() => '?').join(', ') + ')',
      wanted,
    );
    if (known.length !== wanted.length) throw notFound('One of those groups no longer exists.');
  }

  const now = nowIso();
  await transaction(async (client) => {
    await client.query('DELETE FROM portal_group_assignments WHERE portal_id = ?', [portalId]);
    for (const groupId of wanted) {
      // Replaces the group's row if it followed another portal.
      await client.query(
        `INSERT INTO portal_group_assignments (group_id, portal_id, assigned_at)
         VALUES (?, ?, ?)
         ON CONFLICT (group_id) DO UPDATE SET portal_id = excluded.portal_id,
                                              assigned_at = excluded.assigned_at`,
        [groupId, portalId, now],
      );
    }
  });
  audit({
    action: 'portal.groups.changed',
    actorId,
    targetType: 'portal',
    targetId: portalId,
    detail: { name, groupIds: wanted },
  });
}

/** How many groups follow this portal. */
export async function portalGroupCount(portalId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    'SELECT count(*) AS n FROM portal_group_assignments WHERE portal_id = ?',
    [portalId],
  );
  return rows[0]?.n ?? 0;
}

/** Changes whenever the portal does; used to version its stylesheet URL. */
export function portalVersion(portal: PortalRow): string {
  return sha256(portal.id + '|' + portal.updated_at + '|' + portal.css + '|' + (portal.script ?? '')).slice(0, 12);
}

/** Whether this portal's script should run: allowed, and there is one. */
export function portalRunsScript(portal: PortalRow): boolean {
  return settings().portalScripts.enabled && portal.kind === 'requester' && (portal.script ?? '').trim() !== '';
}

/** "https://widget.example.com" - an origin a portal script may use. */
export function isScriptOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && value === url.origin;
  } catch {
    return false;
  }
}

async function assertNameFree(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>(
    'SELECT id FROM portal_themes WHERE lower(name) = lower(?)',
    [name],
  );
  if (
    (clash && clash.id !== exceptId) ||
    name.trim().toLowerCase() === STANDARD_PORTAL
  ) {
    throw conflict('A portal with that name already exists.', 'portal_name_taken');
  }
}

/** A name not yet taken, for a copy: "Copy of X", then "Copy of X (2)". */
async function freeName(base: string): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base : base + ' (' + n + ')';
    const clash = await queryOne<{ id: string }>(
      'SELECT id FROM portal_themes WHERE lower(name) = lower(?)',
      [candidate],
    );
    if (!clash) return candidate;
  }
  return base + ' ' + newId().slice(0, 8);
}

export async function createPortal(
  name: string,
  actorId: string | null,
  from?: PortalRow,
  kind: PortalKind = from?.kind ?? 'requester',
): Promise<PortalRow> {
  await assertNameFree(name, null);
  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO portal_themes
       (id, name, kind, layout_html, css, script, pages, is_active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      id,
      name,
      kind,
      from ? from.layout_html : kind === 'approval' ? STARTER_APPROVAL_LAYOUT : STARTER_LAYOUT,
      from ? from.css : kind === 'approval' ? starterApprovalCss() : starterCss(),
      from ? from.script ?? '' : '',
      JSON.stringify(from ? from.pages : kind === 'approval' ? {} : { home: STARTER_HOME }),
      actorId,
      now,
      now,
    ],
  );
  audit({
    action: 'portal.created',
    actorId,
    targetType: 'portal',
    targetId: id,
    detail: { name, copiedFrom: from?.id ?? null },
  });
  return (await findPortal(id))!;
}

/** A copy, or for the built-in portal a fresh starter, under a free name. */
export async function duplicatePortal(
  id: string,
  actorId: string | null,
  kind: PortalKind = 'requester',
): Promise<PortalRow> {
  if (id === STANDARD_PORTAL) {
    return createPortal(
      await freeName(kind === 'approval' ? 'New approval page' : 'New portal'),
      actorId,
      undefined,
      kind,
    );
  }
  const source = await findPortal(id);
  if (!source) throw notFound('That portal no longer exists.');
  return createPortal(await freeName('Copy of ' + source.name), actorId, source);
}

export async function renamePortal(id: string, name: string, actorId: string | null): Promise<void> {
  const portal = await findPortal(id);
  if (!portal) throw notFound('That portal no longer exists.');
  await assertNameFree(name, id);
  await execute('UPDATE portal_themes SET name = ?, updated_at = ? WHERE id = ?', [
    name,
    nowIso(),
    id,
  ]);
  audit({
    action: 'portal.renamed',
    actorId,
    targetType: 'portal',
    targetId: id,
    detail: { from: portal.name, to: name },
  });
}

/** Stores one part. Validation is the caller's, so it can be shown in place. */
/**
 * Puts a portal back to the design a new one starts from.
 *
 * A portal is the administrator's design and nothing here ever rewrites
 * one silently - which is also why a portal written before the 2026 design
 * still looks like what it was written as. This is the other half of that
 * rule: the way to move it, taken deliberately, from a button that says
 * what it replaces.
 *
 * It replaces the layout, the CSS and the Home page - the three the starter
 * defines. The other pages are the administrator's own and are left, as is
 * anything a script part holds.
 */
export async function resetPortalDesign(id: string, actorId: string | null): Promise<void> {
  const portal = await findPortal(id);
  if (!portal) throw notFound('That portal no longer exists.');

  const layout = portal.kind === 'approval' ? STARTER_APPROVAL_LAYOUT : STARTER_LAYOUT;
  const css = portal.kind === 'approval' ? starterApprovalCss() : starterCss();
  const pages =
    portal.kind === 'approval' ? portal.pages : { ...portal.pages, home: STARTER_HOME };

  await execute(
    'UPDATE portal_themes SET layout_html = ?, css = ?, pages = ?, updated_at = ? WHERE id = ?',
    [layout, css, JSON.stringify(pages), nowIso(), id],
  );

  audit({
    action: 'portal.design_reset',
    actorId,
    targetType: 'portal',
    targetId: id,
    detail: { name: portal.name, kind: portal.kind },
  });
}

export async function savePortalPart(
  id: string,
  part: PortalPart,
  code: string,
  actorId: string | null,
): Promise<void> {
  const portal = await findPortal(id);
  if (!portal) throw notFound('That portal no longer exists.');

  if (part === 'layout') {
    await execute('UPDATE portal_themes SET layout_html = ?, updated_at = ? WHERE id = ?', [
      code,
      nowIso(),
      id,
    ]);
  } else if (part === 'css') {
    await execute('UPDATE portal_themes SET css = ?, updated_at = ? WHERE id = ?', [
      code,
      nowIso(),
      id,
    ]);
  } else if (part === 'js') {
    await execute('UPDATE portal_themes SET script = ?, updated_at = ? WHERE id = ?', [
      code,
      nowIso(),
      id,
    ]);
  } else {
    const pages = { ...portal.pages, [part]: code };
    await execute('UPDATE portal_themes SET pages = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(pages),
      nowIso(),
      id,
    ]);
  }
  audit({
    action: 'portal.updated',
    actorId,
    targetType: 'portal',
    targetId: id,
    detail: { name: portal.name, part, live: portal.is_active },
  });
}

/**
 * Makes one portal the default - what every requester sees unless one of
 * their groups is assigned another - or the built-in one.
 *
 * Cleared and set in one transaction, in that order: the partial unique
 * index would refuse the second default row otherwise.
 */
export async function setDefaultPortal(
  id: string,
  actorId: string | null,
  kind: PortalKind = 'requester',
): Promise<void> {
  let name = 'Standard';
  if (id !== STANDARD_PORTAL) {
    const portal = await findPortal(id);
    if (!portal || portal.kind !== kind) throw notFound('That portal no longer exists.');
    name = portal.name;
  }
  await transaction(async (client) => {
    await client.query('UPDATE portal_themes SET is_active = 0 WHERE is_active = 1 AND kind = ?', [
      kind,
    ]);
    if (id !== STANDARD_PORTAL) {
      await client.query('UPDATE portal_themes SET is_active = 1 WHERE id = ?', [id]);
    }
  });
  audit({
    action: 'portal.default.set',
    actorId,
    targetType: 'portal',
    targetId: id,
    detail: { name, kind },
  });
}

/** Why a portal cannot be removed, or null. The single source of the wording. */
export function portalProtectedReason(id: string, portal?: PortalRow): string | null {
  if (id === STANDARD_PORTAL) return 'The standard portal is built in and cannot be removed.';
  if (portal?.is_active) return 'This is the default portal. Set another one as default first.';
  return null;
}

/**
 * Removes a portal. Groups assigned to it go back to the default, in the
 * same transaction - the assignment has no foreign key to do it, because
 * 'standard' is not a row. Returns how many groups that moved.
 */
export async function deletePortal(id: string, actorId: string | null): Promise<number> {
  const portal = id === STANDARD_PORTAL ? undefined : await findPortal(id);
  if (id !== STANDARD_PORTAL && !portal) throw notFound('That portal no longer exists.');
  const refused = portalProtectedReason(id, portal);
  if (refused) throw conflict(refused, 'portal_protected');

  const moved = await portalGroupCount(id);
  await transaction(async (client) => {
    await client.query('DELETE FROM portal_group_assignments WHERE portal_id = ?', [id]);
    await client.query('DELETE FROM portal_themes WHERE id = ?', [id]);
  });
  audit({
    action: 'portal.deleted',
    actorId,
    targetType: 'portal',
    targetId: id,
    detail: { name: portal!.name, groupsMovedToDefault: moved },
  });
  return moved;
}

/** The newest top-level ticket, so the Ticket tab has something to show. */
export async function sampleTicketId(): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM tickets WHERE parent_id IS NULL ORDER BY created_at DESC LIMIT 1',
  );
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Moving a portal nobody has touched onto the current design
// ---------------------------------------------------------------------------

/**
 * The starter as it was before 16 Oct 2026: a masthead with nav pills.
 *
 * Kept **only to recognise it**. A portal whose layout is this, character for
 * character, is one nobody has edited - so it is the old starter rather than
 * somebody's design, and moving it to the current one takes nothing away.
 * Anything else is the administrator's and is never rewritten.
 */
export const OLD_STARTER_LAYOUT = `<header class="portal-bar">
  <a class="portal-brand" href="{{url_home}}">{{logo}}</a>
  {{nav}}
  <div class="portal-account">
    <span class="portal-who">{{user_name}}</span>
    {{button_sign_out}}
  </div>
</header>

<main class="portal-main">
  {{page}}
</main>

<footer class="portal-footer">
  &copy; {{year}} {{app_name}}
</footer>
`;

/**
 * Move every untouched requester portal onto the current design, once.
 *
 * Runs at start-up. **The layout is the test**: a portal whose layout is
 * still the old starter has not been designed, whatever else it holds, and
 * its CSS and Home go with it - they were the matching halves of the same
 * starter. A portal with a layout of its own is left entirely alone, and
 * the pages an administrator wrote (Ticket, Profile...) are kept either way.
 */
export async function adoptCurrentStarter(actorId: string | null = null): Promise<number> {
  const rows = await query<PortalRow>(
    "SELECT * FROM portal_themes WHERE kind = 'requester'",
  );
  let moved = 0;
  for (const row of rows) {
    if (row.layout_html !== OLD_STARTER_LAYOUT) continue;
    const pages = { ...row.pages, home: STARTER_HOME };
    await execute(
      'UPDATE portal_themes SET layout_html = ?, css = ?, pages = ?, updated_at = ? WHERE id = ?',
      [STARTER_LAYOUT, starterCss(), JSON.stringify(pages), nowIso(), row.id],
    );
    moved += 1;
    audit({
      action: 'portal.design_adopted',
      actorId,
      targetType: 'portal',
      targetId: row.id,
      detail: { name: row.name, reason: 'untouched_old_starter' },
    });
  }
  return moved;
}
