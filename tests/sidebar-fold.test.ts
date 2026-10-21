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
    const cookie = String(fold.headers['set-cookie']).match(/helpdesk_sidebar=compact/);
    assert.ok(cookie);

    const page = await request(app).get('/tickets').set('Cookie', agent.cookie + '; helpdesk_sidebar=compact').expect(200);
    assert.match(page.text, /<div class="shell shell--compact">/);
    assert.match(page.text, /class="side-link" href="\/tickets"[^>]*title="Tickets"/);
    assert.match(page.text, /name="sidebar" value="full"/);

    const unfold = await request(app)
      .post('/sidebar')
      .set('Cookie', agent.cookie + '; helpdesk_sidebar=compact')
      .type('form')
      .send({ _csrf: agent.csrfToken, sidebar: 'full', returnTo: '//elsewhere.example' })
      .expect(303);
    assert.equal(unfold.headers.location, '/', 'never off the site');
    assert.match(String(unfold.headers['set-cookie']), /helpdesk_sidebar=;/);
  });
});
