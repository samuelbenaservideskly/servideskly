import crypto from 'node:crypto';
import { execute, query, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { newId, nowIso, randomToken } from '../lib/util.js';
import { config as appConfig } from '../config.js';
import { isSealed, open, seal } from '../lib/secret-box.js';
import { settings } from '../settings/index.js';
import { sendHttp } from './http-client.js';

const log = logger.child({ module: 'automation-connections' });

/**
 * Connections: Settings - Advanced - Connections. The credentials an
 * "Send authenticated HTTP request" step signs in with, kept out of the
 * automation's graph so the graph can be shown, audited and copied without
 * carrying a secret.
 *
 * OAuth 2.0 client credentials (RFC 6749 section 4.4): the client id and
 * secret are exchanged at the token endpoint for an access token, which is
 * sent as a Bearer token.
 *
 * - The **secret is sealed** (secret-box) and never shown again; blank on an
 *   edit means keep it.
 * - The **access token lives in memory only**, per connection, and is
 *   reused until a minute before it expires. A restart simply asks for a
 *   new one. Nothing about it is logged or put in a run's steps.
 * - A 401 from the API drops the cached token and the step asks once more,
 *   which covers a token revoked before its time.
 *
 * Two more types (migration 45):
 *
 * - **Client certificate (mTLS)**: a PEM certificate and its private key,
 *   presented in the TLS handshake. The key (and its passphrase) is sealed;
 *   the certificate is public and shown with its subject and expiry. Both are
 *   checked to belong together when saved.
 * - **OAuth 2.0, signed in as a person** (authorization code with PKCE): an
 *   administrator presses Sign in, consents at the provider, and the refresh
 *   token is kept, sealed, to get access tokens on that person's behalf. A
 *   rotated refresh token replaces the stored one. Changing where it signs in
 *   (authorize or token address, client id) forgets the sign-in.
 */

export type ClientAuth = 'basic' | 'body';
export type AuthType = 'oauth2' | 'api_key' | 'basic' | 'mtls' | 'oauth2_user';
export const AUTH_TYPES: { key: AuthType; label: string }[] = [
  { key: 'oauth2', label: 'OAuth 2.0 (app)' },
  { key: 'oauth2_user', label: 'OAuth 2.0 (person)' },
  { key: 'api_key', label: 'API key' },
  { key: 'basic', label: 'Basic' },
  { key: 'mtls', label: 'Client certificate' },
];

export function authTypeLabel(type: string): string {
  return AUTH_TYPES.find((t) => t.key === type)?.label ?? 'OAuth 2.0 (app)';
}

/** Where a provider sends an administrator back after "Sign in". Register it there. */
export function connectionRedirectUri(): string {
  return appConfig.publicOrigin + '/admin/settings/advanced/connections/oauth/callback';
}

export interface ConnectionRow {
  id: string;
  name: string;
  auth_type: AuthType;
  header_name: string;
  value_prefix: string;
  token_url: string;
  client_id: string;
  client_secret: string;
  scope: string;
  audience: string;
  client_auth: ClientAuth;
  authorize_url: string;
  client_cert: string;
  client_key: string;
  refresh_token: string;
  signed_in_by: string;
  signed_in_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A connection as the pages see it: never the secret. */
export interface ConnectionView {
  id: string;
  name: string;
  auth_type: AuthType;
  header_name: string;
  value_prefix: string;
  token_url: string;
  client_id: string;
  scope: string;
  audience: string;
  client_auth: ClientAuth;
  hasSecret: boolean;
  authorize_url: string;
  /** mTLS: the certificate's subject and last day, read from the PEM. */
  certSubject: string;
  certExpires: string;
  hasKey: boolean;
  /** OAuth as a person: whether somebody has signed in, who, and when. */
  signedIn: boolean;
  signed_in_by: string;
  signed_in_at: string | null;
  updated_at: string;
}

function certInfo(pem: string): { subject: string; expires: string } {
  if (!pem) return { subject: '', expires: '' };
  try {
    const cert = new crypto.X509Certificate(pem);
    const cn = /CN=([^\n,]+)/.exec(cert.subject)?.[1] ?? cert.subject.split('\n')[0] ?? '';
    return { subject: cn, expires: new Date(cert.validTo).toISOString().slice(0, 10) };
  } catch {
    return { subject: '', expires: '' };
  }
}

function view(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    name: row.name,
    auth_type: row.auth_type ?? 'oauth2',
    header_name: row.header_name ?? '',
    value_prefix: row.value_prefix ?? '',
    token_url: row.token_url,
    client_id: row.client_id,
    scope: row.scope,
    audience: row.audience,
    client_auth: row.client_auth,
    hasSecret: row.client_secret !== '',
    authorize_url: row.authorize_url ?? '',
    certSubject: certInfo(row.client_cert ?? '').subject,
    certExpires: certInfo(row.client_cert ?? '').expires,
    hasKey: (row.client_key ?? '') !== '',
    signedIn: (row.refresh_token ?? '') !== '',
    signed_in_by: row.signed_in_by ?? '',
    signed_in_at: row.signed_in_at ?? null,
    updated_at: row.updated_at,
  };
}

export async function listConnections(): Promise<ConnectionView[]> {
  return (await query<ConnectionRow>('SELECT * FROM automation_connections ORDER BY lower(name)')).map(view);
}

export async function findConnection(id: string): Promise<ConnectionView | undefined> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  return row ? view(row) : undefined;
}

export interface ConnectionInput {
  name: string;
  authType: AuthType;
  /** API key: the header it travels in, and what goes before the key. */
  headerName: string;
  valuePrefix: string;
  tokenUrl: string;
  clientId: string;
  /** Blank on an edit keeps the stored one. */
  clientSecret: string;
  scope: string;
  audience: string;
  clientAuth: ClientAuth;
  /** OAuth as a person: where the administrator is sent to sign in. */
  authorizeUrl?: string;
  /** mTLS: PEM text. Blank on an edit keeps the stored one. */
  clientCert?: string;
  clientKey?: string;
  keyPassphrase?: string;
}

/** Why a certificate and key cannot be used together, or ''. */
export function certificateProblem(cert: string, key: string, passphrase: string): string {
  let x509: crypto.X509Certificate;
  try {
    x509 = new crypto.X509Certificate(cert);
  } catch {
    return 'That is not a PEM certificate (-----BEGIN CERTIFICATE-----).';
  }
  if (new Date(x509.validTo).getTime() < Date.now()) return 'That certificate expired on ' + new Date(x509.validTo).toISOString().slice(0, 10) + '.';
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(passphrase ? { key, passphrase } : { key });
  } catch {
    return 'The private key cannot be read' + (passphrase ? ' with that passphrase.' : '. Is it protected by a passphrase?');
  }
  if (!x509.checkPrivateKey(privateKey)) return 'The private key does not belong to that certificate.';
  return '';
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Why this input cannot be saved, by field. */
export function connectionProblems(input: ConnectionInput, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.name.trim() || input.name.length > 80) errors.name = 'Give the connection a name of up to 80 characters.';
  if (input.clientSecret.length > 2000) errors.clientSecret = 'That secret is longer than 2,000 characters.';
  if (input.authType === 'api_key') {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(input.headerName)) errors.headerName = 'Enter the header the key goes in, such as X-API-Key.';
    else if (['host', 'content-length', 'transfer-encoding', 'connection', 'cookie'].includes(input.headerName.toLowerCase())) {
      errors.headerName = 'That header cannot carry a key.';
    }
    if (/[\r\n]/.test(input.valuePrefix) || input.valuePrefix.length > 40) errors.valuePrefix = 'Keep the prefix short, such as "Bearer ".';
    if (!editing && !input.clientSecret) errors.clientSecret = 'Enter the key.';
    return errors;
  }
  if (input.authType === 'basic') {
    if (!input.clientId.trim() || input.clientId.length > 500 || input.clientId.includes(':')) errors.clientId = 'Enter the username (it cannot contain a colon).';
    if (!editing && !input.clientSecret) errors.clientSecret = 'Enter the password.';
    return errors;
  }
  if (input.authType === 'mtls') {
    if (!editing && !(input.clientCert ?? '').trim()) errors.clientCert = 'Paste the certificate.';
    if (!editing && !(input.clientKey ?? '').trim()) errors.clientKey = 'Paste the private key.';
    if ((input.clientCert ?? '').length > 20_000 || (input.clientKey ?? '').length > 20_000) errors.clientCert = 'That is longer than a certificate and key should be.';
    // Both given: they must belong together. One given on an edit is
    // checked against the stored other half when it is saved.
    if (!errors.clientCert && !errors.clientKey && (input.clientCert ?? '').trim() && (input.clientKey ?? '').trim()) {
      const problem = certificateProblem((input.clientCert ?? '').trim(), (input.clientKey ?? '').trim(), (input.keyPassphrase ?? ''));
      if (problem) errors.clientCert = problem;
    }
    return errors;
  }
  if (input.authType === 'oauth2_user' && !httpsUrl((input.authorizeUrl ?? ''))) {
    errors.authorizeUrl = 'Enter the authorization endpoint, such as https://login.example.com/oauth2/authorize.';
  }
  let url: URL | null = null;
  try {
    url = new URL(input.tokenUrl);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    errors.tokenUrl = 'Enter the token endpoint address, such as https://login.example.com/oauth2/token.';
  }
  if (!input.clientId.trim() || input.clientId.length > 500) errors.clientId = 'Enter the client id.';
  if (!editing && !input.clientSecret) errors.clientSecret = 'Enter the client secret.';
  if (input.scope.length > 1000) errors.scope = 'Keep the scope under 1,000 characters.';
  if (input.audience.length > 500) errors.audience = 'Keep the audience under 500 characters.';
  return errors;
}

async function assertName(name: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM automation_connections WHERE lower(name) = lower(?)', [name]);
  if (clash && clash.id !== exceptId) throw conflict('A connection with that name already exists.', 'connection_name_taken');
}

export async function createConnection(input: ConnectionInput, actorId: string | null): Promise<string> {
  await assertName(input.name.trim(), null);
  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO automation_connections
       (id, name, auth_type, header_name, value_prefix, token_url, client_id, client_secret, scope, audience, client_auth,
        authorize_url, client_cert, client_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name.trim(),
      input.authType,
      input.authType === 'api_key' ? input.headerName.trim() : '',
      input.authType === 'api_key' ? input.valuePrefix : '',
      input.authType === 'mtls' ? '' : input.tokenUrl.trim(),
      input.authType === 'mtls' ? '' : input.clientId.trim(),
      input.authType === 'mtls' ? '' : JSON.stringify(seal(input.clientSecret)),
      input.scope.trim(),
      input.audience.trim(),
      input.clientAuth,
      input.authType === 'oauth2_user' ? (input.authorizeUrl ?? '').trim() : '',
      input.authType === 'mtls' ? (input.clientCert ?? '').trim() : '',
      input.authType === 'mtls' ? sealedKey((input.clientKey ?? '').trim(), (input.keyPassphrase ?? '')) : '',
      now,
      now,
    ],
  );
  audit({
    action: 'automation_connection.created',
    actorId,
    targetType: 'automation_connection',
    targetId: id,
    detail: { name: input.name.trim(), type: input.authType, tokenUrl: input.tokenUrl.trim(), clientId: input.clientId.trim() },
  });
  return id;
}

export async function updateConnection(id: string, input: ConnectionInput, actorId: string | null): Promise<void> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (!row) throw notFound('That connection no longer exists.');
  await assertName(input.name.trim(), id);
  const secret = input.clientSecret ? JSON.stringify(seal(input.clientSecret)) : row.client_secret;
  // mTLS: a half left blank keeps the stored one, and the pair must still match.
  const cert = input.authType === 'mtls' ? (input.clientCert ?? '').trim() || row.client_cert : '';
  const key = input.authType === 'mtls' ? ((input.clientKey ?? '').trim() ? sealedKey((input.clientKey ?? '').trim(), (input.keyPassphrase ?? '')) : row.client_key) : '';
  if (input.authType === 'mtls') {
    if (!cert || !key) throw conflict('Paste both the certificate and its private key.', 'connection_certificate');
    const stored = openKey(key);
    const problem = certificateProblem(cert, stored.key, stored.passphrase);
    if (problem) throw conflict(problem, 'connection_certificate');
  }
  // Signing in somewhere else is a new sign-in.
  const sameSignIn =
    row.auth_type === input.authType && row.token_url === input.tokenUrl.trim() &&
    row.client_id === input.clientId.trim() && (row.authorize_url ?? '') === (input.authorizeUrl ?? '').trim();
  await execute(
    `UPDATE automation_connections SET name = ?, auth_type = ?, header_name = ?, value_prefix = ?, token_url = ?,
            client_id = ?, client_secret = ?, scope = ?, audience = ?, client_auth = ?, authorize_url = ?,
            client_cert = ?, client_key = ?, refresh_token = ?, signed_in_by = ?, signed_in_at = ?, updated_at = ? WHERE id = ?`,
    [input.name.trim(), input.authType, input.authType === 'api_key' ? input.headerName.trim() : '',
      input.authType === 'api_key' ? input.valuePrefix : '', input.tokenUrl.trim(), input.clientId.trim(), secret, input.scope.trim(), input.audience.trim(), input.clientAuth,
      input.authType === 'oauth2_user' ? (input.authorizeUrl ?? '').trim() : '', cert, key,
      sameSignIn ? row.refresh_token ?? '' : '', sameSignIn ? row.signed_in_by ?? '' : '', sameSignIn ? row.signed_in_at ?? null : null,
      nowIso(), id],
  );
  tokens.delete(id);
  audit({
    action: 'automation_connection.updated',
    actorId,
    targetType: 'automation_connection',
    targetId: id,
    detail: { name: input.name.trim(), secretChanged: Boolean(input.clientSecret) },
  });
}

/** Removes a connection. Refused while a step still signs in with it. */
export async function deleteConnection(id: string, usedBy: string[], actorId: string | null): Promise<void> {
  if (usedBy.length > 0) {
    throw conflict('Still used by ' + usedBy.join(', ') + '. Change those steps first.', 'connection_in_use');
  }
  await execute('DELETE FROM automation_connections WHERE id = ?', [id]);
  tokens.delete(id);
  audit({ action: 'automation_connection.deleted', actorId, targetType: 'automation_connection', targetId: id });
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
  version: string;
}

const tokens = new Map<string, CachedToken>();
const pending = new Map<string, Promise<CachedToken>>();

/** Forgets every cached token. For tests, and harmless otherwise. */
export function clearTokenCache(): void {
  tokens.clear();
  pending.clear();
}

/** Forgets one connection's token, after the API refused it. */
export function dropToken(id: string): void {
  tokens.delete(id);
}

const TOKEN_TIMEOUT_MS = 10_000;
const REFRESH_EARLY_MS = 60_000;

function sealedKey(key: string, passphrase: string): string {
  return JSON.stringify(seal(JSON.stringify({ key, passphrase })));
}

function openKey(stored: string): { key: string; passphrase: string } {
  try {
    const parsed = JSON.parse(stored || 'null');
    if (!isSealed(parsed)) return { key: '', passphrase: '' };
    const inner = JSON.parse(open(parsed)) as { key?: string; passphrase?: string };
    return { key: inner.key ?? '', passphrase: inner.passphrase ?? '' };
  } catch {
    return { key: '', passphrase: '' };
  }
}

function openSealed(stored: string): string {
  try {
    const parsed = JSON.parse(stored || 'null');
    return isSealed(parsed) ? open(parsed) : '';
  } catch {
    return '';
  }
}

/** The client credentials of a token request, in the body or as Basic. */
function clientCredentials(row: ConnectionRow, form: URLSearchParams, headers: Record<string, string>): void {
  const secret = openSealed(row.client_secret);
  if (row.client_auth === 'basic') {
    // RFC 6749 2.3.1: each part form-encoded before joining.
    const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    headers.authorization = 'Basic ' + Buffer.from(enc(row.client_id) + ':' + enc(secret)).toString('base64');
  } else {
    form.set('client_id', row.client_id);
    if (secret) form.set('client_secret', secret);
  }
}

/** Posts to the token endpoint; the parsed answer, or an error that repeats only the OAuth error code. */
async function tokenEndpoint(row: ConnectionRow, form: URLSearchParams): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  clientCredentials(row, form, headers);
  const response = await sendHttp(
    { method: 'POST', url: new URL(row.token_url), headers, body: form.toString(), timeoutMs: TOKEN_TIMEOUT_MS },
    { allowPrivate: settings().httpRequests.allowPrivateNetwork },
  );
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (response.status < 200 || response.status >= 300 || typeof parsed.access_token !== 'string') {
    const code = typeof parsed.error === 'string' ? parsed.error.slice(0, 60).replace(/[^\w.-]/g, '') : '';
    if (code === 'invalid_grant' && form.get('grant_type') === 'refresh_token') {
      throw new Error('the sign-in has expired or was withdrawn; sign in again on the connection');
    }
    throw new Error('the token endpoint answered ' + response.status + (code ? ' (' + code + ')' : ''));
  }
  const type = typeof parsed.token_type === 'string' ? parsed.token_type.toLowerCase() : 'bearer';
  if (type !== 'bearer') throw new Error('the token endpoint issued a ' + type.slice(0, 20) + ' token; only Bearer is supported');
  return parsed;
}

function cachedFrom(row: ConnectionRow, parsed: Record<string, unknown>): CachedToken {
  const lifetime = Number(parsed.expires_in);
  const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, 86_400) : 3600;
  log.info({ connectionId: row.id, expiresIn: seconds }, 'access token obtained');
  return { token: parsed.access_token as string, expiresAt: Date.now() + seconds * 1000, version: row.updated_at };
}

/** OAuth as a person: a fresh access token from the stored refresh token, keeping a rotated one. */
async function refreshUserToken(row: ConnectionRow): Promise<CachedToken> {
  const refresh = openSealed(row.refresh_token ?? '');
  if (!refresh) throw new Error('nobody has signed in to this connection yet; press Sign in on it');
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  if (row.scope) form.set('scope', row.scope);
  const parsed = await tokenEndpoint(row, form);
  if (typeof parsed.refresh_token === 'string' && parsed.refresh_token !== refresh) {
    await execute('UPDATE automation_connections SET refresh_token = ? WHERE id = ?', [JSON.stringify(seal(parsed.refresh_token)), row.id]);
  }
  return cachedFrom(row, parsed);
}

/** "Sign in" on a connection: where to send the administrator, and what to remember until they return. */
export async function startUserSignIn(id: string): Promise<{ url: string; state: string; verifier: string }> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (!row || row.auth_type !== 'oauth2_user') throw notFound('That connection does not sign in as a person.');
  const state = randomToken(24);
  const verifier = randomToken(32);
  const url = new URL(row.authorize_url);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', row.client_id);
  url.searchParams.set('redirect_uri', connectionRedirectUri());
  if (row.scope) url.searchParams.set('scope', row.scope);
  if (row.audience) url.searchParams.set('audience', row.audience);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, verifier };
}

/** The provider sent the administrator back with a code: keep the refresh token it buys. */
export async function finishUserSignIn(id: string, code: string, verifier: string, who: string, actorId: string | null): Promise<void> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (!row || row.auth_type !== 'oauth2_user') throw notFound('That connection does not sign in as a person.');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: connectionRedirectUri(), code_verifier: verifier });
  const parsed = await tokenEndpoint(row, form);
  if (typeof parsed.refresh_token !== 'string') {
    throw conflict('The provider gave no refresh token, so the connection would stop working within the hour. Add offline_access (or the provider\'s equivalent) to the scope.', 'connection_no_refresh');
  }
  await execute('UPDATE automation_connections SET refresh_token = ?, signed_in_by = ?, signed_in_at = ? WHERE id = ?', [
    JSON.stringify(seal(parsed.refresh_token)),
    who.slice(0, 200),
    nowIso(),
    id,
  ]);
  tokens.set(id, cachedFrom(row, parsed));
  audit({ action: 'automation_connection.signed_in', actorId, targetType: 'automation_connection', targetId: id });
}

async function requestToken(row: ConnectionRow): Promise<CachedToken> {
  if (row.auth_type === 'oauth2_user') return refreshUserToken(row);
  const secret = isSealed(JSON.parse(row.client_secret || 'null')) ? open(JSON.parse(row.client_secret)) : '';
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (row.scope) form.set('scope', row.scope);
  if (row.audience) form.set('audience', row.audience);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (row.client_auth === 'basic') {
    // RFC 6749 2.3.1: each part form-encoded before joining.
    const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
    headers.authorization = 'Basic ' + Buffer.from(enc(row.client_id) + ':' + enc(secret)).toString('base64');
  } else {
    form.set('client_id', row.client_id);
    form.set('client_secret', secret);
  }

  const response = await sendHttp(
    { method: 'POST', url: new URL(row.token_url), headers, body: form.toString(), timeoutMs: TOKEN_TIMEOUT_MS },
    { allowPrivate: settings().httpRequests.allowPrivateNetwork },
  );

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  if (response.status < 200 || response.status >= 300 || typeof parsed.access_token !== 'string') {
    // The OAuth error code is safe to repeat; the description may echo
    // input, so it is not.
    const code = typeof parsed.error === 'string' ? ' (' + parsed.error.slice(0, 60).replace(/[^\w.-]/g, '') + ')' : '';
    throw new Error('the token endpoint answered ' + response.status + code);
  }
  const type = typeof parsed.token_type === 'string' ? parsed.token_type.toLowerCase() : 'bearer';
  if (type !== 'bearer') throw new Error('the token endpoint issued a ' + type.slice(0, 20) + ' token; only Bearer is supported');
  const lifetime = Number(parsed.expires_in);
  const seconds = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(lifetime, 86_400) : 3600;
  log.info({ connectionId: row.id, expiresIn: seconds }, 'access token obtained');
  return { token: parsed.access_token, expiresAt: Date.now() + seconds * 1000, version: row.updated_at };
}

/** A valid access token for this connection, from the cache when it can be. */
export async function accessToken(id: string, options: { force?: boolean } = {}): Promise<{ token: string; expiresAt: number }> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (!row) throw new Error('the connection no longer exists');
  const cached = tokens.get(id);
  if (!options.force && cached && cached.version === row.updated_at && cached.expiresAt - REFRESH_EARLY_MS > Date.now()) {
    return cached;
  }
  // Two steps running at once share one token request.
  let inFlight = pending.get(id);
  if (!inFlight) {
    inFlight = requestToken(row).finally(() => pending.delete(id));
    pending.set(id, inFlight);
  }
  const fresh = await inFlight;
  tokens.set(id, fresh);
  return fresh;
}

function storedSecret(row: ConnectionRow): string {
  try {
    const parsed = JSON.parse(row.client_secret || 'null');
    return isSealed(parsed) ? open(parsed) : '';
  } catch {
    return '';
  }
}

export interface Credentials {
  /** The header the request carries; absent for a client certificate. */
  header?: { name: string; value: string };
  /** The client certificate presented in the TLS handshake. */
  tls?: { cert: string; key: string; passphrase?: string };
  /** Whether a 401 is worth one more try with a fresh credential - only an OAuth token can be renewed. */
  renewable: boolean;
}

/** What a request through this connection carries. */
export async function credentialsFor(id: string, options: { force?: boolean } = {}): Promise<Credentials> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (!row) throw new Error('the connection no longer exists');
  if (row.auth_type === 'mtls') {
    const { key, passphrase } = openKey(row.client_key);
    if (!key || !row.client_cert) throw new Error('the certificate or key of this connection cannot be read; paste them again');
    return { tls: { cert: row.client_cert, key, ...(passphrase ? { passphrase } : {}) }, renewable: false };
  }
  const header = await authHeader(id, options);
  return { header: { name: header.name, value: header.value }, renewable: header.renewable };
}

/**
 * The header a request through this connection carries. `renewable` says
 * whether a 401 is worth one more try with a fresh credential - only an
 * OAuth token can be renewed; a wrong key stays wrong.
 */
export async function authHeader(
  id: string,
  options: { force?: boolean } = {},
): Promise<{ name: string; value: string; renewable: boolean }> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (!row) throw new Error('the connection no longer exists');
  const type = row.auth_type ?? 'oauth2';
  if (type === 'api_key') {
    const key = storedSecret(row);
    if (!key) throw new Error('the key of this connection cannot be read; enter it again');
    return { name: row.header_name.toLowerCase(), value: row.value_prefix + key, renewable: false };
  }
  if (type === 'basic') {
    const password = storedSecret(row);
    if (!password) throw new Error('the password of this connection cannot be read; enter it again');
    return { name: 'authorization', value: 'Basic ' + Buffer.from(row.client_id + ':' + password, 'utf8').toString('base64'), renewable: false };
  }
  const { token } = await accessToken(id, options);
  return { name: 'authorization', value: 'Bearer ' + token, renewable: true };
}

/** "Test connection": asks for a fresh token and says how long it lasts. */
export async function testConnection(id: string, actorId: string | null): Promise<string> {
  const row = await queryOne<ConnectionRow>('SELECT * FROM automation_connections WHERE id = ?', [id]);
  if (row && row.auth_type === 'mtls') {
    const info = certInfo(row.client_cert);
    const { key, passphrase } = openKey(row.client_key);
    const problem = key ? certificateProblem(row.client_cert, key, passphrase) : 'The private key cannot be read. Paste it again.';
    if (problem) throw conflict(problem, 'connection_failed');
    return 'Certificate for ' + info.subject + ', valid until ' + info.expires + '. It is presented when a step calls an API.';
  }
  if (row && row.auth_type === 'oauth2_user' && !(row.refresh_token ?? '')) {
    throw conflict('Nobody has signed in yet. Press Sign in on this connection.', 'connection_failed');
  }
  if (row && (row.auth_type ?? 'oauth2') !== 'oauth2' && row.auth_type !== 'oauth2_user') {
    // Nothing to sign in to: the credential is sent with each request.
    if (!storedSecret(row)) throw conflict('The secret of this connection cannot be read. Enter it again.', 'connection_failed');
    return row.auth_type === 'api_key'
      ? 'Stored. The key is sent in the ' + row.header_name + ' header of each request; the API itself is checked when a step runs.'
      : 'Stored. The username and password are sent with each request; the API itself is checked when a step runs.';
  }
  try {
    const { expiresAt } = await accessToken(id, { force: true });
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    audit({ action: 'automation_connection.tested', actorId, targetType: 'automation_connection', targetId: id });
    return 'Signed in. The token is valid for about ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '.';
  } catch (err) {
    audit({ action: 'automation_connection.tested', outcome: 'failure', actorId, targetType: 'automation_connection', targetId: id });
    throw conflict('Could not sign in: ' + (err instanceof Error ? err.message : String(err)) + '.', 'connection_failed');
  }
}
