import './env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { discover, resetDiscoveryCache } from '../src/auth/oidc.js';

/**
 * The private-network rule for single sign-on (security review, 21 Oct
 * 2026): an address an administrator typed is not fetched when it leads into
 * the internal network, unless "Allow addresses on the internal network" is on.
 */

let app: Express;
let admin: TestSession;
const realFetch = globalThis.fetch;
let fetched: string[] = [];

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('internal.admin@example.com', 'admin');
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    const base = url.replace('/.well-known/openid-configuration', '');
    return new Response(
      JSON.stringify({
        issuer: base,
        authorization_endpoint: base + '/auth',
        token_endpoint: base + '/token',
        jwks_uri: base + '/certs',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

async function provider(issuer: string, allowPrivateNetwork: boolean): Promise<void> {
  await updateSettings({ genericOidc: { name: 'Keycloak', issuer, clientId: 'helpdesk', clientSecret: 'secret', allowPrivateNetwork } }, null);
  resetDiscoveryCache();
  fetched = [];
}

describe('single sign-on and the internal network', () => {
  test('an internal address is refused, and nothing is fetched', async () => {
    for (const issuer of ['https://127.0.0.1/realms/staff', 'https://localhost/realms/staff', 'https://10.0.0.5/adfs', 'https://[::1]/adfs']) {
      await provider(issuer, false);
      await assert.rejects(discover('generic'), /internal network/, issuer);
      assert.deepEqual(fetched, [], 'not even the discovery document: ' + issuer);
    }
  });

  test('with the switch on, an internal provider works', async () => {
    await provider('https://10.0.0.5/realms/staff', true);
    const found = await discover('generic');
    assert.equal(found.doc.token_endpoint, 'https://10.0.0.5/realms/staff/token');
  });

  test('the page offers the switch with its explanation, and saves it', async () => {
    await provider('https://10.0.0.5/realms/staff', false);
    const page = await request(app).get('/admin/settings/integrations/openid').set('Cookie', admin.cookie).expect(200);
    assert.match(page.text, /name="allowPrivateNetwork"/);
    assert.match(page.text, /Allow addresses on the internal network/);
    assert.match(page.text, /runs inside your company network/);

    await request(app)
      .post('/admin/settings/integrations/openid')
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ _csrf: admin.csrfToken, name: 'Keycloak', issuer: 'https://10.0.0.5/realms/staff', clientId: 'helpdesk', scopes: 'openid profile email', allowPrivateNetwork: 'on' })
      .expect(302);
    assert.equal(settings().genericOidc.allowPrivateNetwork, true);
  });
});
