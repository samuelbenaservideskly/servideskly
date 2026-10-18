import './env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings, settingsDocument, updateSettings } from '../src/settings/index.js';
import { checkGoogleAccount, configuredProviders, providerOfIssuer, resetDiscoveryCache } from '../src/auth/oidc.js';
import { queryOne } from '../src/db/index.js';

let app: Express;
let admin: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

/** Discovery documents as Google and Okta publish them, served by a fake fetch. */
const realFetch = globalThis.fetch;
before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('idp.admin@example.com', 'admin');
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const issuer = url.startsWith('https://accounts.google.com')
      ? 'https://accounts.google.com'
      : 'https://acme.okta.com/oauth2/default';
    const body = {
      issuer,
      authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/keys',
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

describe('integration tiles', () => {
  test('Entra ID, Google Identity and Okta are offered', async () => {
    const page = await as(admin).get('/admin/settings/integrations').expect(200);
    assert.match(page.text, /Microsoft Entra ID/);
    assert.match(page.text, /Google Identity/);
    assert.match(page.text, />Okta</);
    // The Okta mark takes the text colour, so it is visible in the dark theme.
    assert.match(page.text, /class="entra-logo idp-logo--okta" viewBox="0 0 48 48" fill="currentColor"/);
  });
});

describe('Google', () => {
  test('cannot be saved without a Workspace domain', async () => {
    const refused = await as(admin)
      .post('/admin/settings/integrations/google')
      .type('form')
      .send({ _csrf: admin.csrfToken, clientId: '123-abc.apps.googleusercontent.com', clientSecret: 's3cret', allowedDomains: '' })
      .expect(400);
    assert.match(refused.text, /Without it, any Google account could sign in/);
    assert.equal(settings().google.configured, false);
  });

  test('saves, keeps the secret sealed, and becomes available', async () => {
    await as(admin)
      .post('/admin/settings/integrations/google')
      .type('form')
      .send({ _csrf: admin.csrfToken, clientId: '123-abc.apps.googleusercontent.com', clientSecret: 's3cret', allowedDomains: 'https://Example.com/\nexample.org' })
      .expect(302);
    assert.equal(settings().google.configured, true);
    assert.deepEqual(settings().google.allowedDomains, ['example.com', 'example.org']);
    assert.notEqual(settingsDocument().google.clientSecret, 's3cret', 'stored sealed, not in clear');
    const page = await as(admin).get('/admin/settings/integrations/google').expect(200);
    assert.doesNotMatch(page.text, /s3cret/);
    assert.ok(configuredProviders().includes('google'));
  });

  test('only an allowed Workspace domain with a verified email may sign in', () => {
    const allowed = ['example.com'];
    checkGoogleAccount({ hd: 'example.com', email_verified: true }, allowed);
    assert.throws(() => checkGoogleAccount({ email_verified: true }, allowed), /not from an organisation allowed/);
    assert.throws(() => checkGoogleAccount({ hd: 'evil.com', email_verified: true }, allowed), /not from an organisation allowed/);
    assert.throws(() => checkGoogleAccount({ hd: 'example.com', email_verified: false }, allowed), /could not be verified/);
  });
});

describe('Okta', () => {
  test('normalises the domain and builds the discovery address', async () => {
    await as(admin)
      .post('/admin/settings/integrations/okta')
      .type('form')
      .send({ _csrf: admin.csrfToken, domain: 'https://Acme.okta.com/', authServer: 'default', clientId: 'okta-client', clientSecret: 'shh' })
      .expect(302);
    assert.equal(settings().okta.domain, 'acme.okta.com');
    assert.equal(settings().okta.discoveryUrl, 'https://acme.okta.com/oauth2/default/.well-known/openid-configuration');
    assert.equal(settings().okta.configured, true);
    // Both addresses Okta must have registered, side by side (asked for 18 Oct 2026).
    const page = await as(admin).get('/admin/settings/integrations/okta').expect(200);
    assert.match(page.text, /Redirect URI<\/dt>\s*<dd class="mono copyable">[^<]+\/auth\/oidc\/callback<\/dd>/);
    assert.match(page.text, /Sign-out redirect URI<\/dt>\s*<dd class="mono copyable">[^<]+\/login\?signedOut=1<\/dd>/);
  });

  test("an account is placed by its issuer: Okta's is Okta, not Entra", () => {
    assert.equal(providerOfIssuer('https://acme.okta.com/oauth2/default'), 'okta');
    assert.equal(providerOfIssuer('https://dev-1234567.okta.com/oauth2/default'), 'okta', 'any Okta org, configured or not');
    assert.equal(providerOfIssuer('https://login.microsoftonline.com/tenant/v2.0'), 'entra');
    assert.equal(providerOfIssuer('urn:helpdesk:scim'), 'entra', "Entra's provisioning");
    assert.equal(providerOfIssuer('https://accounts.google.com'), 'google');
    assert.equal(providerOfIssuer('urn:helpdesk:local'), null, 'a password account is no provider');
  });

  test('a bad domain is refused on the form', async () => {
    const refused = await as(admin)
      .post('/admin/settings/integrations/okta')
      .type('form')
      .send({ _csrf: admin.csrfToken, domain: 'not a host', authServer: 'default', clientId: 'x' })
      .expect(400);
    assert.match(refused.text, /must be a host name/);
  });
});

describe('signing in', () => {
  test('the sign-in page offers one button per configured provider', async () => {
    const page = await request(app).get('/login').expect(200);
    assert.match(page.text, /name="provider" value="google"/);
    assert.match(page.text, /Sign in with Google/);
    assert.match(page.text, /Sign in with Okta/);
    assert.doesNotMatch(page.text, /Sign in with Microsoft/, 'Entra ID is not configured here');
  });

  test('each button starts the code flow at its own provider, remembering which', async () => {
    resetDiscoveryCache();
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1]!;

    const google = await agent.post('/auth/login').type('form').send({ _csrf: csrf, provider: 'google' }).expect(302);
    const g = new URL(String(google.headers.location));
    assert.equal(g.origin + g.pathname, 'https://accounts.google.com/authorize');
    assert.equal(g.searchParams.get('client_id'), '123-abc.apps.googleusercontent.com');
    assert.equal(g.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(g.searchParams.get('redirect_uri'), settings().oidc.redirectUri);
    const flow = await queryOne<{ provider: string }>('SELECT provider FROM auth_requests WHERE id = ?', [g.searchParams.get('state')]);
    assert.equal(flow?.provider, 'google');
    // Google cannot be signed out of from here, so it always asks which account.
    assert.equal(g.searchParams.get('prompt'), 'select_account');

    const okta = await agent.post('/auth/login').type('form').send({ _csrf: csrf, provider: 'okta' }).expect(302);
    assert.match(String(okta.headers.location), /^https:\/\/acme\.okta\.com\/oauth2\/default\/authorize\?/);
    assert.equal(new URL(String(okta.headers.location)).searchParams.get('prompt'), null, 'only Google is asked to show the account chooser');
  });

  test('a provider that is not configured is refused', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)![1]!;
    await agent.post('/auth/login').type('form').send({ _csrf: csrf, provider: 'entra' }).expect(400);
  });

  test('another identity provider is enough to allow disabling local sign-in', async () => {
    await updateSettings({ localAccounts: { signInEnabled: true } }, null);
    const page = await as(admin).post('/admin/settings/users/local-signin').type('form').send({ _csrf: admin.csrfToken }).expect(302);
    void page;
    // Google is configured, but no Google account is an administrator yet.
    const users = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(users.text, /until at least one account from your identity\s+provider has the Administrator role/);
  });
});
