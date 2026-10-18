import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';

/** Users - Other settings - People may change their own details. */

let app: Express;
let admin: TestSession;
let person: TestSession;
const as = (s: TestSession) => request.agent(app).set('Cookie', s.cookie);
const post = (s: TestSession, url: string, form: Record<string, unknown>) => as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
const details = () => queryOne<{ company: string; department: string; phone: string; office: string }>('SELECT company, department, phone, office FROM users WHERE id = ?', [person.user.id]);

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('self.admin@example.com', 'admin');
  person = await signInAs('self.person@example.com', 'user');
});

describe('people changing their own details', () => {
  test('off by default: no card, and a post is refused', async () => {
    assert.doesNotMatch((await as(person).get('/profile').expect(200)).text, /Your details/);
    await post(person, '/profile/details', { company: 'Contoso' }).expect(403);
  });

  test('only the ticked fields are offered and saved', async () => {
    await post(admin, '/admin/settings/users/other/self-edit', { fields: ['company', 'phone'] }).expect(302);
    const page = await as(person).get('/profile').expect(200);
    assert.match(page.text, /name="company"/);
    assert.match(page.text, /name="phone" type="tel"/);
    assert.doesNotMatch(page.text, /name="office"/);

    await post(person, '/profile/details', { company: '  Contoso  ', phone: '+420 123 456 789', office: 'Prague HQ' }).expect(302);
    const now = await details();
    assert.equal(now?.company, 'Contoso');
    assert.equal(now?.phone, '+420 123 456 789');
    assert.equal(now?.office ?? '', '', 'a field not allowed is not written, whatever is posted');
  });

  test('the switch is behind its own chevron on Other settings', async () => {
    const page = await as(admin).get('/admin/settings/users/other').expect(200);
    assert.match(page.text, /<details class="mode-panel settings-panel" id="self-edit">/);
    assert.match(page.text, /name="fields" value="company" checked/);
  });
});
