import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { settings } from '../src/settings/index.js';
import { addComment, createTicket } from '../src/services/tickets.js';
import { createGroup, setGroupManagers } from '../src/services/groups.js';

// Tickets - Other settings - Deleting comments (22 Oct 2026).

let app: Express;
let admin: TestSession;
let agent: TestSession;
let manager: TestSession;
let requester: TestSession;
let groupId: string;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}
async function ticketWithComment(body: string, inGroup = true): Promise<{ ticketId: string; commentId: string }> {
  const t = await createTicket({
    title: 'Comment deletion: ' + body,
    description: 'Raised by the comment deletion tests.',
    priority: 'normal',
    category: 'other',
    requesterId: requester.user.id,
    groupId: inGroup ? groupId : null,
  });
  const commentId = await addComment({ ticketId: t.id, authorId: requester.user.id, body, isInternal: false });
  return { ticketId: t.id, commentId };
}
const commentCount = async (ticketId: string) =>
  (await query<{ id: string }>('SELECT id FROM ticket_comments WHERE ticket_id = ?', [ticketId])).length;
const del = (s: TestSession, x: { ticketId: string; commentId: string }) =>
  post(s, '/tickets/' + x.ticketId + '/comments/' + x.commentId + '/delete');

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('cdel.admin@example.com', 'admin');
  agent = await signInAs('cdel.agent@example.com', 'agent');
  manager = await signInAs('cdel.manager@example.com', 'agent');
  requester = await signInAs('cdel.requester@example.com', 'user');
  groupId = (await createGroup({ name: 'Comment Deleters', description: '', isActive: true }, null)).id;
  await setGroupManagers(groupId, [manager.user.id], null);
});

describe('Deleting comments', () => {
  test('the panel is on Tickets - Other settings, both boxes off by default', async () => {
    assert.equal(settings().tickets.techniciansDeleteComments, false);
    assert.equal(settings().tickets.managersOnlyDeleteComments, false);
    const page = await as(admin).get('/admin/settings/templates/other').expect(200);
    assert.match(page.text, /id="comment-deletion"/);
    assert.match(page.text, /name="techniciansDeleteComments"/);
    assert.match(page.text, /name="managersOnlyDeleteComments"/);
  });

  test('off: an administrator may, a technician and a requester may not', async () => {
    const x = await ticketWithComment('Delete me as admin');
    const page = await as(agent).get('/tickets/' + x.ticketId).expect(200);
    assert.doesNotMatch(page.text, /delete-comment-/);
    await del(agent, x).expect(403);
    await del(requester, x).expect(403);
    assert.equal(await commentCount(x.ticketId), 1);

    const adminPage = await as(admin).get('/tickets/' + x.ticketId).expect(200);
    assert.match(adminPage.text, new RegExp('id="delete-comment-' + x.commentId + '"'));
    await del(admin, x).expect(302);
    assert.equal(await commentCount(x.ticketId), 0);
    const events = await query<{ kind: string }>("SELECT kind FROM ticket_events WHERE ticket_id = ? AND kind = 'comment_deleted'", [x.ticketId]);
    assert.equal(events.length, 1);
    const audit = await query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'ticket.comment.deleted' AND target_id = ?", [x.ticketId]);
    assert.equal(audit.length, 1);
  });

  test('technicians allowed: any technician may', async () => {
    await post(admin, '/admin/settings/templates/other/comment-deletion', { techniciansDeleteComments: 'on' }).expect(302);
    assert.equal(settings().tickets.techniciansDeleteComments, true);
    const x = await ticketWithComment('Delete me as technician');
    await del(agent, x).expect(302);
    assert.equal(await commentCount(x.ticketId), 0);
    await del(requester, await ticketWithComment('Not a requester')).expect(403);
  });

  test('only group managers: the manager of the ticket\'s group may, another technician not', async () => {
    await post(admin, '/admin/settings/templates/other/comment-deletion', {
      techniciansDeleteComments: 'on',
      managersOnlyDeleteComments: 'on',
    }).expect(302);
    assert.equal(settings().tickets.managersOnlyDeleteComments, true);
    const x = await ticketWithComment('Delete me as manager');
    await del(agent, x).expect(403);
    await del(manager, x).expect(302);
    assert.equal(await commentCount(x.ticketId), 0);
    // A ticket with no group has no manager: administrators only.
    const loose = await ticketWithComment('No group', false);
    await del(manager, loose).expect(403);
    await del(admin, loose).expect(302);
  });

  test('switching technicians off clears both', async () => {
    await post(admin, '/admin/settings/templates/other/comment-deletion', {}).expect(302);
    assert.equal(settings().tickets.techniciansDeleteComments, false);
    assert.equal(settings().tickets.managersOnlyDeleteComments, false);
  });
});
