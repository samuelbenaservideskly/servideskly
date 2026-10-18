import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { themeStylesheet } from '../src/services/branding.js';

let app: Express;

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

describe('the footer', () => {
  test('is empty, and so is everything else around the card', async () => {
    const page = await request(app).get('/login').expect(200);

    assert.doesNotMatch(
      page.text,
      /sign-in via Microsoft Entra ID/,
      'the identity provider is not something a reader needs told on every page',
    );
    // The application name is in the title and the masthead already; a third
    // copy in the footer told nobody anything.
    assert.doesNotMatch(page.text, /footer__name/);
  });
});

describe('the appearance preference', () => {
  test('a new visitor gets light, and may choose to follow their computer', async () => {
    // Asked for 16 Oct 2026: a service desk should look the same to
    // everybody who opens it for the first time, whatever their laptop was
    // set to at sunset. Following the computer is still a choice, and
    // choosing it is not the same as having chosen nothing - which is why
    // it is stored rather than expressed by the absence of a cookie.
    const page = await request(app).get('/login').expect(200);
    assert.match(page.text, /<html lang="en" data-theme="light">/, 'light until somebody says otherwise');

    const agent = request.agent(app);
    const first = await agent.get('/login').expect(200);
    await agent
      .post('/theme')
      .type('form')
      .send({ _csrf: csrfFrom(first.text), theme: 'system', returnTo: '/login' })
      .expect(303);
    const following = await agent.get('/login').expect(200);
    assert.match(following.text, /<html lang="en">/, 'then the media query decides');
  });

  test('is available before signing in', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);

    await agent
      .post('/theme')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), theme: 'dark', returnTo: '/login' })
      .expect(303)
      .expect('location', '/login');

    const dark = await agent.get('/login').expect(200);
    assert.match(dark.text, /<html lang="en" data-theme="dark">/);
  });

  test('each of the three choices round-trips', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    const token = csrfFrom(page.text);

    for (const [choice, expected] of [
      ['dark', /<html lang="en" data-theme="dark">/],
      ['light', /<html lang="en" data-theme="light">/],
      ['system', /<html lang="en">/],
    ] as const) {
      await agent
        .post('/theme')
        .type('form')
        .send({ _csrf: token, theme: choice, returnTo: '/login' })
        .expect(303);
      const rendered = await agent.get('/login').expect(200);
      assert.match(rendered.text, expected, 'choosing ' + choice);
    }
  });

  test('marks the current choice in the control', async () => {
    // Read where the control is - the sidebar, signed in. A sign-in page
    // carries nothing but its card.
    const session = await signInAs('theme.choice@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);
    const page = await agent.get('/tickets').expect(200);
    await agent
      .post('/theme')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), theme: 'light', returnTo: '/tickets' })
      .expect(303);

    const rendered = await agent.get('/tickets').expect(200);
    assert.match(rendered.text, /colour-mode__option--current[^>]*>\s*Light/);
    // The icon is unlabelled, so the current choice has to reach a screen
    // reader and a tooltip some other way.
    assert.match(rendered.text, /title="Colour mode: Light"/);
    assert.match(rendered.text, /Colour mode, currently Light/);
  });

  test('an unknown value falls back to the system rather than erroring', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    await agent
      .post('/theme')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), theme: 'neon', returnTo: '/login' })
      .expect(303);

    const rendered = await agent.get('/login').expect(200);
    assert.match(rendered.text, /<html lang="en">/);
  });

  test('cannot be set without a CSRF token', async () => {
    const agent = request.agent(app);
    await agent.get('/login').expect(200);
    await agent.post('/theme').type('form').send({ theme: 'dark' }).expect(403);
  });

  test('will not redirect off-site', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    await agent
      .post('/theme')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        theme: 'dark',
        returnTo: 'https://evil.test/phish',
      })
      .expect(303)
      .expect('location', '/');
  });

  test('follows a signed-in user around', async () => {
    const session = await signInAs('theme.user@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    const page = await agent.get('/tickets').expect(200);
    await agent
      .post('/theme')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), theme: 'dark', returnTo: '/tickets' })
      .expect(303);

    for (const path of ['/tickets', '/tickets/new', '/profile']) {
      const rendered = await agent.get(path).expect(200);
      assert.match(rendered.text, /data-theme="dark"/, path + ' should be dark too');
    }
  });
});

describe('the generated stylesheet', () => {
  test('carries a light palette, an automatic dark one, and an explicit dark one', () => {
    const css = themeStylesheet();

    assert.match(css, /^:root \{/m, 'light is the base');
    assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'and dark follows the system');
    assert.match(
      css,
      /:root:not\(\[data-theme='light'\]\)/,
      'unless the reader has explicitly chosen light',
    );
    assert.match(css, /:root\[data-theme='dark'\]/, 'an explicit dark choice has its own rule');
  });

  test('puts the explicit rule last, so a choice beats the system setting', () => {
    const css = themeStylesheet();
    assert.ok(
      css.indexOf(":root[data-theme='dark']") > css.indexOf('@media (prefers-color-scheme: dark)'),
      'the attribute rule must come after the media query to win on equal specificity',
    );
  });

  test('is still free of anything that could come from user input', () => {
    const css = themeStylesheet();
    assert.doesNotMatch(css, /url\(/i);
    assert.doesNotMatch(css, /@import/i);
    assert.doesNotMatch(css, /expression\(/i);
  });
});

describe('the stylesheet is cache-busted', () => {
  // /assets is served with a seven-day max-age. Without a version in the URL a
  // CSS change stays invisible to anyone who has visited before - which is
  // exactly what happened once while building the colour-mode control.
  test('every page links the stylesheet with a version', async () => {
    const page = await request(app).get('/login').expect(200);
    assert.match(page.text, /\/assets\/css\/app\.css\?v=[0-9a-f]{12}/);
  });

  test('the error page too, since it is rendered outside the normal pipeline', async () => {
    const page = await request(app).get('/no-such-page').expect(404);
    assert.match(page.text, /\/assets\/css\/app\.css\?v=[0-9a-f]{12}/);
  });

  test('the version follows the file contents, not the process', async () => {
    const first = await request(app).get('/login').expect(200);
    const second = await request(app).get('/login').expect(200);
    const of = (html: string) => /app\.css\?v=([0-9a-f]{12})/.exec(html)?.[1];
    assert.equal(of(first.text), of(second.text), 'it must be stable between requests');
  });
});

describe('the control lives in the sidebar, signed in', () => {
  test('a sign-in page carries nothing around its card', async () => {
    // The masthead went first (it repeated the logo), and then the control
    // left floating in the corner went too - both asked for 16 Oct 2026.
    // A chosen theme still reaches the page; only the control is absent.
    for (const path of ['/login', '/login/forgot']) {
      const page = await request(app).get(path).expect(200);
      assert.doesNotMatch(page.text, /colour-mode/, path + ' offers no colour mode');
      assert.doesNotMatch(page.text, /class="topbar"/, path + ' has no masthead');
    }
  });

  test('and nothing at all after the page', async () => {
    const page = await request(app).get('/login').expect(200);
    const afterMain = page.text.slice(page.text.indexOf('</main>'));
    assert.doesNotMatch(afterMain, /colour-mode/);
    assert.doesNotMatch(afterMain, /<footer/);
  });

  test('a signed-in page has it alongside the account controls', async () => {
    const session = await signInAs('masthead.user@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    const page = await agent.get('/tickets').expect(200);
    assert.match(page.text, /colour-mode/);
    assert.match(page.text, /Sign out/, 'and sits with the rest of the account controls');
  });
});
