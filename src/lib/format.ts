import { settings, type DateFormat, type LocaleSettings } from '../settings/index.js';

/** Template helpers. Every value they return is escaped again by EJS. */

/** Month names as the "21 Oct 2026" format spells them; translated through t() (i18n/localise.ts). */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days of the week, shortened, Monday first: "Due Thu 12:00". Translated through t(). */
export const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The reader's language, or English: these helpers are also called outside a page. */
type Words = (text: string) => string;
const asIs: Words = (text) => text;

/** The calendar and clock of an instant in a time zone. */
function partsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

const pad = (n: number) => String(n).padStart(2, '0');

function datePart(p: { y: number; m: number; d: number }, format: DateFormat, t: Words = asIs): string {
  switch (format) {
    case 'dd.MM.yyyy':
      return pad(p.d) + '.' + pad(p.m) + '.' + p.y;
    case 'd. M. yyyy':
      return p.d + '. ' + p.m + '. ' + p.y;
    case 'dd/MM/yyyy':
      return pad(p.d) + '/' + pad(p.m) + '/' + p.y;
    case 'MM/dd/yyyy':
      return pad(p.m) + '/' + pad(p.d) + '/' + p.y;
    case 'yyyy-MM-dd':
      return p.y + '-' + pad(p.m) + '-' + pad(p.d);
    default:
      return pad(p.d) + ' ' + t(MONTHS[p.m - 1]!) + ' ' + p.y;
  }
}

function timePart(p: { h: number; min: number }, format: '24h' | '12h'): string {
  if (format === '24h') return pad(p.h) + ':' + pad(p.min);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return h12 + ':' + pad(p.min) + ' ' + (p.h < 12 ? 'AM' : 'PM');
}

/** A date and time as Settings - Customisation - Locale says to write it. */
export function formatDateTimeIn(date: Date, locale: LocaleSettings, t: Words = asIs): string {
  const p = partsIn(date, locale.timeZone);
  return datePart(p, locale.dateFormat, t) + ' ' + timePart(p, locale.timeFormat);
}

/**
 * Accepts the ISO text the database stores, or a Date, so a view never has
 * to know which it holds.
 */
export function formatDateTime(value: string | Date | null | undefined, t: Words = asIs): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return formatDateTimeIn(date, settings().locale, t);
}

/** Just the date, as a given locale writes it. */
export function formatDateIn(date: Date, locale: LocaleSettings): string {
  return datePart(partsIn(date, locale.timeZone), locale.dateFormat);
}

/** Just the date, in the Locale's format. */
export function formatDate(value: string | Date | null | undefined, t: Words = asIs): string {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const locale = settings().locale;
  return datePart(partsIn(date, locale.timeZone), locale.dateFormat, t);
}

const UNITS: [limit: number, seconds: number, name: string][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
  [31_536_000, 2_592_000, 'month'],
  [Number.POSITIVE_INFINITY, 31_536_000, 'year'],
];

/** A span of time, short: "1 h 12 m", "3 d 4 h", "45 m". Sign ignored. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(Math.round(Math.abs(ms) / 60_000), 0);
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return d + ' d' + (h ? ' ' + h + ' h' : '');
  if (h > 0) return h + ' h' + (m ? ' ' + m + ' m' : '');
  return m + ' m';
}

/**
 * A long file name, shortened in the **middle**.
 *
 * An uploaded name can be a hundred random characters, and shown whole it
 * wrapped over three lines and pushed everything else down the page -
 * reported 15 Oct 2026. Cut at the end instead and the extension goes with
 * it, which is the part a reader scans for, so the end is kept and the
 * middle gives way. The whole name stays in the element's `title`.
 */
export function shortFileName(name: string, limit = 52): string {
  const text = String(name ?? '');
  if (text.length <= limit) return text;

  // Keep the extension, and enough before it to recognise the file.
  const dot = text.lastIndexOf('.');
  const extension = dot > 0 && text.length - dot <= 12 ? text.slice(dot) : '';
  const tail = Math.min(10, Math.max(0, limit - 20)) + extension.length;
  const head = Math.max(8, limit - tail - 1);

  return text.slice(0, head) + '…' + text.slice(text.length - tail);
}

/**
 * "5 minutes ago", as patterns so a translation can put the number where its
 * grammar wants it. Listed whole, one and many, for the translator's document.
 */
export const RELATIVE_PATTERNS = [
  'just now',
  ...UNITS.flatMap(([, , name]) => ['{0} ' + name + ' ago', '{0} ' + name + 's ago']),
];

export function formatRelative(iso: string | null | undefined, t: Words = asIs): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const seconds = Math.max(Math.round((Date.now() - then) / 1000), 0);
  if (seconds < 45) return t('just now');
  for (const [limit, divisor, name] of UNITS) {
    if (seconds < limit) {
      const value = Math.round(seconds / divisor);
      const pattern = '{0} ' + name + (value === 1 ? '' : 's') + ' ago';
      const said = t(pattern);
      return (said.includes('{0}') ? said : pattern).replace('{0}', String(value));
    }
  }
  return '-';
}

/** Pretty-prints the JSON detail column of an audit entry. */
/**
 * An audit entry's detail, as "reference: INC-000123, withFiles: 2".
 *
 * The data layer already parses the column (JSON_COLUMNS), so it arrives as
 * an object; this read it as text, failed, and printed "[object Object]"
 * (reported 21 Oct 2026). Text from before is still accepted.
 */
export function formatDetail(detail: unknown): string {
  if (detail === null || detail === undefined || detail === '') return '';
  let value: unknown = detail;
  if (typeof detail === 'string') {
    try {
      value = JSON.parse(detail);
    } catch {
      return detail;
    }
  }
  if (typeof value !== 'object' || value === null) return String(value);
  const show = (v: unknown): string =>
    v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (Array.isArray(value)) return value.map(show).join(', ');
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => k + ': ' + show(v))
    .join(', ');
}

/** An audit detail as [name, value] pairs, one per line in the audit trail's panel. */
export function detailPairs(detail: unknown): [string, string][] {
  if (detail === null || detail === undefined || detail === '') return [];
  let value: unknown = detail;
  if (typeof detail === 'string') {
    try {
      value = JSON.parse(detail);
    } catch {
      return [['detail', detail]];
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [['detail', formatDetail(value)]];
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [
    k,
    v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v),
  ]);
}

/** Builds a query string, dropping empty values, for filter and page links. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === null) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? '?' + rendered : '';
}

/**
 * Display labels for values that are stored as lower-case identifiers.
 * The database keeps machine-readable values; only these reach the screen.
 */
const PROVISIONING_LABELS: Record<string, string> = {
  jit: 'JIT',
  sync: 'Sync',
  'jit+sync': 'JIT + sync',
};

export const ROLE_LABELS: Record<string, string> = {
  user: 'User',
  agent: 'Agent',
  admin: 'Admin',
};

const SOURCE_LABELS: Record<string, string> = {
  jit: 'JIT',
  sync: 'Sync',
  manual: 'Manual',
  dev: 'Dev stub',
  // A password account later connected to a provider (/login/link) keeps its source.
  local: 'Linked',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  disabled: 'Disabled',
  running: 'Running',
  success: 'Success',
  error: 'Error',
};

const AUTH_MODE_LABELS: Record<string, string> = {
  oidc: 'OpenID Connect',
};

const TRIGGER_LABELS: Record<string, string> = {
  schedule: 'Scheduled',
  manual: 'Manual',
  cli: 'Command line',
  startup: 'Startup',
};

function label(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '-';
  return map[value] ?? value;
}

export const provisioningLabel = (v: string | null | undefined) => label(PROVISIONING_LABELS, v);
export const roleLabel = (v: string | null | undefined) => label(ROLE_LABELS, v);
export const sourceLabel = (v: string | null | undefined) => label(SOURCE_LABELS, v);
export const stateLabel = (v: string | null | undefined) => label(STATUS_LABELS, v);
export const authModeLabel = (v: string | null | undefined) => label(AUTH_MODE_LABELS, v);
export const triggerLabel = (v: string | null | undefined) => label(TRIGGER_LABELS, v);
