import { config as appConfig } from '../config.js';
import { settings } from '../settings/index.js';
import { HttpRequestRefused, sendHttp, type HttpResponse } from './http-client.js';
import { credentialsFor, dropToken } from './automation-connections.js';
import type { TicketListItem } from './tickets.js';

/**
 * The two HTTP steps of an automation: "Send HTTP request" and "Send
 * authenticated HTTP request" (the same, signed in through a connection).
 *
 * A step's settings are strings on the node, like every other step. Values
 * from the ticket and from earlier steps go in through {{variables}}, and
 * each is **encoded for where it lands**: URL-encoded in the address and
 * query, JSON-escaped in a JSON body, form-encoded in a form body, stripped
 * of line breaks in a header. The host itself may not contain a variable, so
 * nothing a requester types can choose where a request goes.
 *
 * What came back is kept for later steps under the step's output name:
 * `{{name.status}}`, `{{name.ok}}`, `{{name.body}}`, `{{name.json.a.b}}`,
 * `{{name.header.x}}` and `{{name.error}}`.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const BODY_TYPES = [
  { key: 'none', label: 'No body' },
  { key: 'json', label: 'JSON' },
  { key: 'form', label: 'Form (name=value per line)' },
  { key: 'text', label: 'Plain text' },
] as const;
export const DEFAULT_TIMEOUT_S = 10;
export const MAX_TIMEOUT_S = 30;
export const MAX_RETRIES = 3;

/** One second, doubling. Shortened by the tests, which cannot wait. */
let retryBaseMs = 1000;
export function setRetryBaseForTests(ms: number): void {
  retryBaseMs = ms;
}

/**
 * Worth trying again: the network failed, the server is busy (429) or broken
 * (5xx). A 4xx other than 429 is an answer, and asking again gets the same.
 * A refusal by our own rules is never retried.
 */
function retryable(response: HttpResponse | null, err: unknown): boolean {
  if (err) return !(err instanceof HttpRequestRefused);
  return response !== null && (response.status === 429 || response.status >= 500);
}

/** How long to wait before the next try: Retry-After when given, else doubling. */
function delayFor(response: HttpResponse | null, attempt: number): number {
  const after = response?.headers['retry-after'];
  const seconds = after && /^\d+$/.test(after) ? Number(after) : NaN;
  if (Number.isFinite(seconds)) return Math.min(seconds, 30) * (retryBaseMs / 1000) * 1000;
  return retryBaseMs * 2 ** attempt;
}

/** Headers a step may not set: the transport's, or the connection's job. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'authorization', 'cookie', 'proxy-authorization']);

const VARIABLE = /\{\{\s*([a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const OUTPUT_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export const TICKET_VARIABLES = [
  'id', 'reference', 'title', 'description', 'status', 'priority', 'type',
  'requester_name', 'requester_email', 'assignee_name', 'group_name', 'url',
] as const;

/** What a step after an HTTP step can read. */
export interface StepOutput {
  status: number;
  ok: boolean;
  body: string;
  json: unknown;
  headers: Record<string, string>;
  error: string;
}

export interface RunContext {
  /** null before a "Create a ticket" step, in a run a request started without one. */
  ticket: TicketListItem | null;
  outputs: Map<string, StepOutput>;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function ticketValue(ticket: TicketListItem | null, key: string): string {
  if (!ticket) return '';
  if (key === 'url') return appConfig.publicOrigin + '/tickets/' + ticket.id;
  const value = (ticket as unknown as Record<string, unknown>)[key];
  return value === null || value === undefined ? '' : String(value);
}

function walk(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Array.isArray(current) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

/** One {{variable}}, as plain text; '' when there is nothing by that name. */
export function variableValue(name: string, ctx: RunContext): string {
  const [head, ...rest] = name.split('.');
  if (head === 'ticket') {
    return rest.length === 1 && (TICKET_VARIABLES as readonly string[]).includes(rest[0]!) ? ticketValue(ctx.ticket, rest[0]!) : '';
  }
  const out = ctx.outputs.get(head ?? '');
  if (!out) return '';
  const [field, ...path] = rest;
  switch (field) {
    case 'status': return String(out.status);
    case 'ok': return out.ok ? 'true' : 'false';
    case 'body': return out.body.slice(0, 65_536);
    case 'error': return out.error;
    case 'header': return path.length === 1 ? out.headers[path[0]!.toLowerCase()] ?? '' : '';
    case 'json': {
      const found = walk(out.json, path);
      if (found === undefined || found === null) return '';
      return typeof found === 'object' ? JSON.stringify(found) : String(found);
    }
    default: return '';
  }
}

export type Encoding = 'raw' | 'url' | 'json' | 'header';

function encode(value: string, how: Encoding): string {
  switch (how) {
    case 'url': return encodeURIComponent(value);
    case 'json': return JSON.stringify(value).slice(1, -1);
    case 'header': return value.replace(/[\r\n]+/g, ' ');
    default: return value;
  }
}

/** Replaces every {{variable}} in `text`, encoded for where it lands. */
export function fillVariables(text: string, ctx: RunContext, how: Encoding): string {
  return text.replace(VARIABLE, (_whole, name: string) => encode(variableValue(name, ctx), how));
}

/** Names a text refers to that no ticket field or earlier output could supply. */
export function unknownVariables(text: string, outputNames: ReadonlySet<string>): string[] {
  const bad: string[] = [];
  for (const [whole, name] of text.matchAll(VARIABLE)) {
    const [head, ...rest] = name!.split('.');
    const ok = head === 'ticket'
      ? rest.length === 1 && (TICKET_VARIABLES as readonly string[]).includes(rest[0]!)
      : outputNames.has(head!) && ['status', 'ok', 'body', 'error', 'json', 'header'].includes(rest[0] ?? '');
    if (!ok) bad.push(whole);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Settings of a step
// ---------------------------------------------------------------------------

function lines(text: string | undefined): string[] {
  return (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
}

function parseHeaders(text: string | undefined): { name: string; value: string }[] | string {
  const out: { name: string; value: string }[] = [];
  for (const line of lines(text)) {
    const at = line.indexOf(':');
    if (at <= 0) return 'Write each header as Name: value, one per line.';
    const name = line.slice(0, at).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return '"' + name.slice(0, 40) + '" is not a header name.';
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return name.toLowerCase() === 'authorization' || name.toLowerCase() === 'cookie'
        ? 'Do not put credentials in a header - use "Send authenticated HTTP request" with a connection.'
        : 'The ' + name + ' header is set automatically.';
    }
    out.push({ name, value: line.slice(at + 1).trim() });
  }
  return out;
}

function parsePairs(text: string | undefined): { name: string; value: string }[] | string {
  const out: { name: string; value: string }[] = [];
  for (const line of lines(text)) {
    const at = line.indexOf('=');
    if (at <= 0) return 'Write each one as name=value, one per line.';
    out.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return out;
}

/** The address with variables stood in for, or why it cannot be one. */
function checkUrl(url: string): string {
  if (!url.trim()) return 'enter the address.';
  const firstVar = url.indexOf('{{');
  let parsed: URL;
  try {
    parsed = new URL(url.replace(VARIABLE, 'x'));
  } catch {
    return 'the address is not a valid URL.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'the address must start with https://.';
  // The scheme, host and port must be written out: a variable there would
  // let ticket text decide where the request goes.
  const authorityEnd = url.indexOf('/', url.indexOf('//') + 2);
  if (firstVar >= 0 && (authorityEnd < 0 || firstVar < authorityEnd)) return 'the host cannot contain a variable.';
  if (parsed.username || parsed.password) return 'put credentials in a connection, not in the address.';
  return '';
}

/**
 * What an HTTP step still needs, or why its settings are wrong, in words;
 * '' when it can run. `outputNames` are the output names of the other steps,
 * which its variables may read.
 */
export function httpStepProblem(c: Record<string, string>, authenticated: boolean, outputNames: ReadonlySet<string> = new Set()): string {
  if (authenticated && !c.connectionId) return 'choose a connection.';
  if (!(HTTP_METHODS as readonly string[]).includes(c.method ?? '')) return 'choose a method.';
  const url = checkUrl(c.url ?? '');
  if (url) return url;
  const headers = parseHeaders(c.headers);
  if (typeof headers === 'string') return headers;
  const queryPairs = parsePairs(c.query);
  if (typeof queryPairs === 'string') return 'query parameters: ' + queryPairs;
  const bodyType = c.bodyType || 'none';
  if (!BODY_TYPES.some((b) => b.key === bodyType)) return 'choose a body type.';
  if (bodyType === 'form' && typeof parsePairs(c.body) === 'string') return 'form body: write each field as name=value, one per line.';
  if (bodyType === 'json' && (c.body ?? '').trim()) {
    try {
      // Variables stand in as strings, which is how they are inserted.
      JSON.parse((c.body ?? '').replace(VARIABLE, 'x'));
    } catch {
      return 'the JSON body is not valid JSON. Put each {{variable}} inside quotes.';
    }
  }
  if (c.timeout && !(Number(c.timeout) >= 1 && Number(c.timeout) <= MAX_TIMEOUT_S)) {
    return 'the timeout must be between 1 and ' + MAX_TIMEOUT_S + ' seconds.';
  }
  if (c.retries && !(/^[0-3]$/.test(c.retries))) return 'retries must be between 0 and ' + MAX_RETRIES + '.';
  if (c.output && !OUTPUT_NAME.test(c.output)) return 'the output name may use lower-case letters, digits and _ only, starting with a letter.';
  if (c.output === 'ticket') return '"ticket" is taken; choose another output name.';
  const others = new Set(outputNames);
  if (c.output) others.delete(c.output);
  const unknown = ['url', 'query', 'headers', 'body'].flatMap((k) => unknownVariables(c[k] ?? '', others));
  if (unknown.length > 0) return 'unknown variable ' + unknown[0] + '.';
  return '';
}

// ---------------------------------------------------------------------------
// Running a step
// ---------------------------------------------------------------------------

function buildRequest(c: Record<string, string>, ctx: RunContext) {
  const url = new URL(fillVariables(c.url ?? '', ctx, 'url'));
  for (const pair of parsePairs(c.query) as { name: string; value: string }[]) {
    url.searchParams.append(pair.name, fillVariables(pair.value, ctx, 'raw'));
  }
  const headers: Record<string, string> = {};
  for (const h of parseHeaders(c.headers) as { name: string; value: string }[]) {
    headers[h.name.toLowerCase()] = fillVariables(h.value, ctx, 'header');
  }
  const method = c.method ?? 'GET';
  const bodyType = c.bodyType || 'none';
  let body: string | undefined;
  if (bodyType !== 'none' && method !== 'GET') {
    if (bodyType === 'json') {
      body = fillVariables(c.body ?? '', ctx, 'json');
      headers['content-type'] ??= 'application/json';
    } else if (bodyType === 'form') {
      const form = new URLSearchParams();
      for (const pair of parsePairs(c.body) as { name: string; value: string }[]) form.append(pair.name, fillVariables(pair.value, ctx, 'raw'));
      body = form.toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else {
      body = fillVariables(c.body ?? '', ctx, 'raw');
      headers['content-type'] ??= 'text/plain; charset=utf-8';
    }
  }
  headers.accept ??= 'application/json, text/plain;q=0.9, */*;q=0.5';
  const timeout = Number(c.timeout) >= 1 ? Math.min(Number(c.timeout), MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S;
  return { method, url, headers, body, timeoutMs: timeout * 1000 };
}

function toOutput(response: HttpResponse): StepOutput {
  let json: unknown = null;
  const type = response.headers['content-type'] ?? '';
  if (!response.truncated && (type.includes('json') || /^\s*[[{]/.test(response.body))) {
    try {
      json = JSON.parse(response.body);
    } catch {
      json = null;
    }
  }
  const ok = response.status >= 200 && response.status < 300;
  return { status: response.status, ok, body: response.body, json, headers: response.headers, error: ok ? '' : 'HTTP ' + response.status };
}

/** "POST https://api.example.com/v1/items" - never the query, which may carry a key. */
function describe(method: string, url: URL): string {
  return method + ' ' + url.origin + url.pathname;
}

/**
 * Runs one HTTP step: sends, records the output, and returns the line for
 * the run's log. With "On failure: stop" (the default) a failure throws and
 * ends the run as failed; with "continue" it is recorded and the run goes on,
 * so a later If can look at {{name.ok}}.
 */
export async function runHttpStep(c: Record<string, string>, ctx: RunContext, authenticated: boolean): Promise<string> {
  // An enabled automation can be edited; its settings are checked again
  // here rather than trusted from when it was switched on.
  const problem = httpStepProblem(c, authenticated, new Set([...ctx.outputs.keys(), ...(c.output ? [c.output] : [])]));
  if (problem && !problem.startsWith('unknown variable')) throw new Error('not run: ' + problem);
  const request = buildRequest(c, ctx);
  const allowPrivate = settings().httpRequests.allowPrivateNetwork;
  const label = describe(request.method, request.url);

  const retries = /^[0-3]$/.test(c.retries ?? '') ? Number(c.retries) : 0;
  let output: StepOutput;
  let line: string;
  let attempt = 0;
  for (;;) {
  try {
    let response: HttpResponse;
    if (authenticated) {
      let renewable = false;
      const send = async (force: boolean) => {
        const creds = await credentialsFor(c.connectionId ?? '', { force });
        renewable = creds.renewable;
        return sendHttp(
          {
            ...request,
            headers: creds.header ? { ...request.headers, [creds.header.name]: creds.header.value } : request.headers,
            ...(creds.tls ? { tls: creds.tls } : {}),
          },
          { allowPrivate },
        );
      };
      response = await send(false);
      if (response.status === 401 && renewable) {
        // Revoked or expired early: one fresh token, one more try.
        dropToken(c.connectionId ?? '');
        response = await send(true);
      }
    } else {
      response = await sendHttp(request, { allowPrivate });
    }
    output = toOutput(response);
    line = label + ' -> ' + response.status + ' in ' + response.ms + ' ms' + (response.truncated ? ' (answer cut at 1 MB)' : '');
    if (attempt < retries && retryable(response, null)) {
      await new Promise((r) => setTimeout(r, delayFor(response, attempt)));
      attempt += 1;
      continue;
    }
  } catch (err) {
    const message = err instanceof HttpRequestRefused || err instanceof Error ? err.message : String(err);
    output = { status: 0, ok: false, body: '', json: null, headers: {}, error: message };
    line = label + ' -> ' + message;
    if (attempt < retries && retryable(null, err)) {
      await new Promise((r) => setTimeout(r, delayFor(null, attempt)));
      attempt += 1;
      continue;
    }
  }
  break;
  }
  if (attempt > 0) line += ' (after ' + attempt + ' retr' + (attempt === 1 ? 'y' : 'ies') + ')';

  if (c.output) ctx.outputs.set(c.output, output);
  if (!output.ok && (c.onError ?? 'stop') === 'stop') {
    throw new Error(line);
  }
  return line;
}

// ---------------------------------------------------------------------------
// "Save and test", from the step's popup
// ---------------------------------------------------------------------------

/**
 * An invented ticket for a test request, so that testing never sends a real
 * requester's ticket to somebody else's system.
 */
function sampleTicket(): TicketListItem {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    reference: 'INC-000123',
    title: 'Printer on the third floor is jammed',
    description: 'Paper jam in tray 2. Sample ticket for a test request.',
    status: 'open',
    priority: 'normal',
    type: 'incident',
    requester_name: 'Sample Requester',
    requester_email: 'requester@example.com',
    assignee_name: null,
    group_name: 'Service desk',
  } as unknown as TicketListItem;
}

export interface HttpTestResult {
  ok: boolean;
  /** The log line: method, origin and path, status and time - or why not. */
  line: string;
  status: number;
  contentType: string;
  /** The first part of the answer, for the administrator to read. */
  preview: string;
}

/**
 * Sends a step's request once, now, with a sample ticket: no retries, and
 * nothing from earlier steps (those variables come out empty). The same
 * transport and the same rules as a real run - including the connection's
 * credentials, which are never shown.
 */
export async function testHttpStep(c: Record<string, string>, authenticated: boolean): Promise<HttpTestResult> {
  const ctx: RunContext = { ticket: sampleTicket(), outputs: new Map() };
  const settingsForTest = { ...c, retries: '0', onError: 'continue', output: 'test' };
  let line: string;
  try {
    line = await runHttpStep(settingsForTest, ctx, authenticated);
  } catch (err) {
    return { ok: false, line: err instanceof Error ? err.message : String(err), status: 0, contentType: '', preview: '' };
  }
  const out = ctx.outputs.get('test');
  const body = out?.body ?? '';
  return {
    ok: out?.ok ?? false,
    line,
    status: out?.status ?? 0,
    contentType: out?.headers['content-type'] ?? '',
    preview: body.length > 1500 ? body.slice(0, 1500) + '\n...' : body,
  };
}
