import './env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query, queryOne } from '../src/db/index.js';
import { updateSettings } from '../src/settings/index.js';
import { certificateProblem, clearTokenCache, credentialsFor } from '../src/services/automation-connections.js';

const CONNECTIONS = '/admin/settings/advanced/connections';
const fixture = (name: string) => fs.readFileSync(path.join('tests', 'fixtures', name), 'utf8');
const CERT = fixture('client-cert.pem');
const KEY = fixture('client-key.pem');
const OTHER_KEY = fixture('other-key.pem');

let app: Express;
let admin: TestSession;
let server: http.Server;
let base = '';
/** What the fake token endpoint was last sent. */
let lastForm = new URLSearchParams();
let refreshIssued = 0;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('conn.admin@example.com', 'admin');
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastForm = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json');
      if (lastForm.get('grant_type') === 'authorization_code' && lastForm.get('code') === 'good-code') {
        res.end(JSON.stringify({ access_token: 'at-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1' }));
      } else if (lastForm.get('grant_type') === 'refresh_token' && lastForm.get('refresh_token')?.startsWith('rt-')) {
        refreshIssued += 1;
        res.end(JSON.stringify({ access_token: 'at-' + (refreshIssued + 1), token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-' + (refreshIssued + 1) }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'secret stuff <b>' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
});
after(() => server.close());

describe('a client certificate (mTLS) connection', () => {
  test('a key that does not belong to the certificate is refused; a matching pair is stored sealed', async () => {
    assert.match(certificateProblem(CERT, OTHER_KEY, ''), /does not belong/);
    assert.equal(certificateProblem(CERT, KEY, ''), '');

    const refused = await post(admin, CONNECTIONS, { authType: 'mtls', name: 'Bank', clientCert: CERT, clientKey: OTHER_KEY }).expect(400);
    assert.match(refused.text, /does not belong to that certificate/);
    assert.ok(!refused.text.includes(OTHER_KEY.split(/\r?\n/)[1]!), 'the key is never echoed');

    await post(admin, CONNECTIONS, { authType: 'mtls', name: 'Bank', clientCert: CERT, clientKey: KEY }).expect(302);
    const row = (await queryOne<{ id: string; client_key: string; client_cert: string }>("SELECT id, client_key, client_cert FROM automation_connections WHERE name = 'Bank'"))!;
    assert.ok(!row.client_key.includes('BEGIN PRIVATE KEY'), 'sealed');
    assert.match(row.client_cert, /BEGIN CERTIFICATE/);

    const page = await as(admin).get(CONNECTIONS).expect(200);
    assert.match(page.text, /helpdesk-test-client/);
    assert.match(page.text, /Client certificate/);

    const creds = await credentialsFor(row.id);
    assert.equal(creds.header, undefined);
    assert.match(creds.tls!.key, /BEGIN PRIVATE KEY/);

    // An edit that leaves both boxes empty keeps the pair.
    await post(admin, CONNECTIONS + '/' + row.id, { authType: 'mtls', name: 'Bank' }).expect(302);
    assert.ok((await credentialsFor(row.id)).tls);
  });
});

describe('OAuth signed in as a person', () => {
  test('Sign in goes to the provider with PKCE; the code buys a refresh token, kept sealed', async () => {
    await post(admin, CONNECTIONS, {
      authType: 'oauth2_user',
      name: 'Mailbox as Jana',
      authorizeUrl: 'https://login.example.test/authorize',
      userTokenUrl: base + '/token',
      userClientId: 'helpdesk',
      userClientSecret: 'shh',
      userScope: 'offline_access mail.send',
    }).expect(302);
    const id = (await queryOne<{ id: string }>("SELECT id FROM automation_connections WHERE name = 'Mailbox as Jana'"))!.id;

    const page = await as(admin).get(CONNECTIONS).expect(200);
    assert.match(page.text, /Not signed in/);
    assert.match(String(page.headers['content-security-policy']), /form-action 'self' https:\/\/login\.example\.test/);

    const agent = as(admin);
    const start = await agent.post(CONNECTIONS + '/' + id + '/authorize').type('form').send({ _csrf: admin.csrfToken }).expect(302);
    const to = new URL(String(start.headers.location));
    assert.equal(to.origin + to.pathname, 'https://login.example.test/authorize');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.match(to.searchParams.get('redirect_uri')!, /\/admin\/settings\/advanced\/connections\/oauth\/callback$/);
    assert.equal(to.searchParams.get('scope'), 'offline_access mail.send');

    // A state that is not this session's is refused, and spends the attempt.
    await agent.get(CONNECTIONS + '/oauth/callback?code=good-code&state=forged').expect(302);
    assert.equal((await queryOne<{ refresh_token: string }>('SELECT refresh_token FROM automation_connections WHERE id = ?', [id]))!.refresh_token, '');

    const again = await agent.post(CONNECTIONS + '/' + id + '/authorize').type('form').send({ _csrf: admin.csrfToken }).expect(302);
    const state = new URL(String(again.headers.location)).searchParams.get('state')!;
    await agent.get(CONNECTIONS + '/oauth/callback?code=good-code&state=' + encodeURIComponent(state)).expect(302);
    assert.equal(lastForm.get('grant_type'), 'authorization_code');
    assert.ok(lastForm.get('code_verifier'), 'PKCE verifier sent');
    const row = (await queryOne<{ refresh_token: string; signed_in_by: string }>('SELECT refresh_token, signed_in_by FROM automation_connections WHERE id = ?', [id]))!;
    assert.ok(row.refresh_token && !row.refresh_token.includes('rt-1'), 'stored sealed');
    assert.ok(row.signed_in_by);

    // The next token comes from the refresh token, and a rotated one replaces it.
    clearTokenCache();
    const creds = await credentialsFor(id);
    assert.equal(creds.header?.value, 'Bearer at-2');
    assert.equal(lastForm.get('refresh_token'), 'rt-1');
    clearTokenCache();
    await credentialsFor(id);
    assert.equal(lastForm.get('refresh_token'), 'rt-2', 'the rotated token was kept');

    // Moving it to another provider forgets the sign-in.
    await post(admin, CONNECTIONS + '/' + id, {
      authType: 'oauth2_user', name: 'Mailbox as Jana', authorizeUrl: 'https://elsewhere.example.test/authorize',
      userTokenUrl: base + '/token', userClientId: 'helpdesk', userScope: 'offline_access',
    }).expect(302);
    assert.equal((await query<{ refresh_token: string }>('SELECT refresh_token FROM automation_connections WHERE id = ?', [id]))[0]!.refresh_token, '');
  });
});
