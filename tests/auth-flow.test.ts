import './env.js';
import assert from 'node:assert/strict';
import test, { describe, before } from 'node:test';
import type { Request } from 'express';
import { queryOne, execute } from '../src/db/index.js';
import {
  bindingCookieName,
  consumeAuthRequest,
  createAuthRequest,
  verifyBinding,
  type AuthRequestRow,
} from '../src/auth/flow-state.js';
import { createPkcePair } from '../src/auth/oidc.js';
import crypto from 'node:crypto';
import { bootstrapTestDatabase } from './support/bootstrap.js';

before(async () => {
  await bootstrapTestDatabase();
});

/** Minimal Request stand-in carrying just a cookie header. */
function requestWithCookie(value: string | null): Request {
  return {
    headers: value === null ? {} : { cookie: bindingCookieName + '=' + value },
  } as unknown as Request;
}

describe('in-flight login state', () => {
  test('issues an unguessable state value and a separate binding secret', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', nonce: 'n', codeVerifier: 'v' });

    // 32 random bytes, base64url encoded.
    assert.ok(flow.id.length >= 42, 'the state value should carry 256 bits of entropy');
    assert.ok(flow.bindingSecret.length >= 42);
    assert.notEqual(flow.id, flow.bindingSecret);
    assert.match(flow.id, /^[A-Za-z0-9_-]+$/);
  });

  test('stores only a hash of the binding secret', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', nonce: 'n', codeVerifier: 'v' });
    const row = await queryOne<AuthRequestRow>('SELECT * FROM auth_requests WHERE id = ?', [flow.id]);

    assert.ok(row);
    assert.notEqual(row?.binding_hash, flow.bindingSecret, 'the raw secret must not be stored');
    assert.equal(
      row?.binding_hash,
      crypto.createHash('sha256').update(flow.bindingSecret, 'utf8').digest('hex'),
    );
  });

  test('can be claimed exactly once', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', nonce: 'nonce-1', codeVerifier: 'verifier-1' });

    const first = await consumeAuthRequest(flow.id, 'oidc');
    assert.ok(first, 'the first claim succeeds');
    assert.equal(first?.nonce, 'nonce-1');
    assert.equal(first?.code_verifier, 'verifier-1');

    // A replayed authorization response finds the state already spent.
    const second = await consumeAuthRequest(flow.id, 'oidc');
    assert.equal(second, undefined, 'the state value is single use');
  });


  test('rejects an unknown state value', async () => {
    assert.equal(await consumeAuthRequest('never-issued', 'oidc'), undefined);
  });

  test('rejects an expired state value', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', nonce: 'n', codeVerifier: 'v' });
    // Wind the expiry into the past.
    await execute('UPDATE auth_requests SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000),
      flow.id,
    ]);
    assert.equal(await consumeAuthRequest(flow.id, 'oidc'), undefined);
  });

  test('keeps the post-login destination alongside the state', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', redirectTo: '/tickets?status=open' });
    const row = await consumeAuthRequest(flow.id, 'oidc');
    assert.equal(row?.redirect_to, '/tickets?status=open');
  });
});

describe('browser binding', () => {
  test('accepts the browser that started the flow', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', nonce: 'n', codeVerifier: 'v' });
    const row = await consumeAuthRequest(flow.id, 'oidc');
    assert.ok(row);
    assert.equal(verifyBinding(requestWithCookie(flow.bindingSecret), row), true);
  });

  test('rejects a different browser, a missing cookie and a tampered value', async () => {
    const flow = await createAuthRequest({ kind: 'oidc', nonce: 'n', codeVerifier: 'v' });
    const other = await createAuthRequest({ kind: 'oidc', nonce: 'n', codeVerifier: 'v' });
    const row = await consumeAuthRequest(flow.id, 'oidc');
    assert.ok(row);

    // No cookie at all: a login CSRF attempt from an attacker's page.
    assert.equal(verifyBinding(requestWithCookie(null), row), false);
    assert.equal(verifyBinding(requestWithCookie(''), row), false);
    // Another flow's secret.
    assert.equal(verifyBinding(requestWithCookie(other.bindingSecret), row), false);
    // A near-miss.
    assert.equal(
      verifyBinding(requestWithCookie(flow.bindingSecret.slice(0, -1) + 'x'), row),
      false,
    );
  });
});

describe('PKCE', () => {
  test('produces an S256 challenge that matches its verifier', async () => {
    const pair = createPkcePair();
    const expected = crypto.createHash('sha256').update(pair.verifier).digest('base64url');

    assert.equal(pair.challenge, expected);
    // RFC 7636 requires 43-128 characters for the verifier.
    assert.ok(pair.verifier.length >= 43 && pair.verifier.length <= 128);
    assert.match(pair.verifier, /^[A-Za-z0-9._~-]+$/);
    assert.notEqual(pair.verifier, pair.challenge);
  });

  test('produces a fresh pair every time', async () => {
    const a = createPkcePair();
    const b = createPkcePair();
    assert.notEqual(a.verifier, b.verifier);
  });
});
