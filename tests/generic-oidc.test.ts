import './env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings, settingsDocument, updateSettings } from '../src/settings/index.js';
import { checkGenericAccount, configuredProviders, resetDiscoveryCache, setKeySetForTests } from '../src/auth/oidc.js';
import { queryOne } from '../src/db/index.js';

const ISSUER = 'https://id.example.test/realms/staff';

let app: Express;
let admin: TestSession;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwk: JWK;
/** What the fake provider puts in the next ID token. */
let nextClaims: Record<string, unknown> = {};
/** The issuer the fake discovery document claims. */
let advertisedIssuer = ISSUER;
let lastNonce = '';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

const realFetch = globalThis.fetch;
/** Set to answer userinfo about somebody else. */
let nextUserinfoSub: string | undefined;
before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('generic.admin@example.com', 'admin');
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  setKeySetForTests(() => createLocalJWKSet({ keys: [jwk] }));

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === ISSUER + '/.well-known/openid-configuration') {
      return json({
        issuer: advertisedIssuer,
        authorization_endpoint: ISSUER + '/protocol/openid-connect/auth',
        token_endpoint: ISSUER + '/protocol/openid-connect/token',
        jwks_uri: ISSUER + '/protocol/openid-connect/certs',
        end_session_endpoint: ISSUER + '/protocol/openid-connect/logout',
        userinfo_endpoint: ISSUER + '/protocol/openid-connect/userinfo',
      });
    }
    if (url === ISSUER + '/protocol/openid-connect/certs') return json({ keys: [jwk] });
    if (url === ISSUER + '/protocol/openid-connect/userinfo') {
      // As Okta answers once custom claims are added: the profile is here, not in the ID token.
      return json({ sub: nextUserinfoSub ?? nextClaims.sub, organization: 'Contoso', department: 'Finance', title: 'Controller', phone_number: '+420 777 000 111' });
    }
    if (url === ISSUER + '/protocol/openid-connect/token') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(form.get('client_id'), 'helpdesk');
      assert.equal(form.get('client_secret'), 'k3ycloak');
      const idToken = await new SignJWT({ nonce: lastNonce, ...nextClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(ISSUER)
        .setAudience('helpdesk')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json({ id_token: idToken, access_token: 'a', token_type: 'Bearer' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/** Starts a sign-in with the generic provider and comes back with a code. */
async function signInThroughProvider(claims: Record<string, unknown>) {
  resetDiscoveryCache();
  nextClaims = claims;
  const agent = request.agent(app);
  const page = await agent.get('/login').expect(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1]!;
  const start = await agent.post('/auth/login').type('form').send({ _csrf: csrf, provider: 'generic' }).expect(302);
  const authorize = new URL(String(start.headers.location));
  lastNonce = authorize.searchParams.get('nonce') ?? '';
  const back = await agent.get('/auth/oidc/callback?code=abc&state=' + encodeURIComponent(authorize.searchParams.get('state')!));
  return { agent, authorize, back };
}

describe('Generic OpenID Connect', () => {
  test('the tile is offered with the OpenID mark', async () => {
    const page = await as(admin).get('/admin/settings/integrations').expect(200);
    assert.match(page.text, /href="\/admin\/settings\/integrations\/openid"/);
    assert.match(page.text, /idp-logo--openid/);
  });

  test('an http issuer is refused on the form; a good one saves sealed and is offered', async () => {
    const refused = await as(admin)
      .post('/admin/settings/integrations/openid')
      .type('form')
      .send({ _csrf: admin.csrfToken, name: 'Company account', issuer: 'http://id.example.test', clientId: 'helpdesk' })
      .expect(400);
    assert.match(refused.text, /must be an https address/);

    await as(admin)
      .post('/admin/settings/integrations/openid')
      .type('form')
      .send({ _csrf: admin.csrfToken, name: 'Company account', issuer: ISSUER + '/', clientId: 'helpdesk', clientSecret: 'k3ycloak', scopes: 'profile, email', allowedDomains: '' })
      .expect(302);
    assert.equal(settings().genericOidc.configured, true);
    assert.equal(settings().genericOidc.issuer, ISSUER, 'trailing slash dropped');
    assert.deepEqual(settings().genericOidc.scopes, ['openid', 'profile', 'email'], 'openid always sent');
    assert.notEqual(settingsDocument().genericOidc.clientSecret, 'k3ycloak');
    assert.ok(configuredProviders().includes('generic'));

    const login = await request(app).get('/login').expect(200);
    assert.match(login.text, /Sign in with Company account/);
    // The button posts here and is redirected to the provider: Chrome refuses
    // that redirect unless the page's form-action names the provider.
    resetDiscoveryCache();
    const again = await request(app).get('/login').expect(200);
    assert.match(String(again.headers['content-security-policy']), /form-action 'self' https:\/\/id\.example\.test/);
  });

  test('a person signs in through it and arrives as a plain user', async () => {
    await updateSettings({ provisioning: { jitEnabled: true } }, null);
    const { authorize, back } = await signInThroughProvider({ sub: 'kc-1', email: 'jana@example.test', email_verified: true, name: 'Jana Nováková' });
    assert.equal(authorize.origin + authorize.pathname, ISSUER + '/protocol/openid-connect/auth');
    assert.equal(authorize.searchParams.get('scope'), 'openid profile email');
    assert.equal(back.status, 302, back.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600));
    assert.doesNotMatch(String(back.headers.location), /login/);
    const user = await queryOne<{ role: string; issuer: string; external_id: string }>(
      "SELECT role, issuer, external_id FROM users WHERE email = 'jana@example.test'",
    );
    assert.deepEqual(user, { role: 'user', issuer: ISSUER, external_id: 'kc-1' });
  });

  test('signed in through it, every page lets Sign out reach its sign-out page', async () => {
    // Sign out redirects there, and form-action 'self' made Chrome refuse
    // it: the button did nothing (reported 17 Oct 2026).
    const { agent } = await signInThroughProvider({ sub: 'kc-1', email: 'jana@example.test', email_verified: true });
    const page = await agent.get('/tickets').expect(200);
    assert.match(String(page.headers['content-security-policy']), /form-action 'self' https:\/\/id\.example\.test/);
    const out = await agent.post('/auth/logout').type('form')
      .send({ _csrf: /name="_csrf" value="([^"]+)"/.exec(page.text)![1]! }).expect(302);
    const signOut = new URL(String(out.headers.location));
    assert.equal(signOut.origin, 'https://id.example.test');
    // Okta answers a bare 400 without id_token_hint (reported 18 Oct 2026),
    // and the address it returns to must be the one the settings page shows.
    const hint = signOut.searchParams.get('id_token_hint') ?? '';
    assert.equal(hint.split('.').length, 3, 'the ID token from sign-in is handed back');
    const back = new URL(signOut.searchParams.get('post_logout_redirect_uri')!);
    assert.equal(back.pathname + back.search, '/login?signedOut=1');
    assert.equal(signOut.searchParams.get('logout_hint'), null, 'logout_hint is Entra\'s');
    const setup = await as(admin).get('/admin/settings/integrations/openid').expect(200);
    assert.match(setup.text, new RegExp('Sign-out redirect URI</dt>\\s*<dd class="mono copyable">' + signOut.searchParams.get('post_logout_redirect_uri')!.replace(/[.?]/g, '\\$&') + '</dd>'));

    // A password session's pages keep 'self' alone.
    const plain = await as(admin).get('/tickets').expect(200);
    assert.doesNotMatch(String(plain.headers['content-security-policy']), /form-action 'self' https/);
  });

  test('details the provider states at userinfo reach the account; an answer about somebody else does not', async () => {
    await signInThroughProvider({ sub: 'kc-9', email: 'pavla@example.test', email_verified: true, given_name: 'Pavla', family_name: 'Malá', office_location: 'Brno' });
    const user = await queryOne<Record<string, string>>("SELECT first_name, last_name, company, department, job_title, office, phone FROM users WHERE email = 'pavla@example.test'");
    assert.deepEqual(user, { first_name: 'Pavla', last_name: 'Malá', company: 'Contoso', department: 'Finance', job_title: 'Controller', office: 'Brno', phone: '+420 777 000 111' });

    nextUserinfoSub = 'somebody-else';
    try {
      await signInThroughProvider({ sub: 'kc-10', email: 'ota@example.test', email_verified: true });
    } finally {
      nextUserinfoSub = undefined;
    }
    const ota = await queryOne<{ company: string }>("SELECT company FROM users WHERE email = 'ota@example.test'");
    assert.equal(ota?.company, '', 'userinfo with another sub is ignored');
  });

  test('a password account with the same address is connected only after its password is given', async () => {
    const { createLocalAccount, verifyLocalSignIn } = await import('../src/auth/local-accounts.js');
    const local = await createLocalAccount({ email: 'linkme@example.test', displayName: 'Link Me', role: 'admin', password: 'A long enough passphrase-1' }, null);
    const { agent, back } = await signInThroughProvider({ sub: 'kc-link', email: 'linkme@example.test', email_verified: true });
    assert.equal(back.status, 302);
    assert.equal(back.headers.location, '/login/link', 'asked to prove the password account');
    const page = await agent.get('/login/link').expect(200);
    assert.match(page.text, /Connect your account/);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1]!;
    const wrong = await agent.post('/login/link').type('form').send({ _csrf: csrf, password: 'not it' }).expect(400);
    assert.match(wrong.text, /That password is not right/);
    const before = await queryOne<{ issuer: string }>("SELECT issuer FROM users WHERE id = ?", [local.id]);
    assert.notEqual(before?.issuer, ISSUER, 'nothing linked on a wrong password');

    const ok = await agent.post('/login/link').type('form').send({ _csrf: csrf, password: 'A long enough passphrase-1' });
    assert.equal(ok.status, 302);
    assert.doesNotMatch(String(ok.headers.location), /login/);
    const after = await queryOne<{ id: string; issuer: string; external_id: string; role: string }>("SELECT id, issuer, external_id, role FROM users WHERE email = 'linkme@example.test'");
    assert.deepEqual(after, { id: local.id, issuer: ISSUER, external_id: 'kc-link', role: 'admin' }, 'the same account, now the provider\'s, role kept');
    await assert.rejects(() => verifyLocalSignIn('linkme@example.test', 'A long enough passphrase-1'), 'the password is gone');

    // Next time straight in, no question.
    const again = await signInThroughProvider({ sub: 'kc-link', email: 'linkme@example.test', email_verified: true });
    assert.doesNotMatch(String(again.back.headers.location), /login/);
  });

  test('an address the provider calls unverified is refused, and so is one outside the allowed domains', async () => {
    const unverified = await signInThroughProvider({ sub: 'kc-2', email: 'mallory@example.test', email_verified: false });
    assert.notEqual(unverified.back.status, 302);
    assert.equal(await queryOne("SELECT id FROM users WHERE email = 'mallory@example.test'"), undefined);

    assert.throws(() => checkGenericAccount({ email: 'x@other.test' }, ['example.test']), /not from an organisation allowed/);
    checkGenericAccount({ email: 'x@example.test' }, ['example.test']);
    checkGenericAccount({ upn: 'x@example.test' }, []); // ADFS: no email_verified claim at all
  });

  test('a discovery document naming another issuer is not trusted, and signing in says so instead of a 500', async () => {
    advertisedIssuer = 'https://evil.example.test';
    try {
      resetDiscoveryCache();
      const agent = request.agent(app);
      const page = await agent.get('/login').expect(200);
      const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1]!;
      const start = await agent.post('/auth/login').type('form').send({ _csrf: csrf, provider: 'generic' });
      assert.equal(start.status, 503);
      assert.match(start.text, /Signing in with Company account is not available right now/);

      // The settings page says why, where it can be fixed.
      const saved = await as(admin).post('/admin/settings/integrations/openid').type('form')
        .send({ _csrf: admin.csrfToken, name: 'Company account', issuer: ISSUER, clientId: 'helpdesk', scopes: 'openid profile email', allowedDomains: '' })
        .expect(302);
      const shown = await as(admin).get(String(saved.headers.location)).expect(200);
      assert.match(shown.text, /Saved, but sign-in will not work yet/);
      assert.equal(await queryOne("SELECT id FROM users WHERE email = 'eve@example.test'"), undefined);
    } finally {
      advertisedIssuer = ISSUER;
    }
  });

  test('an account says which provider it signs in with, and the Identity providers tab is separated by provider', async () => {
    // It read "Microsoft Entra ID" for every account that was not a password one (reported 18 Oct 2026).
    const jana = await queryOne<{ id: string }>("SELECT id FROM users WHERE email = 'jana@example.test'");
    const page = await as(admin).get('/admin/settings/users/' + jana!.id).expect(200);
    assert.match(page.text, /Signs in with<\/dt>\s*<dd>\s*Company account \(JIT\)/);
    assert.doesNotMatch(page.text, /Microsoft Entra ID \(/);

    const all = await as(admin).get('/admin/settings/users/entra').expect(200);
    assert.match(all.text, /href="\/admin\/settings\/users\/entra\?idp=generic"[^>]*>Company account <span class="muted">\(\d+\)<\/span>/);
    const generic = await as(admin).get('/admin/settings/users/entra?idp=generic').expect(200);
    assert.match(generic.text, /jana@example\.test/);
    const entra = await as(admin).get('/admin/settings/users/entra?idp=entra').expect(200);
    assert.doesNotMatch(entra.text, /jana@example\.test/, "not under another provider's tab");
  });

  test('the whole discovery address pasted as the issuer works (reported with Auth0)', async () => {
    await as(admin).post('/admin/settings/integrations/openid').type('form')
      .send({ _csrf: admin.csrfToken, name: 'Company account', issuer: ISSUER + '/.well-known/openid-configuration', clientId: 'helpdesk', scopes: 'openid profile email', allowedDomains: '' })
      .expect(302);
    assert.equal(settings().genericOidc.issuer, ISSUER);
    assert.equal(settings().genericOidc.discoveryUrl, ISSUER + '/.well-known/openid-configuration');
    // A value saved before this, read as it is stored, is put right too.
    await updateSettings({ genericOidc: { issuer: ISSUER + '/.well-known/openid-configuration/' } }, null);
    assert.equal(settings().genericOidc.discoveryUrl, ISSUER + '/.well-known/openid-configuration');
    const { back } = await signInThroughProvider({ sub: 'kc-1', email: 'jana@example.test', email_verified: true });
    assert.equal(back.status, 302);
    assert.doesNotMatch(String(back.headers.location), /login/);
  });
});
