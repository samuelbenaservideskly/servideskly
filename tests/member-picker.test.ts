import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, listMembers, setMembers } from '../src/services/groups.js';
import { upsertUserFromDirectory } from '../src/services/users.js';

/**
 * The member picker shows a page at a time, which makes one property load
 * bearing: **saving a page must not touch anybody on the other pages.** The
 * form used to carry everybody, so the save replaced the whole list; with
 * paging, that same code would empty a group of all but the ten people on
 * screen. Nothing on the page would say it had happened.
 */

let app: Express;
let admin: TestSession;
let agent: request.Agent;
let groupId: string;
const staff: { id: string; name: string }[] = [];

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();

  admin = await signInAs('picker.admin@example.com', 'admin');
  agent = request.agent(app);
  agent.set('Cookie', admin.cookie);

  // Enough to need more than one page of ten.
  for (let i = 1; i <= 25; i++) {
    const name = 'Agent ' + String(i).padStart(2, '0');
    const { user } = await upsertUserFromDirectory({
      issuer: 'https://login.microsoftonline.com/test-tenant/v2.0',
      externalId: 'oid-picker-' + i,
      email: 'picker' + String(i).padStart(2, '0') + '@example.com',
      upn: 'picker' + i + '@example.com',
      displayName: name,
      role: 'agent',
      source: 'jit',
      markLogin: true,
    });
    staff.push({ id: user.id, name });
  }

  const group = await createGroup(
    { name: 'Paged group', description: '', isActive: true },
    admin.user.id,
  );
  groupId = group.id;
});

describe('the member picker', () => {
  test('members and people to add are two tables, not one list of ticks', async () => {
    const res = await agent.get('/admin/settings/groups/' + groupId).expect(200);
    assert.match(res.text, /In the group/);
    assert.match(res.text, /Find people to add/);
  });

  test('shows ten people to add at a time, and says how many there are', async () => {
    const res = await agent.get('/admin/settings/groups/' + groupId).expect(200);

    const rows = res.text.match(/name="shown" value="/g) ?? [];
    assert.equal(rows.length, 10, 'a page is ten people');
    assert.match(res.text, /Showing 10 of 2[67]/);
  });

  test('a larger page size is honoured', async () => {
    const res = await agent.get('/admin/settings/groups/' + groupId + '?size=50').expect(200);
    const rows = res.text.match(/name="shown" value="/g) ?? [];
    assert.ok(rows.length > 20, 'everybody fits on one page of fifty');
  });

  test('searching narrows the list in SQL, not just on screen', async () => {
    const res = await agent
      .get('/admin/settings/groups/' + groupId + '?q=' + encodeURIComponent('picker07'))
      .expect(200);

    const rows = res.text.match(/name="shown" value="/g) ?? [];
    assert.equal(rows.length, 1);
    // The picker only: the manager dropdown above it lists all staff.
    const picker = res.text.slice(res.text.indexOf('id="members"'));
    assert.match(picker, /Agent 07/);
    assert.doesNotMatch(picker, /Agent 08/);
  });

  test('adding one person leaves everybody else exactly as they were', async () => {
    // Somebody who will not be on the page the add is made from.
    const faraway = staff[22];
    const first = staff[0];
    assert.ok(faraway && first);
    await setMembers(groupId, [faraway.id], admin.user.id);

    const page = await agent.get('/admin/settings/groups/' + groupId).expect(200);

    // What an Add button posts: the one person it acts on.
    await agent
      .post('/admin/settings/groups/' + groupId + '/members')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), shown: first.id, members: first.id })
      .expect(302);

    const ids = (await listMembers(groupId)).map((m) => m.id);
    assert.ok(ids.includes(first.id), 'the person added is a member');
    assert.ok(ids.includes(faraway.id), 'and the one already in the group is untouched');
    assert.equal(ids.length, 2);
  });

  test('removing one person removes that one and nobody else', async () => {
    const first = staff[0];
    const faraway = staff[22];
    assert.ok(first && faraway);

    const page = await agent.get('/admin/settings/groups/' + groupId).expect(200);

    // What a Remove button posts: the id, and no `members` for it.
    await agent
      .post('/admin/settings/groups/' + groupId + '/members')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), shown: first.id })
      .expect(302);

    const ids = (await listMembers(groupId)).map((m) => m.id);
    assert.ok(!ids.includes(first.id), 'removed');
    assert.ok(ids.includes(faraway.id), 'and nobody else is touched');
  });

  test('the members table pages on its own parameters', async () => {
    // Everybody in, so the members table has more than one page of ten.
    await setMembers(groupId, staff.map((person) => person.id), admin.user.id);

    const first = await agent.get('/admin/settings/groups/' + groupId).expect(200);
    assert.match(first.text, /Page 1 of 3/, '25 members at ten a page');

    // Searching the other table must not move this one.
    const searched = await agent
      .get('/admin/settings/groups/' + groupId + '?q=picker07')
      .expect(200);
    assert.match(searched.text, /Page 1 of 3/);

    const second = await agent.get('/admin/settings/groups/' + groupId + '?mpage=2').expect(200);
    assert.match(second.text, /Page 2 of 3/);
  });
});
