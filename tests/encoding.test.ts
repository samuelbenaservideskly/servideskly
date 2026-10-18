import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { addComment, listTickets } from '../src/services/tickets.js';
import { findUserById } from '../src/services/users.js';

/**
 * Text that is not ASCII, end to end.
 *
 * A ticket raised in Czech that arrives as `Tisk?rna` is the kind of fault
 * that looks like one bug and is usually three: the form body, the database
 * column and the mail header each have to be right on their own.
 */

let app: Express;
let user: TestSession;
let agent: request.Agent;

const CZECH = 'Tiskárna nefunguje';
const PANGRAM = 'Příliš žluťoučký kůň úpěl ďábelské ódy.';

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  user = await signInAs('encoding.user@example.com', 'user');
  agent = request.agent(app);
  agent.set('Cookie', user.cookie);
});

async function raised(title: string) {
  const viewer = await findUserById(user.user.id);
  assert.ok(viewer);
  const page = await listTickets(viewer, {
    scope: 'mine',
    status: 'any',
    page: 1,
    perPage: 50,
  });
  return page.items.find((ticket) => ticket.title === title);
}

describe('non-ASCII text survives the whole round trip', () => {
  test('a multipart form keeps its accents', async () => {
    // The raise-a-ticket form is multipart, because a file can come with it.
    const form = await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', CZECH)
      .field('description', PANGRAM)
      .expect(302);

    const ticket = await raised(CZECH);
    assert.ok(ticket, 'the ticket should exist under its real title');
    assert.equal(ticket.title, CZECH);
    assert.match(ticket.description, /Příliš žluťoučký kůň/);
    assert.doesNotMatch(ticket.title, /\uFFFD/, 'no replacement characters');
  });

  test('a urlencoded form keeps them too', async () => {
    // Comments post as ordinary form data rather than multipart.
    const ticket = await raised(CZECH);
    assert.ok(ticket);

    const page = await agent.get('/tickets/' + ticket.id).expect(200);
    await agent
      .post('/tickets/' + ticket.id + '/comments')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), body: PANGRAM })
      .expect(302);

    const after = await agent.get('/tickets/' + ticket.id).expect(200);
    assert.match(after.text, /Příliš žluťoučký kůň/);
    assert.doesNotMatch(after.text, /\uFFFD/);
  });

  test('the page is served as UTF-8, so a browser reads it back correctly', async () => {
    const ticket = await raised(CZECH);
    assert.ok(ticket);
    const page = await agent.get('/tickets/' + ticket.id).expect(200);

    // Without this the browser guesses, and guesses latin-1 often enough.
    assert.match(String(page.headers['content-type']), /charset=utf-8/i);
    assert.match(page.text, new RegExp(CZECH));
  });

  test('a comment written straight to the service is unchanged', async () => {
    // Proves the database column and driver are not the problem, separately
    // from anything HTTP does.
    const ticket = await raised(CZECH);
    assert.ok(ticket);

    await addComment({
      ticketId: ticket.id,
      authorId: user.user.id,
      body: PANGRAM,
      isInternal: false,
    });

    const page = await agent.get('/tickets/' + ticket.id).expect(200);
    assert.match(page.text, /ďábelské ódy/);
  });
});
