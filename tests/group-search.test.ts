import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { createGroup } from '../src/services/groups.js';
import { createUserGroup } from '../src/services/user-groups.js';
import { wantsSelectSearch } from '../src/middleware/select-search.js';

let app: Express;
let admin: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('groupsearch.admin@example.com', 'admin');
  // More than a page of each, so paging shows.
  for (let i = 1; i <= 55; i += 1) {
    const n = String(i).padStart(2, '0');
    await createGroup({ name: 'Team ' + n, description: i === 7 ? 'Printers and scanners' : '', isActive: true }, null);
    await createUserGroup({ name: 'Office ' + n, description: '', isActive: true }, null);
  }
  await createGroup({ name: '100% done_team', description: '', isActive: true }, null);
});

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}

describe('searching and paging the group lists', () => {
  test('technician groups: 50 a page, searched by name or description in SQL', async () => {
    const first = await as(admin).get('/admin/settings/groups').expect(200);
    assert.match(first.text, /placeholder="Search groups"/);
    assert.equal((first.text.match(/class="link-strong"/g) ?? []).length, 50);
    assert.match(first.text, /href="\/admin\/settings\/groups\?page=2"/);

    const second = await as(admin).get('/admin/settings/groups?page=2').expect(200);
    assert.equal((second.text.match(/class="link-strong"/g) ?? []).length, 6);

    const printers = await as(admin).get('/admin/settings/groups?q=printers').expect(200);
    assert.match(printers.text, />Team 07</);
    assert.equal((printers.text.match(/class="link-strong"/g) ?? []).length, 1);

    // % and _ are text, not wildcards.
    const literal = await as(admin).get('/admin/settings/groups?q=' + encodeURIComponent('100%')).expect(200);
    assert.equal((literal.text.match(/class="link-strong"/g) ?? []).length, 1);
    const none = await as(admin).get('/admin/settings/groups?q=nothing-like-this').expect(200);
    assert.match(none.text, /Nothing matches "nothing-like-this"/);
  });

  test('user groups: the same', async () => {
    const page = await as(admin).get('/admin/settings/groups/users?q=office+05').expect(200);
    assert.match(page.text, /placeholder="Search user groups"/);
    assert.match(page.text, />Office 05</);
    assert.doesNotMatch(page.text, />Office 06</);
  });

  test('a long list of tick boxes asks for the search script', () => {
    const boxes = (n: number) => '<label><input type="checkbox" name="groups" value="x"> G</label>'.repeat(n);
    assert.equal(wantsSelectSearch(boxes(8)), false);
    assert.equal(wantsSelectSearch(boxes(9)), true);
  });
});
