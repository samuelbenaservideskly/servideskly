import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup } from '../src/services/groups.js';
import { createUserGroup, userGroupSourcesFor } from '../src/services/user-groups.js';

/** User groups are set from a person's page too; the people picker searches as you type. */

let app: Express;
let admin: TestSession;
let person: TestSession;

const as = (s: TestSession) => request.agent(app).set('Cookie', s.cookie);

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('both.admin@example.com', 'admin');
  person = await signInAs('both.person@example.com', 'user');
});

describe("a person's user groups, from their own page", () => {
  test('ticked groups are joined, unticked left; a rule membership is shown, not changed', async () => {
    const finance = await createUserGroup({ name: 'Finance', description: '', isActive: true }, null);
    const prague = await createUserGroup({ name: 'Prague office', description: '', isActive: true }, null);
    const vip = await createUserGroup({ name: 'VIPs', description: '', isActive: true }, null);
    await execute("INSERT INTO user_group_members (group_id, user_id, source, added_at) VALUES (?, ?, 'rule', ?)", [vip.id, person.user.id, new Date().toISOString()]);

    const page = await as(admin).get('/admin/settings/users/' + person.user.id).expect(200);
    assert.match(page.text, /<h2 class="section-title">User groups<\/h2>/);
    assert.match(page.text, new RegExp('value="' + vip.id + '" checked disabled'), 'a rule membership is locked');

    const save = (groups: string[]) =>
      as(admin).post('/admin/settings/users/' + person.user.id + '/user-groups').type('form').send({ _csrf: admin.csrfToken, userGroups: groups });
    await save([finance.id, prague.id]).expect(302);
    let now = await userGroupSourcesFor(person.user.id);
    assert.deepEqual([now.get(finance.id), now.get(prague.id), now.get(vip.id)], ['manual', 'manual', 'rule']);

    // Unticking Prague (and VIPs, which the form cannot post) leaves the rule alone.
    await save([finance.id]).expect(302);
    now = await userGroupSourcesFor(person.user.id);
    assert.deepEqual([now.get(finance.id), now.get(prague.id), now.get(vip.id)], ['manual', undefined, 'rule']);
  });
});

describe('names in the ticket list', () => {
  test('open the person\'s page, for an administrator and a technician alike', async () => {
    const { createTicket } = await import('../src/services/tickets.js');
    const tech = await signInAs('both.tech@example.com', 'agent');
    const t = await createTicket({ title: 'Clickable names', description: 'Whose is it?', priority: 'normal', category: 'other', requesterId: person.user.id });
    await execute('UPDATE tickets SET assignee_id = ? WHERE id = ?', [tech.user.id, t.id]);
    const forAdmin = await as(admin).get('/tickets').expect(200);
    assert.match(forAdmin.text, new RegExp('href="/people/' + person.user.id + '"'));
    assert.match(forAdmin.text, new RegExp('href="/people/' + tech.user.id + '"'));

    const forTech = await as(tech).get('/tickets').expect(200);
    assert.match(forTech.text, new RegExp('href="/people/' + person.user.id + '"'));
    assert.doesNotMatch(forTech.text, /href="\/admin\/settings\/users\//, 'no links into Settings for a technician');

    // The page itself: the same for both, and "Open in Users" only for the
    // administrator, because that is the page that changes an account.
    const techView = await as(tech).get('/people/' + person.user.id).expect(200);
    assert.match(techView.text, /Latest tickets they raised/);
    assert.doesNotMatch(techView.text, /Open in Users/);
    const adminView = await as(admin).get('/people/' + person.user.id).expect(200);
    assert.match(adminView.text, new RegExp('href="/admin/settings/users/' + person.user.id + '"'));

    // Not for a requester: the same 404 as a name that does not exist.
    const requester = await signInAs('nosy@example.com', 'user');
    await as(requester).get('/people/' + tech.user.id).expect(404);

    await as(tech).get('/tickets?requester=' + person.user.id + '&status=any').expect(200);
  });
});

describe('Find people to add', () => {
  test('searches as you type on both group pages - its own script, to this server only', async () => {
    const tech = await createGroup({ name: 'Network', description: '', isActive: true }, null);
    const users = await createUserGroup({ name: 'Everyone', description: '', isActive: true }, null);
    for (const url of ['/admin/settings/groups/' + tech.id, '/admin/settings/groups/users/' + users.id]) {
      const page = await as(admin).get(url).expect(200);
      // On the people form (the one with the search box), not the members' page size.
      assert.match(page.text, /data-live-search="people-results">\s*(<%#[^]*?%>\s*)?<input type="hidden" name="msize"/, url);
      assert.match(page.text, /<button type="submit" class="btn" data-live-hide>Search<\/button>/, url);
      assert.match(page.text, /<div id="people-results"/, url);
      assert.match(page.text, /\/assets\/js\/live-search\.js/, url);
      const csp = String(page.headers['content-security-policy']);
      assert.match(csp, /script-src 'self'/, url);
      assert.match(csp, /connect-src 'self'(;|$)/, url);
    }
  });
});
