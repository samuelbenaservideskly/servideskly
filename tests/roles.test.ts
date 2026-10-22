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
import { createApiKey } from '../src/services/api-keys.js';

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

describe('the security review of 21 Oct 2026', () => {
  test('somebody with Users changes nothing on an administrator: password, address, authenticator', async () => {
    const manager = await withRole('review.users@example.com', ['settings.users']);
    const boss = await signInAs('review.boss@example.com', 'admin');
    const post = (path: string, body: Record<string, string>) =>
      request(app).post('/admin/settings/users/' + boss.user.id + path).set('Cookie', manager.cookie).type('form').send({ _csrf: manager.csrfToken, ...body });
    assert.equal((await post('/password', { password: 'Taken-over-passphrase-1!' })).status, 403);
    assert.equal((await post('/email', { email: 'review.mine@example.com' })).status, 403);
    assert.equal((await post('/authenticator/reset', {})).status, 403);
    assert.equal((await post('/status', { status: 'disabled' })).status, 403);
    assert.equal((await findUserById(boss.user.id))!.email, 'review.boss@example.com');
    // A user's page still works for them, and an administrator's page can be read.
    await get('/admin/settings/users/' + boss.user.id, manager).expect(200);
  });

  test('how everybody signs in stays an administrator\'s, and the path is judged whatever its case', async () => {
    const manager = await withRole('review.users2@example.com', ['settings.users']);
    for (const path of ['/users/break-glass', '/users/local-signin', '/users/sign-in-codes', '/users/other/access', '/users/ROLES', '/Users/Roles']) {
      assert.equal(permissionForSettingsPath('/settings' + path), 'admin', path);
    }
    assert.equal((await get('/admin/settings/users/ROLES', manager)).status, 403);
    assert.equal((await get('/admin/settings/users/break-glass', manager)).status, 403);
  });

  test('an API key does no more than the role of the person who made it', async () => {
    const limited = await withRole('review.api@example.com', ['tickets.work', 'api.manage']);
    const requester = await signInAs('review.api.requester@example.com', 'user');
    const desk = await createGroup({ name: 'API desk', description: '', isActive: true }, null);
    const other = await createGroup({ name: 'API other desk', description: '', isActive: true }, null);
    await setMembers(desk.id, [limited.user.id], null);
    const ours = await createTicket({ title: 'API ours', description: 'In the desk', priority: 'normal', category: 'other', requesterId: requester.user.id, groupId: desk.id });
    const theirs = await createTicket({ title: 'API theirs', description: 'Elsewhere', priority: 'normal', category: 'other', requesterId: requester.user.id, groupId: other.id });
    await addComment({ ticketId: ours.id, authorId: admin.user.id, body: 'API secret note', isInternal: true });
    const { secret } = await createApiKey('Limited author', ['read_tickets', 'read_internal', 'set_status', 'add_comment'], limited.user.id);
    const api = (method: 'get' | 'patch' | 'post', path: string) => request(app)[method]('/api/v1' + path).set('Authorization', 'Bearer ' + secret);

    await api('get', '/tickets/' + ours.reference).expect(200);
    assert.equal((await api('get', '/tickets/' + theirs.reference)).status, 404);
    const list = await api('get', '/tickets?limit=100').expect(200);
    const refs = (list.body.items as { reference: string }[]).map((i) => i.reference);
    assert.ok(refs.includes(ours.reference) && !refs.includes(theirs.reference));
    const comments = await api('get', '/tickets/' + ours.reference + '/comments').expect(200);
    assert.equal(comments.body.includesInternal, false);
    assert.doesNotMatch(JSON.stringify(comments.body), /API secret note/);
    assert.equal((await api('patch', '/tickets/' + ours.reference).send({ status: 'closed' })).status, 403);
    assert.equal((await api('post', '/tickets/' + ours.reference + '/comments').send({ body: 'hidden', internal: true })).status, 403);
  });
});

describe('permission levels: read only and read and write (22 Oct 2026)', () => {
  test('a Settings section read only: the page opens with its controls disabled, and nothing can be saved', async () => {
    const reader = await withRole('levels.mail@example.com', ['settings.mail:read']);
    const page = await get('/admin/settings/mail', reader).expect(200);
    assert.match(page.text, /<fieldset class="settings-readonly" disabled>/);
    assert.match(page.text, /Read only/);
    const save = await request(app).post('/admin/settings/mail/notifications').set('Cookie', reader.cookie).type('form')
      .send({ _csrf: reader.csrfToken, name: 'Nope' });
    assert.equal(save.status, 403);
    // Read and write: the same page without the fieldset.
    const writer = await withRole('levels.mail.rw@example.com', ['settings.mail']);
    const full = await get('/admin/settings/mail', writer).expect(200);
    assert.doesNotMatch(full.text, /class="settings-readonly" disabled/);
  });

  test('assets read only: the list and pages open, without the ways to change them', async () => {
    const reader = await withRole('levels.assets@example.com', ['tickets.work', 'assets.manage:read']);
    const list = await get('/inventory', reader).expect(200);
    assert.doesNotMatch(list.text, /href="#new-asset"/);
    const add = await request(app).post('/inventory').set('Cookie', reader.cookie).type('form').send({ _csrf: reader.csrfToken, v_Model: 'X' });
    assert.equal(add.status, 403);
    const nobody = await withRole('levels.noassets@example.com', ['tickets.work']);
    assert.equal((await get('/inventory', nobody)).status, 404);
  });

  test('internal notes read only: they are shown, but a note cannot be written', async () => {
    const reader = await withRole('levels.notes@example.com', ['tickets.work', 'tickets.view_all', 'tickets.edit', 'tickets.internal:read']);
    const requester = await signInAs('levels.requester@example.com', 'user');
    const ticket = await createTicket({ title: 'Notes to read', description: 'Has an internal note', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await addComment({ ticketId: ticket.id, authorId: admin.user.id, body: 'Readable internal remark', isInternal: true });
    const page = await get('/tickets/' + ticket.id, reader).expect(200);
    assert.match(page.text, /Readable internal remark/);
    await request(app).post('/tickets/' + ticket.id + '/comments').set('Cookie', reader.cookie).type('form')
      .send({ _csrf: reader.csrfToken, internal: 'on', body: 'Trying to note this' }).expect(302);
    const written = await queryOne<{ is_internal: boolean }>("SELECT is_internal FROM ticket_comments WHERE body = 'Trying to note this'");
    assert.equal(written?.is_internal, false, 'posted as a public reply');
  });

  test('the role form stores a level, and read and write wins over read only', async () => {
    const res = await request(app).post('/admin/settings/users/roles').set('Cookie', admin.cookie).type('form')
      .send({ _csrf: admin.csrfToken, name: 'Levels role', description: '', 'level_settings.mail': 'read', 'level_assets.manage': 'write', permissions: ['reports.view', 'assets.manage:read'] });
    assert.equal(res.status, 302);
    const row = await queryOne<{ permissions: string[] | string }>("SELECT permissions FROM roles WHERE name = 'Levels role'");
    const perms = typeof row!.permissions === 'string' ? (JSON.parse(row!.permissions) as string[]) : row!.permissions;
    assert.ok(perms.includes('settings.mail:read'));
    assert.ok(perms.includes('assets.manage') && !perms.includes('assets.manage:read'));
    assert.ok(perms.includes('reports.view'));
    const page = await get('/admin/settings/users/roles', admin).expect(200);
    assert.match(page.text, /Mail \(read only\)/);
    assert.match(page.text, /name="level_settings.mail" value="read"/);
  });
});
