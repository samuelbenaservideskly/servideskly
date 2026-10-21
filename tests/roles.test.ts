import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { execute, queryOne } from '../src/db/index.js';
import { createRole, loadRoles, permissionForSettingsPath, setCustomRole } from '../src/auth/permissions.js';
import { findUserById } from '../src/services/users.js';
import { createGroup, setMembers } from '../src/services/groups.js';
import { addComment, createTicket } from '../src/services/tickets.js';

/**
 * Custom roles (auth/permissions.ts, 21 Oct 2026): ticked permissions, each
 * checked where it is used, and the two rules that keep a role from
 * growing itself - only an administrator manages roles, and only an
 * administrator gives anybody a role.
 */

let app: Express;
let admin: TestSession;
const SYSTEM = { id: 'system', email: 'system@example.com' };

async function withRole(email: string, permissions: string[]): Promise<TestSession> {
  const session = await signInAs(email, 'user');
  const roleId = await createRole({ name: 'Role for ' + email, description: '', permissions }, SYSTEM);
  await setCustomRole(session.user.id, roleId);
  return session;
}

const get = (path: string, who: TestSession) => request(app).get(path).set('Cookie', who.cookie);

before(async () => {
  await bootstrapTestDatabase();
  await execute('UPDATE users SET role_id = NULL');
  await execute('DELETE FROM roles');
  await loadRoles();
  app = createApp();
  admin = await signInAs('roles.admin@example.com', 'admin');
});

describe('which permission a Settings page needs', () => {
  test('by its section, with automation and API keys on their own, and roles an administrator\'s', () => {
    assert.equal(permissionForSettingsPath('/settings/mail/notifications'), 'settings.mail');
    assert.equal(permissionForSettingsPath('/settings/advanced/automation/abc'), 'automation.manage');
    assert.equal(permissionForSettingsPath('/settings/advanced/api-keys'), 'api.manage');
    assert.equal(permissionForSettingsPath('/settings/advanced/data'), 'settings.advanced');
    assert.equal(permissionForSettingsPath('/settings/users/roles'), 'admin');
    assert.equal(permissionForSettingsPath('/settings'), 'any');
  });
});

describe('a custom role', () => {
  test('opens only the Settings sections it ticks, and the sidebar says so', async () => {
    const mailer = await withRole('roles.mail@example.com', ['settings.mail']);
    await get('/admin/settings/mail', mailer).expect(200);
    assert.equal((await get('/admin/settings/users', mailer)).status, 403);
    assert.equal((await get('/admin/settings/advanced/automation', mailer)).status, 403);
    const home = await get('/admin/settings', mailer);
    assert.equal(home.headers.location, '/admin/settings/mail', 'Settings opens on the first section it may see');
    const page = await get('/admin/settings/mail', mailer);
    assert.doesNotMatch(page.text, /href="\/admin\/settings\/users"/, 'no way into Users is offered');
  });

  test('without "work on tickets" its people are users; with it, technicians', async () => {
    const plain = await withRole('roles.plain@example.com', ['reports.view']);
    assert.equal((await findUserById(plain.user.id))!.role, 'user');
    const tech = await withRole('roles.tech@example.com', ['tickets.work']);
    assert.equal((await findUserById(tech.user.id))!.role, 'agent');
  });

  test('Reports and deleting tickets follow their ticks', async () => {
    // Both in a technician group: Reports is about a group's tickets, and
    // a technician in none is "not found" there whatever their role.
    const noReports = await withRole('roles.noreports@example.com', ['tickets.work']);
    const agent = await signInAs('roles.agent@example.com', 'agent');
    const group = await createGroup({ name: 'Roles desk', description: '', isActive: true }, null);
    await setMembers(group.id, [noReports.user.id, agent.user.id], null);
    assert.equal((await get('/reports', noReports)).status, 404, 'not ticked');
    // A technician without a custom role keeps Reports, as before.
    assert.equal((await get('/reports', agent)).status, 200);
  });
});

describe('a role never grows itself', () => {
  test('the Roles page is an administrator\'s, even for somebody who may open Users', async () => {
    const manager = await withRole('roles.users@example.com', ['settings.users']);
    await get('/admin/settings/users', manager).expect(200);
    assert.equal((await get('/admin/settings/users/roles', manager)).status, 403);
    await get('/admin/settings/users/roles', admin).expect(200);
  });

  test('somebody with Users cannot give a role, or create anything but a user', async () => {
    const manager = await withRole('roles.users2@example.com', ['settings.users']);
    const target = await signInAs('roles.target@example.com', 'user');
    const change = await request(app)
      .post('/admin/settings/users/' + target.user.id + '/role')
      .set('Cookie', manager.cookie)
      .type('form')
      .send({ _csrf: manager.csrfToken, role: 'admin' });
    assert.equal(change.status, 403);
    assert.equal((await findUserById(target.user.id))!.role, 'user');

    const create = await request(app)
      .post('/admin/settings/users')
      .set('Cookie', manager.cookie)
      .type('form')
      .send({ _csrf: manager.csrfToken, email: 'roles.new@example.com', firstName: 'New', lastName: 'Admin', role: 'admin', password: 'A-long-enough-test-passphrase-1' });
    assert.notEqual(create.status, 302);
    assert.equal(await queryOne('SELECT id FROM users WHERE email = ?', ['roles.new@example.com']), undefined);
  });

  test('an administrator gives a custom role, and creates and deletes one from the page', async () => {
    const made = await request(app)
      .post('/admin/settings/users/roles')
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ _csrf: admin.csrfToken, name: 'Desk lead', description: 'Runs the queue', permissions: ['tickets.work', 'tickets.delete', 'reports.view'] });
    assert.equal(made.status, 302);
    const role = await queryOne<{ id: string }>("SELECT id FROM roles WHERE name = 'Desk lead'");
    assert.ok(role);

    const lead = await signInAs('roles.lead@example.com', 'user');
    await request(app)
      .post('/admin/settings/users/' + lead.user.id + '/role')
      .set('Cookie', admin.cookie)
      .type('form')
      .send({ _csrf: admin.csrfToken, role: 'role:' + role.id })
      .expect(302);
    const after = (await findUserById(lead.user.id))!;
    assert.equal(after.role, 'agent');
    assert.equal(after.role_id, role.id);

    // In use: refused. Back to a built-in role, then it goes.
    await request(app).post('/admin/settings/users/roles/' + role.id + '/delete').set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
    assert.ok(await queryOne('SELECT id FROM roles WHERE id = ?', [role.id]));
    await request(app).post('/admin/settings/users/' + lead.user.id + '/role').set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken, role: 'user' }).expect(302);
    assert.equal((await findUserById(lead.user.id))!.role_id, null);
    await request(app).post('/admin/settings/users/roles/' + role.id + '/delete').set('Cookie', admin.cookie).type('form').send({ _csrf: admin.csrfToken });
    assert.equal(await queryOne('SELECT id FROM roles WHERE id = ?', [role.id]), undefined);
  });
});

describe('ticket permissions (part 2)', () => {
  test("without 'see every ticket': their groups' tickets and their own, and nothing else is found", async () => {
    const limited = await withRole('roles.limited@example.com', ['tickets.work', 'tickets.edit', 'tickets.internal']);
    const requester = await signInAs('roles.requester@example.com', 'user');
    const desk = await createGroup({ name: 'Limited desk', description: '', isActive: true }, null);
    const other = await createGroup({ name: 'Other desk', description: '', isActive: true }, null);
    await setMembers(desk.id, [limited.user.id], null);
    const ours = await createTicket({ title: 'Ours', description: 'In the limited desk', priority: 'normal', category: 'other', requesterId: requester.user.id, groupId: desk.id });
    const theirs = await createTicket({ title: 'Theirs', description: 'In the other desk', priority: 'normal', category: 'other', requesterId: requester.user.id, groupId: other.id });

    await get('/tickets/' + ours.id, limited).expect(200);
    assert.equal((await get('/tickets/' + theirs.id, limited)).status, 404);
    const list = await get('/tickets?scope=all&status=any', limited);
    assert.match(list.text, /Ours/);
    assert.doesNotMatch(list.text, /Theirs/);
    // A built-in agent still sees everything.
    const agent = await signInAs('roles.agent2@example.com', 'agent');
    await get('/tickets/' + theirs.id, agent).expect(200);
  });

  test('without "change tickets" the details read only and a change is refused', async () => {
    const viewer = await withRole('roles.viewer@example.com', ['tickets.work', 'tickets.view_all']);
    const requester = await signInAs('roles.requester2@example.com', 'user');
    const ticket = await createTicket({ title: 'Look only', description: 'Not to be changed', priority: 'normal', category: 'other', requesterId: requester.user.id });
    const page = await get('/tickets/' + ticket.id, viewer).expect(200);
    assert.doesNotMatch(page.text, /id="properties"/);
    const change = await request(app).post('/tickets/' + ticket.id + '/update').set('Cookie', viewer.cookie).type('form').send({ _csrf: viewer.csrfToken, status: 'closed' });
    assert.equal(change.status, 403);
  });

  test('without "internal notes" they are not shown, and one cannot be written', async () => {
    const outside = await withRole('roles.nonotes@example.com', ['tickets.work', 'tickets.view_all', 'tickets.edit']);
    const requester = await signInAs('roles.requester3@example.com', 'user');
    const ticket = await createTicket({ title: 'Notes', description: 'Has an internal note', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await addComment({ ticketId: ticket.id, authorId: admin.user.id, body: 'Secret internal remark', isInternal: true });
    const page = await get('/tickets/' + ticket.id, outside).expect(200);
    assert.doesNotMatch(page.text, /Secret internal remark/);
    assert.doesNotMatch(page.text, /id="reply-internal"/);
    await request(app).post('/tickets/' + ticket.id + '/comments').set('Cookie', outside.cookie).type('form')
      .send({ _csrf: outside.csrfToken, internal: 'on', body: 'Trying to hide this' }).expect(302);
    const written = await queryOne<{ is_internal: boolean }>("SELECT is_internal FROM ticket_comments WHERE body = 'Trying to hide this'");
    assert.equal(written?.is_internal, false, 'posted as a public reply, not a note');
  });
});
