import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';

/** The sidebar folds to icons and back (middleware/theme.ts, 21 Oct 2026). */

let app: Express;
let agent: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  agent = await signInAs('fold.agent@example.com', 'agent');
});

describe('folding the sidebar', () => {
  test('full by default, with the button to fold it', async () => {
    const page = await request(app).get('/tickets').set('Cookie', agent.cookie).expect(200);
    assert.match(page.text, /<div class="shell">/);
    assert.match(page.text, /name="sidebar" value="compact"/);
  });

  test('folded, it remembers, shows names as tooltips, and unfolds again', async () => {
    const fold = await request(app)
      .post('/sidebar')
      .set('Cookie', agent.cookie)
      .type('form')
      .send({ _csrf: agent.csrfToken, sidebar: 'compact', returnTo: '/tickets?status=active' })
      .expect(303);
    assert.equal(fold.headers.location, '/tickets?status=active', 'back where it was, filters and all');
    const setCookie = fold.headers['set-cookie'] as unknown as string[];
    const cookie = setCookie.find((c) => c.startsWith('helpdesk_fold=')) ?? '';
    assert.match(cookie, /helpdesk_fold=compact/);
    // sidebar.js writes it too, so a script must be able to.
    assert.doesNotMatch(cookie, /HttpOnly/i);

    const page = await request(app).get('/tickets').set('Cookie', agent.cookie + '; helpdesk_fold=compact').expect(200);
    assert.match(page.text, /<div class="shell shell--compact">/);
    assert.match(page.text, /class="side-link" href="\/tickets"[^>]*title="Tickets"/);
    assert.match(page.text, /name="sidebar" value="full"/);

    const unfold = await request(app)
      .post('/sidebar')
      .set('Cookie', agent.cookie + '; helpdesk_fold=compact')
      .type('form')
      .send({ _csrf: agent.csrfToken, sidebar: 'full', returnTo: '//elsewhere.example' })
      .expect(303);
    assert.equal(unfold.headers.location, '/', 'never off the site');
    assert.match(String(unfold.headers['set-cookie']), /helpdesk_fold=;/);
  });

  test('it folds at once with sidebar.js; both buttons are drawn for it', async () => {
    const page = await request(app).get('/tickets').set('Cookie', agent.cookie).expect(200);
    assert.match(page.text, /<form method="post" action="\/sidebar" class="sidebar__fold" data-sidebar-fold>/);
    assert.match(page.text, /value="full" class="icon-button sidebar__unfold"/);
    assert.match(page.text, /value="compact" class="icon-button sidebar__fold-in"/);
    assert.match(page.text, /<script src="\/assets\/js\/sidebar\.js\?v=[^"]*" defer><\/script>/);
    assert.match(String(page.headers['content-security-policy']), /script-src 'self'/);
    assert.doesNotMatch(String(page.headers['content-security-policy']), /unsafe-inline/);
  });

  test('the old httpOnly cookie is moved to the new one, once', async () => {
    const page = await request(app).get('/tickets').set('Cookie', agent.cookie + '; helpdesk_sidebar=compact').expect(200);
    assert.match(page.text, /<div class="shell shell--compact">/);
    const set = String(page.headers['set-cookie']);
    assert.match(set, /helpdesk_fold=compact/);
    assert.match(set, /helpdesk_sidebar=;/);
  });
});
