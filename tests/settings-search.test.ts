import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { SETTINGS_PLACES, searchSettings } from '../src/services/settings-search.js';

let app: Express;
let admin: TestSession;
let requester: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('search.admin@example.com', 'admin');
  requester = await signInAs('search.user@example.com', 'user');
});

describe('searching Settings', () => {
  test('every place it knows is a page that exists', async () => {
    for (const place of SETTINGS_PLACES) {
      const res = await as(admin).get(place.href.split('#')[0]!);
      assert.ok(res.status === 200 || res.status === 302, place.href + ' answered ' + res.status);
    }
  });

  test('finds a setting by its name, and by another word for it', () => {
    assert.equal(searchSettings('password policy')[0]?.title, 'Password policy');
    assert.equal(searchSettings('SSO')[0]?.section, 'integrations');
    assert.equal(searchSettings('logo')[0]?.title, 'Appearance');
    assert.equal(searchSettings('scim')[0]?.title, 'Provisioning (SCIM)');
    assert.equal(searchSettings('časové pásmo zone').length, 0, 'every word has to match');
    assert.equal(searchSettings('time zone')[0]?.title, 'Locale');
    assert.deepEqual(searchSettings('   '), []);
  });

  test('the bar is on every settings page, and the results are links', async () => {
    const page = await as(admin).get('/admin/settings/customization').expect(200);
    assert.match(page.text, /action="\/admin\/settings\/search"/);
    const found = await as(admin).get('/admin/settings/search').query({ q: 'smtp' }).expect(200);
    assert.match(found.text, /href="\/admin\/settings\/mail\/relay"/);
    assert.match(found.text, /value="smtp"/);
    const none = await as(admin).get('/admin/settings/search').query({ q: 'xyzzy' }).expect(200);
    assert.match(none.text, /Nothing in Settings matches/);
  });

  test('is an administrator\'s, like the rest of Settings', async () => {
    const res = await as(requester).get('/admin/settings/search').query({ q: 'logo' });
    assert.notEqual(res.status, 200);
  });
});
