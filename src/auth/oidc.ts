import crypto from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { settings } from '../settings/index.js';
import { config } from '../config.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { randomToken } from '../lib/util.js';
import type { DirectoryIdentity } from './provisioning.js';

const log = logger.child({ module: 'oidc' });

/**
 * OpenID Connect sign-in, for every identity provider this desk trusts.
 *
 * Entra ID, Google and Okta speak the same protocol - authorization code with
 * PKCE, an ID token signed with keys the provider publishes - and differ only
 * in where they live and in one or two claims worth checking. So there is one
 * implementation here and a small configuration per provider (providerConfig),
 * with each provider's discovery document and key set cached separately.
 *
 * Provider-specific checks, on top of signature, issuer, audience, expiry and
 * nonce:
 *
 * - **Entra ID**: the token's tenant (`tid`) must be ours, so a multi-tenant
 *   misconfiguration cannot let another organisation in.
 * - **Google**: the account's Workspace domain (`hd`) must be one of the
 *   allowed domains and the email must be verified. Without that, anybody
 *   with a Google account - the whole world - could sign in.
 * - **Okta**: an Okta org is private to its owner; the issuer check suffices.
 * - **Generic OpenID Connect** (Keycloak, ADFS, Authentik, Ping...): the
 *   discovery document must name the configured issuer exactly (a document
 *   that names another is a mix-up or an attack), an email the provider
 *   says is unverified is refused, and the optional allowed domains apply.
 *
 * Nothing a token asserts grants a role. Roles are set under Settings - Users.
 */

export const PROVIDERS = ['entra', 'google', 'okta', 'generic'] as const;
export type ProviderKey = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  entra: 'Microsoft',
  google: 'Google',
  okta: 'Okta',
  generic: 'OpenID Connect',
};

/** What a sign-in button says after "Sign in with": the generic one is named by its administrator. */
export function providerLabel(key: ProviderKey): string {
  return key === 'generic' ? settings().genericOidc.name : PROVIDER_LABELS[key];
}

/** "https://id.example.com/realms/x/" and ".../x" are the same issuer. */
function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

interface ProviderConfig {
  key: ProviderKey;
  configured: boolean;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  extraIssuers: string[];
  redirectUri: string;
}

/** The callback every provider returns to. Register it with each of them. */
export function redirectUri(): string {
  return config.publicOrigin + '/auth/oidc/callback';
}

/**
 * Where a provider sends the browser back after signing out. Okta and most
 * OpenID Connect providers refuse any address not registered with them
 * exactly ("Sign-out redirect URIs"), so the settings pages show it.
 */
export function signOutRedirectUri(): string {
  return config.publicOrigin + '/login?signedOut=1';
}

export function providerConfig(key: ProviderKey): ProviderConfig {
  const s = settings();
  switch (key) {
    case 'google':
      return {
        key,
        configured: s.google.configured,
        discoveryUrl: s.google.discoveryUrl,
        clientId: s.google.clientId,
        clientSecret: s.google.clientSecret,
        scopes: ['openid', 'profile', 'email'],
        extraIssuers: [],
        redirectUri: redirectUri(),
      };
    case 'generic':
      return {
        key,
        configured: s.genericOidc.configured,
        discoveryUrl: s.genericOidc.discoveryUrl,
        clientId: s.genericOidc.clientId,
        clientSecret: s.genericOidc.clientSecret,
        scopes: s.genericOidc.scopes,
        extraIssuers: [],
        redirectUri: redirectUri(),
      };
    case 'okta':
      return {
        key,
        configured: s.okta.configured,
        discoveryUrl: s.okta.discoveryUrl,
        clientId: s.okta.clientId,
        clientSecret: s.okta.clientSecret,
        // phone releases phone_number; the rest of a profile is in `profile`.
        scopes: ['openid', 'profile', 'email', 'phone'],
        extraIssuers: [],
        redirectUri: redirectUri(),
      };
    default:
      return {
        key: 'entra',
        configured: s.ssoConfigured,
        discoveryUrl: s.oidc.discoveryUrl,
        clientId: s.oidc.clientId,
        clientSecret: s.oidc.clientSecret,
        // User.Read: the ID token carries no company, department, title,
        // office or phone, so they are read from Microsoft Graph at sign-in.
        scopes: s.oidc.scopes.some((x) => x.toLowerCase() === 'user.read') ? s.oidc.scopes : [...s.oidc.scopes, 'User.Read'],
        extraIssuers: s.oidc.extraIssuers,
        redirectUri: s.oidc.redirectUri,
      };
  }
}

/**
 * Where each configured provider's sign-in page lives, for the sign-in
 * page's form-action. From the discovery document when it can be had (it is
 * cached), else the origin it was discovered from - a provider that is down
 * must not stop the sign-in page drawing.
 */
export async function authorizationOrigins(): Promise<string[]> {
  const origins: string[] = [];
  for (const key of configuredProviders()) {
    try {
      origins.push(new URL((await discover(key)).doc.authorization_endpoint).origin);
    } catch {
      try {
        origins.push(new URL(providerConfig(key).discoveryUrl).origin);
      } catch {
        // Not a URL at all: nothing to allow.
      }
    }
  }
  return origins;
}

/** A provider's full name, for the people pages ("Signs in with"); the buttons use providerLabel(). */
export function providerName(key: ProviderKey): string {
  if (key === 'entra') return 'Microsoft Entra ID';
  if (key === 'google') return 'Google';
  if (key === 'okta') return 'Okta';
  return settings().genericOidc.name || 'OpenID Connect';
}

/** Entra's issuers, and SCIM's: Entra's provisioning pushes accounts that then sign in through Entra. */
const ENTRA_ISSUER = /^https:\/\/(login\.microsoftonline\.com|sts\.windows\.net)\//i;
const SCIM_ISSUER = 'urn:helpdesk:scim';

/**
 * Which identity provider an account belongs to, from the issuer it carries -
 * the one thing every account records about where it came from. It once read
 * "Microsoft Entra ID" for any account that was not a password account, so an
 * Okta account said Entra (reported 18 Oct 2026). Null: not a provider's
 * (a password account, or one we cannot place).
 */
export function providerOfIssuer(issuer: string): ProviderKey | null {
  if (ENTRA_ISSUER.test(issuer) || issuer === SCIM_ISSUER) return 'entra';
  if (issuer === 'https://accounts.google.com' || issuer === 'accounts.google.com') return 'google';
  const s = settings();
  if (s.genericOidc.issuer && sameIssuer(issuer, s.genericOidc.issuer)) return 'generic';
  const okta = s.okta.domain.toLowerCase();
  const host = /^https:\/\/([^/]+)/i.exec(issuer)?.[1]?.toLowerCase() ?? '';
  if ((okta && host === okta) || /\.(okta|oktapreview|okta-emea)\.com$/.test(host)) return 'okta';
  return null;
}

/**
 * SQL that keeps one provider's accounts (`issuer` column), with its
 * parameters - the same rules as providerOfIssuer, for lists and counts.
 */
export function providerIssuerSql(key: ProviderKey): { sql: string; params: string[] } {
  const s = settings();
  if (key === 'entra') {
    return { sql: "(issuer LIKE 'https://login.microsoftonline.com/%' OR issuer LIKE 'https://sts.windows.net/%' OR issuer = ?)", params: [SCIM_ISSUER] };
  }
  if (key === 'google') return { sql: 'issuer IN (?, ?)', params: ['https://accounts.google.com', 'accounts.google.com'] };
  if (key === 'generic') {
    const issuer = s.genericOidc.issuer.replace(/\/+$/, '');
    return issuer ? { sql: 'issuer IN (?, ?)', params: [issuer, issuer + '/'] } : { sql: '1 = 0', params: [] };
  }
  const okta = s.okta.domain.toLowerCase();
  return okta
    ? { sql: "(lower(issuer) LIKE ? OR issuer LIKE 'https://%.okta.com/%' OR issuer LIKE 'https://%.okta.com')", params: ['https://' + okta + '%'] }
    : { sql: "(issuer LIKE 'https://%.okta.com/%' OR issuer LIKE 'https://%.okta.com')", params: [] };
}

/** The providers that can sign people in right now, in display order. */
export function configuredProviders(): ProviderKey[] {
  return PROVIDERS.filter((key) => providerConfig(key).configured);
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
}

interface CachedDiscovery {
  doc: DiscoveryDocument;
  jwks: JWTVerifyGetKey;
  fetchedAt: number;
  /** The URL it was fetched from: a changed setting invalidates it. */
  url: string;
}

const DISCOVERY_TTL_MS = 60 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const cache = new Map<ProviderKey, CachedDiscovery>();

/**
 * Where a key set comes from. jose fetches it over node:https, which a test's
 * fake fetch cannot answer, so tests swap this for a local key set.
 */
let keySetFor: (uri: URL) => JWTVerifyGetKey = (uri) =>
  createRemoteJWKSet(uri, { timeoutDuration: HTTP_TIMEOUT_MS, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });

export function setKeySetForTests(factory: (uri: URL) => JWTVerifyGetKey): void {
  keySetFor = factory;
  cache.clear();
}

function requireHttps(url: string, field: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('OIDC discovery returned a non-https ' + field + ': ' + url);
  }
  return parsed.toString();
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    redirect: 'error',
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('Non-JSON response from ' + url + ' (HTTP ' + response.status + ')');
  }
  if (!response.ok) {
    const detail = body as { error?: string; error_description?: string };
    // Never surface error_description to the browser; it can echo request data.
    log.warn(
      { url, status: response.status, error: detail?.error },
      'identity provider returned an error',
    );
    throw unauthorized('Sign-in could not be completed. Please try again.', 'idp_error');
  }
  return body;
}

/** Fetches and caches a provider's OpenID configuration and signing keys. */
export async function discover(key: ProviderKey = 'entra'): Promise<CachedDiscovery> {
  const provider = providerConfig(key);
  const hit = cache.get(key);
  if (hit && hit.url === provider.discoveryUrl && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) {
    return hit;
  }

  const raw = (await fetchJson(provider.discoveryUrl)) as Partial<DiscoveryDocument>;
  if (!raw.issuer || !raw.authorization_endpoint || !raw.token_endpoint || !raw.jwks_uri) {
    throw new Error('Incomplete OpenID configuration from ' + provider.discoveryUrl);
  }
  // OpenID Connect Discovery 1.0, section 4.3: the document must name the
  // issuer it was fetched for. The fixed providers' URLs are ours; this one
  // is typed by an administrator.
  if (key === 'generic' && !sameIssuer(raw.issuer, settings().genericOidc.issuer)) {
    throw new Error('The discovery document names issuer ' + raw.issuer + ', not the one configured.');
  }

  const doc: DiscoveryDocument = {
    issuer: raw.issuer,
    authorization_endpoint: requireHttps(raw.authorization_endpoint, 'authorization_endpoint'),
    token_endpoint: requireHttps(raw.token_endpoint, 'token_endpoint'),
    jwks_uri: requireHttps(raw.jwks_uri, 'jwks_uri'),
    ...(raw.end_session_endpoint
      ? { end_session_endpoint: requireHttps(raw.end_session_endpoint, 'end_session_endpoint') }
      : {}),
    ...(raw.userinfo_endpoint ? { userinfo_endpoint: requireHttps(raw.userinfo_endpoint, 'userinfo_endpoint') } : {}),
  };

  const entry: CachedDiscovery = {
    doc,
    // The key set is cached and refreshed by jose, which also handles rollover.
    jwks: keySetFor(new URL(doc.jwks_uri)),
    fetchedAt: Date.now(),
    url: provider.discoveryUrl,
  };
  cache.set(key, entry);
  log.info({ provider: key, issuer: doc.issuer }, 'OpenID configuration loaded');
  return entry;
}

/**
 * Drops every cached discovery document and key set. Called when settings
 * change, so a new tenant, domain or client id takes effect without a restart.
 */
export function resetDiscoveryCache(): void {
  cache.clear();
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256 PKCE pair. */
export function createPkcePair(): PkcePair {
  const verifier = randomToken(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Builds the authorization request URL for the code flow. */
export async function buildAuthorizationUrl(params: {
  provider?: ProviderKey;
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string;
}): Promise<string> {
  const key = params.provider ?? 'entra';
  const provider = providerConfig(key);
  const { doc } = await discover(key);
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', provider.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  // Google: only offer the account picker for an allowed Workspace domain
  // when there is exactly one. A hint, not a check - verifyIdToken checks.
  if (key === 'google' && settings().google.allowedDomains.length === 1) {
    url.searchParams.set('hd', settings().google.allowedDomains[0]!);
  }
  // Google publishes no sign-out for other sites (and ending somebody's
  // Google session would sign them out of Gmail too), so after signing out
  // here the next "Sign in with Google" would silently be the same person
  // again. Asking which account every time is the nearest to signing out.
  if (key === 'google') url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Redeems the authorization code, proving possession of the PKCE verifier. */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  key: ProviderKey = 'entra',
): Promise<TokenResponse> {
  const provider = providerConfig(key);
  const { doc } = await discover(key);
  const body = new URLSearchParams({
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUri,
    code_verifier: codeVerifier,
  });
  // Entra accepts (and historically expected) the scope again here.
  if (key === 'entra') body.set('scope', provider.scopes.join(' '));
  const response = (await fetchJson(doc.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  })) as TokenResponse;

  if (!response.id_token) {
    throw unauthorized('Sign-in could not be completed.', 'missing_id_token');
  }
  return response;
}

interface IdTokenClaims extends JWTPayload {
  oid?: string;
  tid?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  email_verified?: boolean | string;
  preferred_username?: string;
  upn?: string;
  /** Google: the Workspace domain of the account. Absent for consumer accounts. */
  hd?: string;
  /** Entra (an optional claim): handed back as logout_hint at sign-out. */
  login_hint?: string;
  groups?: string[];
  roles?: string[];
  /** Present instead of `groups` when the user is in too many groups. */
  hasgroups?: boolean;
  _claim_names?: Record<string, string>;
}

/**
 * Verifies the ID token signature, issuer, audience, expiry and nonce, plus
 * the provider's own check (see the top of this file).
 *
 * `jwtVerify` enforces the signature against the provider's published JWKS
 * and rejects `alg: none` and symmetric algorithms outright, so a forged or
 * downgraded token cannot pass.
 */
export async function verifyIdToken(
  idToken: string,
  expectedNonce: string,
  key: ProviderKey = 'entra',
): Promise<IdTokenClaims> {
  const provider = providerConfig(key);
  const { doc, jwks } = await discover(key);
  const allowedIssuers = [doc.issuer, ...provider.extraIssuers];

  let payload: IdTokenClaims;
  try {
    const result = await jwtVerify(idToken, jwks, {
      audience: provider.clientId,
      algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384'],
      clockTolerance: 60,
      maxTokenAge: '10 minutes',
    });
    payload = result.payload as IdTokenClaims;
  } catch (err) {
    log.warn({ provider: key, err: (err as Error).message }, 'ID token verification failed');
    throw unauthorized('Sign-in could not be verified.', 'invalid_id_token');
  }

  if (!payload.iss || !allowedIssuers.includes(payload.iss)) {
    log.warn({ provider: key, iss: payload.iss }, 'ID token issuer not accepted');
    throw unauthorized('Sign-in could not be verified.', 'issuer_mismatch');
  }

  if (key === 'entra') {
    // The tenant id pins the token to our directory even if the app is ever
    // reconfigured as multi-tenant by mistake.
    const tenant = settings().oidc.tenantId;
    if (tenant.includes('-') && payload.tid && payload.tid !== tenant) {
      log.warn({ tid: payload.tid }, 'ID token tenant not accepted');
      throw unauthorized('Sign-in could not be verified.', 'tenant_mismatch');
    }
  }

  if (key === 'google') {
    checkGoogleAccount(payload, settings().google.allowedDomains);
  }

  if (key === 'generic') {
    checkGenericAccount(payload, settings().genericOidc.allowedDomains);
  }

  // Replay of an authorization code against a different login attempt is
  // caught here: the nonce is bound to the request we ourselves started.
  if (typeof payload.nonce !== 'string' || payload.nonce !== expectedNonce) {
    log.warn('ID token nonce mismatch');
    throw unauthorized('Sign-in could not be verified.', 'nonce_mismatch');
  }

  if (!payload.sub) {
    throw unauthorized('Sign-in could not be verified.', 'missing_subject');
  }

  return payload;
}

/**
 * A Google account may sign in only from an allowed Workspace domain, with a
 * verified address. `hd` is set by Google for Workspace accounts and cannot
 * be chosen by the user; a consumer Gmail account has none and is refused.
 */
export function checkGoogleAccount(
  claims: Pick<IdTokenClaims, 'hd' | 'email_verified' | 'email'>,
  allowedDomains: readonly string[],
): void {
  const domain = (claims.hd ?? '').toLowerCase();
  if (!domain || !allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
    log.warn({ hd: claims.hd ?? null }, 'Google account from a domain that is not allowed');
    throw unauthorized(
      'This Google account is not from an organisation allowed to sign in here.',
      'google_domain_not_allowed',
    );
  }
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw unauthorized('Sign-in could not be verified.', 'email_not_verified');
  }
}

/**
 * A generic provider's account: an address the provider itself says is
 * unverified is refused (ADFS sends no claim at all, which is accepted), and
 * when allowed domains are set the address must be in one of them - for a
 * provider that lets anybody register.
 */
export function checkGenericAccount(
  claims: Pick<IdTokenClaims, 'email_verified' | 'email' | 'preferred_username' | 'upn'>,
  allowedDomains: readonly string[],
): void {
  if (claims.email_verified === false || claims.email_verified === 'false') {
    throw unauthorized('Your account\'s email address is not verified with your identity provider.', 'email_not_verified');
  }
  if (allowedDomains.length > 0) {
    const address = claims.email ?? claims.preferred_username ?? claims.upn ?? '';
    const domain = address.includes('@') ? address.split('@').pop()!.toLowerCase() : '';
    if (!allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
      log.warn({ domain }, 'generic OIDC account from a domain that is not allowed');
      throw unauthorized('This account is not from an organisation allowed to sign in here.', 'domain_not_allowed');
    }
  }
}

/** Normalises verified ID token claims into a directory identity. */
export function identityFromClaims(claims: IdTokenClaims): DirectoryIdentity {
  const email = claims.email ?? claims.preferred_username ?? claims.upn;

  if (!email || !email.includes('@')) {
    throw badRequest(
      'Your directory account has no email address or UPN, which this application requires.',
      'missing_email',
    );
  }

  // Group and app-role claims are deliberately not read. Roles are assigned
  // in the application, under Settings -> Users, so nothing a token asserts
  // can grant privilege here.
  return {
    issuer: claims.iss ?? 'unknown',
    // Entra's object id survives a renamed account; elsewhere `sub` is the
    // stable key.
    externalId: typeof claims.oid === 'string' ? claims.oid : (claims.sub ?? null),
    email,
    upn: claims.upn ?? claims.preferred_username ?? null,
    displayName: claims.name ?? email,
    // Names, and anything else the token states (custom claims on Okta and
    // the like); profileDetails() adds what only the directory knows.
    ...detailsFromClaims(claims as Record<string, unknown>),
  };
}

/**
 * A person's details as a directory states them, by the names providers use:
 * the standard OpenID Connect claims, and the custom claim names Okta and
 * most other providers are configured with. Empty means "not said", which
 * keeps what is stored.
 */
export function detailsFromClaims(c: Record<string, unknown>): ProfileDetails {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = c[n];
      const text = typeof v === 'string' ? v.trim() : Array.isArray(v) && typeof v[0] === 'string' ? v[0].trim() : '';
      if (text) return text;
    }
    return undefined;
  };
  const out: ProfileDetails = {};
  const set = (k: keyof ProfileDetails, v: string | undefined) => {
    if (v) out[k] = v;
  };
  set('firstName', pick('given_name', 'givenName'));
  set('lastName', pick('family_name', 'familyName', 'surname'));
  set('company', pick('organization', 'company', 'companyName', 'company_name'));
  set('department', pick('department'));
  set('jobTitle', pick('job_title', 'jobTitle', 'title'));
  set('office', pick('office', 'officeLocation', 'office_location'));
  set('phone', pick('phone_number', 'businessPhones', 'mobilePhone', 'phone'));
  return out;
}

export interface ProfileDetails {
  firstName?: string;
  lastName?: string;
  company?: string;
  department?: string;
  jobTitle?: string;
  office?: string;
  phone?: string;
}

const GRAPH_ME =
  'https://graph.microsoft.com/v1.0/me?$select=givenName,surname,companyName,department,jobTitle,officeLocation,businessPhones,mobilePhone';

/**
 * What the directory says about the person who just signed in, beyond the ID
 * token: Microsoft Graph for Entra ID (the token carries none of it), the
 * provider's userinfo endpoint for the others. Never their identity - only
 * details - and never a reason to refuse: with nothing to read, or a provider
 * that will not answer, sign-in carries on with what the token said.
 */
export async function profileDetails(
  key: ProviderKey,
  accessToken: string | undefined,
  subject: string | undefined,
): Promise<ProfileDetails> {
  if (!accessToken) return {};
  try {
    const url = key === 'entra' ? GRAPH_ME : (await discover(key)).doc.userinfo_endpoint;
    if (!url) return {};
    const response = await fetch(url, {
      headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) {
      log.warn({ provider: key, status: response.status }, 'profile details could not be read; signing in without them');
      return {};
    }
    const body = (await response.json()) as Record<string, unknown>;
    // OpenID Connect requires the userinfo sub to be the ID token's; an
    // answer about anybody else is not used.
    if (key !== 'entra' && subject && body.sub !== subject) return {};
    return detailsFromClaims(body);
  } catch (err) {
    log.warn({ provider: key, err: (err as Error).message }, 'profile details could not be read; signing in without them');
    return {};
  }
}

/**
 * What sign-in left on the session for signing out again: the ID token, and
 * Entra's login_hint claim (released when the app registration asks for it).
 */
export interface SignOutHints {
  idToken?: string;
  loginHint?: string;
}

/**
 * The provider's sign-out URL, so signing out here also ends that session.
 *
 * Okta refuses a sign-out without `id_token_hint` (a bare 400, reported
 * 18 Oct 2026), and with it Okta and most other providers sign out without
 * asking. Entra is told which account by `logout_hint` instead, so it does
 * not ask which one to sign out - the customer portal does the same.
 */
export async function endSessionUrl(
  postLogoutRedirect: string,
  key: ProviderKey = 'entra',
  hints: SignOutHints = {},
): Promise<string | null> {
  try {
    if (!providerConfig(key).configured) return null;
    const { doc } = await discover(key);
    // Google publishes none: signing out here then only ends this session.
    if (!doc.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
    url.searchParams.set('client_id', providerConfig(key).clientId);
    if (key === 'entra') {
      if (hints.loginHint) url.searchParams.set('logout_hint', hints.loginHint);
    } else if (hints.idToken) {
      url.searchParams.set('id_token_hint', hints.idToken);
    }
    return url.toString();
  } catch {
    return null;
  }
}
