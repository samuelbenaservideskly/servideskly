import type { Request, Response } from 'express';
import * as cookieLib from 'cookie';
import { clientOne, execute, sqlNow, transaction } from '../db/index.js';
import { config } from '../config.js';
import { nowIso, randomToken, safeEqual, sha256 } from '../lib/util.js';

/** In-flight logins expire quickly; a login should take seconds, not hours. */
const FLOW_TTL_MS = 10 * 60_000;

const BINDING_COOKIE = config.session.secureCookies ? '__Host-hd_authbind' : 'hd_authbind';

export interface AuthRequestRow {
  id: string;
  kind: 'oidc';
  /** Which identity provider this attempt went to. */
  provider: string;
  nonce: string | null;
  code_verifier: string | null;
  request_id: string | null;
  binding_hash: string;
  redirect_to: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface CreatedAuthRequest {
  /** Value carried in the `state` parameter. */
  id: string;
  /** Secret written to the browser binding cookie. */
  bindingSecret: string;
}

/**
 * Records an in-flight login and returns the correlation id plus a secret to
 * store in the browser.
 *
 * The state lives in the database rather than the session so that a login
 * started before a session existed can still be correlated, and so the
 * single-use guarantee survives a restart. The binding cookie carries the
 * "this browser started this login" half.
 */
export async function createAuthRequest(input: {
  kind: 'oidc';
  provider?: string;
  nonce?: string;
  codeVerifier?: string;
  requestId?: string;
  redirectTo?: string;
}): Promise<CreatedAuthRequest> {
  const id = randomToken(32);
  const bindingSecret = randomToken(32);
  await execute(
    `INSERT INTO auth_requests
       (id, kind, nonce, code_verifier, request_id, binding_hash, redirect_to,
        created_at, expires_at, consumed_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id,
      input.kind,
      input.nonce ?? null,
      input.codeVerifier ?? null,
      input.requestId ?? null,
      sha256(bindingSecret),
      input.redirectTo ?? null,
      nowIso(),
      new Date(Date.now() + FLOW_TTL_MS),
      input.provider ?? 'entra',
    ],
  );
  return { id, bindingSecret };
}

/**
 * Atomically claims an in-flight login. Returns undefined when the id is
 * unknown, expired, or already used, which makes every state value single-use
 * and blocks replay of an authorization response.
 *
 * The claim is a single conditional UPDATE ... RETURNING, so two concurrent
 * callbacks carrying the same state cannot both succeed however they
 * interleave.
 */
export function consumeAuthRequest(
  id: string,
  kind: 'oidc',
): Promise<AuthRequestRow | undefined> {
  return transaction((client) =>
    clientOne<AuthRequestRow>(
      client,
      `UPDATE auth_requests SET consumed_at = ?
        WHERE id = ? AND kind = ? AND consumed_at IS NULL AND expires_at > ${sqlNow}
        RETURNING *`,
      [nowIso(), id, kind],
    ),
  );
}

/** True when the browser presented the secret this login flow was issued with. */
export function verifyBinding(req: Request, row: AuthRequestRow): boolean {
  const presented = readBindingCookie(req);
  if (!presented) return false;
  return safeEqual(sha256(presented), row.binding_hash);
}

export function readBindingCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  try {
    return cookieLib.parse(header)[BINDING_COOKIE];
  } catch {
    return undefined;
  }
}

/**
 * Writes the binding cookie.
 *
 * SameSite=Lax throughout. OpenID Connect returns through a top-level GET
 * redirect, where a Lax cookie is sent - so nothing here needs the
 * SameSite=None that a cross-site assertion POST used to require.
 */
export function setBindingCookie(res: Response, secret: string, _kind: 'oidc'): void {
  res.cookie(BINDING_COOKIE, secret, {
    httpOnly: true,
    secure: config.session.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: FLOW_TTL_MS,
    signed: false,
  });
}

export function clearBindingCookie(res: Response): void {
  res.clearCookie(BINDING_COOKIE, {
    httpOnly: true,
    secure: config.session.secureCookies,
    path: '/',
  });
}

/** Exposed so tests can address the binding cookie by name. */
export const bindingCookieName = BINDING_COOKIE;

