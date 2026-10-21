import './env.js';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { query, queryOne } from '../src/db/index.js';
import { buildTimeline } from '../src/services/ticket-timeline.js';
import { queuedMail } from './support/outbox.js';

/**
 * The ticket page's redesign (21 Oct 2026): one conversation with each file
 * beside its message, and a reply box that takes files - so "see the
 * attached document" arrives with the document.
 */

let app: Express;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

async function signIn(email: string, role: 'user' | 'agent' | 'admin') {
  const session = await signInAs(email, role);
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return { agent, user: session.user };
}

async function raiseTicket(agent: request.Agent, title: string): Promise<string> {
  const form = await agent.get('/tickets/new').expect(200);
  const response = await agent
    .post('/tickets')
    .type('form')
    .send({
      _csrf: csrfFrom(form.text),
      title,
      description: 'A description long enough to satisfy the minimum length requirement.',
      priority: 'normal',
      category: 'other',
    })
    .expect(302);
  return (response.headers['location'] as string).replace('/tickets/', '');
}

const TEXT = (s: string) => Buffer.from(s);

describe('the timeline', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 9, 0, s)).toISOString();
  const ticket = { created_at: at(0), requester_id: 'req', raised_by: null };

  test('puts each file with the message it came with, and the rest on their own', () => {
    const comments = [
      { id: 'c1', author_id: 'tech', is_internal: 0, created_at: at(100) },
      { id: 'c2', author_id: 'tech', is_internal: 1, created_at: at(200) },
    ];
    const files = [
      { id: 'f0', uploaded_by: 'req', is_internal: 0, created_at: at(1) }, // raised with the request
      { id: 'f1', uploaded_by: 'tech', is_internal: 0, created_at: at(100) }, // the reply's
      { id: 'f2', uploaded_by: 'tech', is_internal: 1, created_at: at(201) }, // the note's
      { id: 'f3', uploaded_by: 'req', is_internal: 0, created_at: at(500) }, // on its own
      { id: 'f4', uploaded_by: 'req', is_internal: 0, created_at: at(505) }, // ...with the one before
    ];
    const timeline = buildTimeline(ticket, comments, files);
    assert.deepEqual(
      timeline.map((e) => [e.kind, e.files.map((f) => f.id)]),
      [
        ['request', ['f0']],
        ['comment', ['f1']],
        ['comment', ['f2']],
        ['files', ['f3', 'f4']],
      ],
    );
  });

  test('never puts a public file with an internal note, or the other way round', () => {
    const comments = [{ id: 'c1', author_id: 'tech', is_internal: 1, created_at: at(100) }];
    const files = [{ id: 'f1', uploaded_by: 'tech', is_internal: 0, created_at: at(100) }];
    const timeline = buildTimeline(ticket, comments, files);
    assert.equal(timeline[1]!.kind, 'comment');
    assert.equal(timeline[1]!.files.length, 0);
    assert.equal(timeline[2]!.kind, 'files');
  });
});

describe('a reply with files', () => {
  test('a technician\'s reply carries its files, and they are emailed with it', async () => {
    const requester = await signIn('reply.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Printer needs a driver');
    const tech = await signIn('reply.tech@example.com', 'agent');
    const page = await tech.agent.get('/tickets/' + ticketId).expect(200);

    await tech.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('_csrf', csrfFrom(page.text))
      .field('internal', '')
      .field('body', 'Here is the driver - install it and restart.')
      .attach('files', TEXT('driver notes'), { filename: 'driver.txt', contentType: 'text/plain' })
      .expect(302)
      .expect('Location', '/tickets/' + ticketId + '#reply');

    const files = await query<{ filename: string; is_internal: boolean; emailed_at: string | null }>(
      'SELECT filename, is_internal, emailed_at FROM ticket_attachments WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(files.length, 1);
    assert.equal(files[0]!.is_internal, false);
    assert.ok(files[0]!.emailed_at, 'sent to the requester with the reply');

    const shown = await tech.agent.get('/tickets/' + ticketId).expect(200);
    const entry = /<article class="tk-entry[^"]*tk-entry--staff[^"]*">[\s\S]*?<\/article>/.exec(shown.text);
    assert.ok(entry, 'the reply is in the conversation');
    assert.match(entry[0], /Here is the driver/);
    assert.match(entry[0], /driver\.txt/, 'with its file beside it');
  });

  test('unticked "Email the requester": on the ticket for the requester to read, and no mail', async () => {
    const requester = await signIn('quiet.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Shared drive slow');
    const tech = await signIn('quiet.tech@example.com', 'agent');
    const page = await tech.agent.get('/tickets/' + ticketId).expect(200);
    assert.match(page.text, /name="notify" value="on" checked/, 'ticked unless somebody unticks it');
    const before = (await queuedMail((m) => m.ticket_id === ticketId)).length;

    await tech.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('_csrf', csrfFrom(page.text))
      .field('internal', '')
      .field('notifyChoice', '1')
      .field('body', 'Measurements from this morning, for the record.')
      .attach('files', TEXT('latency figures'), { filename: 'latency.txt', contentType: 'text/plain' })
      .expect(302);

    const file = await queryOne<{ is_internal: boolean; emailed_at: string | null }>(
      'SELECT is_internal, emailed_at FROM ticket_attachments WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(file?.is_internal, false, 'the requester may see it');
    assert.equal(file?.emailed_at, null, 'but it was not sent');
    assert.equal((await queuedMail((m) => m.ticket_id === ticketId)).length, before, 'no mail queued');

    const theirs = await requester.agent.get('/tickets/' + ticketId).expect(200);
    assert.match(theirs.text, /Measurements from this morning/);
    assert.match(theirs.text, /latency\.txt/);
  });

  test('a form without the box still emails, as replies always did', async () => {
    const requester = await signIn('legacy.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Old form');
    const tech = await signIn('legacy.tech@example.com', 'agent');
    const page = await tech.agent.get('/tickets/' + ticketId).expect(200);
    await tech.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('_csrf', csrfFrom(page.text))
      .field('body', 'With a file, from a form that has no checkbox.')
      .attach('files', TEXT('x'), { filename: 'x.txt', contentType: 'text/plain' })
      .expect(302);
    const file = await queryOne<{ emailed_at: string | null }>('SELECT emailed_at FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.ok(file?.emailed_at);
  });

  test('an internal note\'s files are internal, and nobody is emailed', async () => {
    const requester = await signIn('note.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'VPN drops');
    const tech = await signIn('note.tech@example.com', 'agent');
    const page = await tech.agent.get('/tickets/' + ticketId).expect(200);

    await tech.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('_csrf', csrfFrom(page.text))
      .field('internal', 'on')
      .field('body', 'Firewall log attached.')
      .attach('files', TEXT('log line'), { filename: 'firewall.log', contentType: 'text/plain' })
      .expect(302);

    const file = await queryOne<{ is_internal: boolean; emailed_at: string | null }>(
      'SELECT is_internal, emailed_at FROM ticket_attachments WHERE ticket_id = ?',
      [ticketId],
    );
    assert.equal(file?.is_internal, true);
    assert.equal(file?.emailed_at, null);

    // ...and the requester sees neither the note nor the file.
    const theirs = await requester.agent.get('/tickets/' + ticketId).expect(200);
    assert.doesNotMatch(theirs.text, /Firewall log attached/);
    assert.doesNotMatch(theirs.text, /firewall\.log/);
  });

  test('a file that is not what it says refuses the whole reply, and the words are kept', async () => {
    const requester = await signIn('bad.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Screen flickers');
    const tech = await signIn('bad.tech@example.com', 'agent');
    const page = await tech.agent.get('/tickets/' + ticketId).expect(200);

    await tech.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('_csrf', csrfFrom(page.text))
      .field('internal', '')
      .field('body', 'A long reply that must not be lost.')
      .attach('files', TEXT('fine'), { filename: 'fine.txt', contentType: 'text/plain' })
      .attach('files', TEXT('<script>alert(1)</script>'), { filename: 'shot.png', contentType: 'image/png' })
      .expect(302);

    const stored = await queryOne<{ c: number }>('SELECT count(*) AS c FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.equal(stored?.c, 0, 'not even the good file: half a reply is worse than none');
    const comments = await queryOne<{ c: number }>('SELECT count(*) AS c FROM ticket_comments WHERE ticket_id = ?', [ticketId]);
    assert.equal(comments?.c, 0);

    const back = await tech.agent.get('/tickets/' + ticketId).expect(200);
    const form = /<form[^>]*id="reply"[\s\S]*?<\/form>/.exec(back.text);
    assert.ok(form);
    assert.match(form[0], /shot\.png: The contents of that file do not match/);
    assert.match(form[0], /A long reply that must not be lost\./, 'what was typed is back in the box');

    // ...once: the next visit starts empty.
    const again = await tech.agent.get('/tickets/' + ticketId).expect(200);
    assert.doesNotMatch(again.text, /A long reply that must not be lost\./);
  });

  test('a requester may add files to their own ticket, but never an internal note', async () => {
    const requester = await signIn('own.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Keyboard sticky');
    const page = await requester.agent.get('/tickets/' + ticketId).expect(200);
    assert.doesNotMatch(page.text, /Internal note/, 'no tab for it');

    await requester.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('_csrf', csrfFrom(page.text))
      .field('internal', 'on')
      .field('body', 'Photo of the keys.')
      .attach('files', TEXT('pretend photo notes'), { filename: 'keys.txt', contentType: 'text/plain' })
      .expect(302);

    const comment = await queryOne<{ is_internal: boolean }>('SELECT is_internal FROM ticket_comments WHERE ticket_id = ?', [ticketId]);
    assert.equal(comment?.is_internal, false, 'posting "internal" does not make it one');
  });

  test('a post with neither words nor files is refused beside the box', async () => {
    const requester = await signIn('empty.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Mouse wheel');
    const page = await requester.agent.get('/tickets/' + ticketId).expect(200);
    await requester.agent
      .post('/tickets/' + ticketId + '/comments')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), body: '   ' })
      .expect(302);
    const back = await requester.agent.get('/tickets/' + ticketId).expect(200);
    const form = /<form[^>]*id="reply"[\s\S]*?<\/form>/.exec(back.text);
    assert.match(form![0], /Write something before posting\./);
  });

  test('a reply without the form\'s token is refused, with or without files', async () => {
    const requester = await signIn('csrf.requester@example.com', 'user');
    const ticketId = await raiseTicket(requester.agent, 'Monitor cable');
    await requester.agent.post('/tickets/' + ticketId + '/comments').type('form').send({ body: 'no token' }).expect(403);
    await requester.agent
      .post('/tickets/' + ticketId + '/comments')
      .field('body', 'no token either')
      .attach('files', TEXT('x'), { filename: 'x.txt', contentType: 'text/plain' })
      .expect(403);
    const comments = await queryOne<{ c: number }>('SELECT count(*) AS c FROM ticket_comments WHERE ticket_id = ?', [ticketId]);
    assert.equal(comments?.c, 0);
  });
});
