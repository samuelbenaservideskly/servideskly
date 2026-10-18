import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import { createTicket } from '../src/services/tickets.js';
import { settings, updateSettings } from '../src/settings/index.js';

/** The search bar above every page: tickets, people and references. */

let app: Express;
let admin: TestSession;
let agentUser: TestSession;
let requester: TestSession;
let stranger: TestSession;
let mine: { id: string; reference: string };
let theirs: { id: string; reference: string };

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('search.admin@example.com', 'admin');
  agentUser = await signInAs('search.tech@example.com', 'agent');
  requester = await signInAs('search.user@example.com', 'user');
  stranger = await signInAs('search.other@example.com', 'user');

  mine = await createTicket({
    title: 'Keyboard sticks on the letter K',
    description: 'It needs a firm press every time.',
    priority: 'normal',
    category: 'other',
    requesterId: requester.user.id,
  });
  theirs = await createTicket({
    title: 'Keyboard for somebody else',
    description: 'Not the first requester.',
    priority: 'normal',
    category: 'other',
    requesterId: stranger.user.id,
  });
});

describe('search', () => {
  test('a reference opens its ticket', async () => {
    const jump = await as(agentUser).get('/search?q=' + mine.reference).expect(302);
    assert.equal(jump.headers.location, '/tickets/' + mine.id);

    // Lower case, and a stray space, are the same reference.
    const casual = await as(agentUser)
      .get('/search?q=' + encodeURIComponent(' ' + mine.reference.toLowerCase() + ' '))
      .expect(302);
    assert.equal(casual.headers.location, '/tickets/' + mine.id);
  });

  test('a reference somebody may not open is not jumped to, and finds nothing', async () => {
    // The requester may read their own ticket...
    const own = await as(requester).get('/search?q=' + mine.reference).expect(302);
    assert.equal(own.headers.location, '/tickets/' + mine.id);

    // ...and somebody else's reference is simply not found: the page must
    // not say the ticket exists by redirecting to a 404.
    const page = await as(requester).get('/search?q=' + theirs.reference).expect(200);
    assert.doesNotMatch(page.text, new RegExp(theirs.id));
  });

  test('tickets are searched with the reader own permissions', async () => {
    const forStaff = await as(agentUser).get('/search?q=Keyboard').expect(200);
    assert.match(forStaff.text, new RegExp(mine.reference));
    assert.match(forStaff.text, new RegExp(theirs.reference));

    const forRequester = await as(requester).get('/search?q=Keyboard').expect(200);
    assert.match(forRequester.text, new RegExp(mine.reference));
    assert.doesNotMatch(forRequester.text, new RegExp(theirs.reference), 'not somebody else tickets');
  });

  test('people are searched only for whoever the directory is open to', async () => {
    await updateSettings(
      { people: { ...settings().people, directory: { technicians: false, users: false, ownCompanyOnly: false } } },
      null,
    );
    const closed = await as(agentUser).get('/search?q=search.user').expect(200);
    assert.doesNotMatch(closed.text, /search\.user@example\.com/);

    // An administrator always may.
    const forAdmin = await as(admin).get('/search?q=search.user').expect(200);
    assert.match(forAdmin.text, /search\.user@example\.com/);

    await updateSettings(
      { people: { ...settings().people, directory: { technicians: true, users: false, ownCompanyOnly: false } } },
      null,
    );
    const open = await as(agentUser).get('/search?q=search.user').expect(200);
    assert.match(open.text, /search\.user@example\.com/);
    assert.match(open.text, /href="\/people\//);
  });

  test('the bar posts here, and an empty search says so rather than listing everything', async () => {
    const page = await as(agentUser).get('/tickets').expect(200);
    assert.match(page.text, /class="searchbar" method="get" action="\/search"/);

    const empty = await as(agentUser).get('/search').expect(200);
    assert.match(empty.text, /Type what you are looking for/);
    assert.doesNotMatch(empty.text, new RegExp(mine.reference));
  });
});
