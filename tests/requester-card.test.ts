import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { createTicket } from '../src/services/tickets.js';

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;
let other: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
const raise = (title: string, requesterId: string) =>
  createTicket({ title, description: 'Raised by the requester card tests.', priority: 'normal', category: 'other', requesterId });

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('card.admin@example.com', 'admin');
  agent = await signInAs('card.agent@example.com', 'agent');
  requester = await signInAs('card.requester@example.com', 'user');
  other = await signInAs('card.other@example.com', 'user');
});

describe('The requester on a ticket', () => {
  test('staff can open a card with how to reach them and their other tickets', async () => {
    const first = await raise('Printer jammed', requester.user.id);
    const second = await raise('Monitor flickers', requester.user.id);
    await raise('Somebody else', other.user.id);

    const page = await as(agent).get('/tickets/' + second.id).expect(200);
    assert.match(page.text, /<a class="person-link" href="#requester-card">/);
    assert.match(page.text, /id="requester-card"/);
    assert.match(page.text, /mailto:card\.requester@example\.com/);
    assert.match(page.text, new RegExp(first.reference), 'their other ticket is listed');
    assert.doesNotMatch(page.text, /Somebody else/);
    assert.match(page.text, /requester=[0-9a-f-]{36}/);
    // The card offers the person's page to every technician now; the
    // account under Settings is reached from there, by an administrator.
    assert.match(page.text, /Open their page/);
    assert.doesNotMatch(page.text, /Open in Users/, 'the account page is not offered from here');

    const asAdmin = await as(admin).get('/tickets/' + second.id).expect(200);
    assert.match(asAdmin.text, /Open their page/);
  });

  test('the requester themselves sees plain text', async () => {
    const t = await raise('My own', requester.user.id);
    const page = await as(requester).get('/tickets/' + t.id).expect(200);
    assert.doesNotMatch(page.text, /person-link|requester-card/);
  });

  test('the queue filters by requester for staff, and says whose', async () => {
    const list = await as(agent).get('/tickets?scope=all&status=any&requester=' + requester.user.id).expect(200);
    assert.match(list.text, /Tickets from <strong>card\.requester@example\.com<\/strong>/);
    assert.match(list.text, /Printer jammed/);
    assert.doesNotMatch(list.text, /Somebody else/);

    // A requester cannot use it to see anybody else's.
    const mine = await as(other).get('/tickets?requester=' + requester.user.id).expect(200);
    assert.doesNotMatch(mine.text, /Printer jammed/);
    assert.match(mine.text, /Somebody else/);
  });
});
