import './env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import { STANDARD_PORTAL, isScriptOrigin, partProblems, setDefaultPortal } from '../src/services/portal.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { query } from '../src/db/index.js';

const BASE = '/admin/settings/customization/portal';
const ADVANCED = '/admin/settings/advanced/javascript';

let app: Express;
let admin: TestSession;
let requester: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

function post(session: TestSession, url: string, form: Record<string, string> = {}) {
  return as(session)
    .post(url)
    .type('form')
    .send({ _csrf: session.csrfToken, ...form });
}

function csp(response: request.Response): string {
  return String(response.headers['content-security-policy'] ?? '');
}

async function newPortal(name: string): Promise<string> {
  const response = await post(admin, BASE, { name }).expect(302);
  const id = /\/portal\/([^/?#]+)$/.exec(response.headers.location ?? '')?.[1];
  assert.ok(id);
  return id;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('scripts.admin@example.com', 'admin');
  requester = await signInAs('scripts.requester@example.com', 'user');
});

after(async () => {
  await updateSettings({ portalScripts: { enabled: false, allowedOrigins: [] } }, null);
  await setDefaultPortal(STANDARD_PORTAL, null);
});

describe('the Advanced settings switch', () => {
  test('is off by default, and the portal editor offers no JavaScript tab', async () => {
    assert.equal(settings().portalScripts.enabled, false);
    const id = await newPortal('No scripts yet');
    const page = await as(admin).get(BASE + '/' + id).expect(200);
    assert.doesNotMatch(page.text, />JavaScript</);
    await post(admin, BASE + '/' + id + '/parts/js', { code: 'console.log(1)' }).expect(404);
  });

  test('the section is in the sidebar and opens on the JavaScript tab', async () => {
    await as(admin).get('/admin/settings/advanced').expect(302).expect('location', ADVANCED);
    const page = await as(admin).get(ADVANCED).expect(200);
    assert.match(page.text, /Advanced settings/);
    assert.match(page.text, /id="enable-js"/);
    assert.match(page.text, /href="#enable-js"/);
  });

  test('turning it on needs the acknowledgement, and re-opens the warning without it', async () => {
    const refused = await post(admin, ADVANCED + '/enable').expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="enable-js"/);
    assert.match(refused.text, /understand the risks/);
    assert.equal(settings().portalScripts.enabled, false);

    await post(admin, ADVANCED + '/enable', { understood: 'on' }).expect(302);
    assert.equal(settings().portalScripts.enabled, true);

    const rows = await query<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'settings.portal_scripts.enabled'",
    );
    assert.equal(rows.length, 1);
  });

  test('only an administrator may change it', async () => {
    await post(requester, ADVANCED + '/disable').expect(403);
  });

  test('allowed origins must be bare https origins', async () => {
    assert.equal(isScriptOrigin('https://cdn.example.com'), true);
    assert.equal(isScriptOrigin('http://cdn.example.com'), false);
    assert.equal(isScriptOrigin('https://cdn.example.com/lib.js'), false);
    assert.equal(isScriptOrigin("https://x.com 'unsafe-inline'"), false);
    assert.equal(isScriptOrigin('*'), false);

    const refused = await post(admin, ADVANCED + '/origins', {
      origins: "https://ok.example.com\n'unsafe-eval'",
    }).expect(400);
    assert.match(refused.text, /Not accepted/);
    assert.deepEqual(settings().portalScripts.allowedOrigins, []);

    await post(admin, ADVANCED + '/origins', { origins: 'https://cdn.example.com/\r\n\r\n' }).expect(302);
    assert.deepEqual(settings().portalScripts.allowedOrigins, ['https://cdn.example.com']);
  });
});

describe('a portal with a script', () => {
  let id = '';

  before(async () => {
    await updateSettings({ portalScripts: { enabled: true } }, null);
    id = await newPortal('Scripted');
    await post(admin, BASE + '/' + id + '/parts/js', { code: 'document.body.dataset.ran = "yes";' }).expect(302);
    await post(admin, BASE + '/' + id + '/default').expect(302);
  });

  test('a <script> wrapper is refused, since the code is served as a file', () => {
    assert.ok(partProblems('js', '<script>alert(1)</script>', new Set()).length > 0);
    assert.deepEqual(partProblems('js', 'alert(1)', new Set()), []);
  });

  test('the requester page loads it as a file and its policy names only self and the list', async () => {
    const page = await as(requester).get('/tickets').expect(200);
    assert.match(page.text, new RegExp('<script src="/portal/' + id + '/script\\.js\\?v=[0-9a-f]+" defer></script>'));
    const policy = csp(page);
    assert.match(policy, /script-src 'self' https:\/\/cdn\.example\.com/);
    assert.match(policy, /connect-src 'self' https:\/\/cdn\.example\.com/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  });

  test('the script is served as JavaScript to whoever is shown the portal', async () => {
    const file = await as(requester).get('/portal/' + id + '/script.js').expect(200);
    assert.match(String(file.headers['content-type']), /^text\/javascript/);
    assert.equal(file.headers['x-content-type-options'], 'nosniff');
    assert.equal(file.text, 'document.body.dataset.ran = "yes";');
    await request(app).get('/portal/' + id + '/script.js').expect((r) => assert.notEqual(r.status, 200));
  });

  test('never on the sign-in page, in Settings, or in the editor frame', async () => {
    const login = await request(app).get('/login').expect(200);
    assert.match(csp(login), /script-src 'none'/);
    assert.doesNotMatch(login.text, /script\.js/);

    const settingsPage = await as(admin).get('/admin/settings/customization').expect(200);
    assert.doesNotMatch(csp(settingsPage), /cdn\.example\.com/);

    const framed = await as(admin).get('/tickets?portalFrame=' + id);
    assert.doesNotMatch(framed.text, /\/script\.js/);
    assert.doesNotMatch(csp(framed), /cdn\.example\.com/);
  });

  test('turning the switch off stops it everywhere at once, and keeps the code', async () => {
    await post(admin, ADVANCED + '/disable').expect(302);
    assert.equal(settings().portalScripts.enabled, false);

    const page = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(page.text, /script\.js/);
    assert.match(csp(page), /script-src 'none'/);
    await as(requester).get('/portal/' + id + '/script.js').expect(404);

    const stored = await query<{ script: string }>('SELECT script FROM portal_themes WHERE id = ?', [id]);
    assert.equal(stored[0]?.script, 'document.body.dataset.ran = "yes";');
  });
});
