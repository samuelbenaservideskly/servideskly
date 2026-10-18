import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

let app: Express;

/** Pulls the CSRF token out of a rendered form. */
function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

/**
 * Returns a supertest agent already carrying a session for a fresh account.
 *
 * The session is minted directly by the test helper, because the application
 * ships no credential-free sign-in route.
 */
async function signIn(email: string, role: 'user' | 'agent' | 'admin') {
  const session = await signInAs(email, role);
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

/** Raises a ticket and returns its id. */
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
  const location = response.headers['location'] as string;
  return location.replace('/tickets/', '');
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

describe('security headers', () => {
  test('are present on every response', async () => {
    const response = await request(app).get('/login').expect(200);
    const csp = response.headers['content-security-policy'] ?? '';

    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/, 'no scripts are served, so none are allowed');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.match(csp, /base-uri 'none'/);

    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['cache-control'] ?? '', /no-store/);
    assert.equal(response.headers['x-powered-by'], undefined, 'the stack is not advertised');
  });

  test('the session cookie is HttpOnly, SameSite=Lax and path-scoped', async () => {
    const agent = await signIn('cookie.check@example.com', 'user');
    const response = await agent.get('/tickets').expect(200);
    // The rolling cookie is re-sent on each request.
    const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
    if (cookies && cookies.length > 0) {
      const session = cookies.find((c) => c.startsWith('hdsid'));
      assert.ok(session, 'the session cookie should be reissued');
      assert.match(session, /HttpOnly/i);
      assert.match(session, /SameSite=Lax/i);
      assert.match(session, /Path=\//);
    }
  });
});

describe('authentication', () => {
  test('anonymous browsers are sent to the sign-in page', async () => {
    await request(app).get('/tickets').expect(302).expect('location', /^\/login\?returnTo=/);
    await request(app).get('/admin/settings/users').expect(302).expect('location', /^\/login\?returnTo=/);
    await request(app).get('/').expect(302).expect('location', '/login');
  });

  test('the returnTo parameter cannot be pointed off-site', async () => {
    const response = await request(app).get('/login?returnTo=https://evil.test/x').expect(200);
    // /home is where a sign-in lands by default: the portal's home page, or
    // My tickets when there is none.
    assert.match(response.text, /name="returnTo" value="\/home"/);

    const protocolRelative = await request(app).get('/login?returnTo=//evil.test').expect(200);
    assert.match(protocolRelative.text, /name="returnTo" value="\/home"/);
  });

  test('a session cookie stops working once its session is destroyed', async () => {
    const agent = await signIn('rotate@example.com', 'user');
    const page = await agent.get('/tickets').expect(200);

    await agent
      .post('/auth/logout')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) })
      .expect(302);

    // The same cookie is still presented, but the server-side record is gone.
    await agent.get('/tickets').expect(302).expect('location', /^\/login/);
  });

  test('signing out clears the session', async () => {
    const agent = await signIn('logout@example.com', 'user');
    const page = await agent.get('/tickets').expect(200);
    await agent
      .post('/auth/logout')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) })
      .expect(302);
    await agent.get('/tickets').expect(302).expect('location', /^\/login/);
  });

  test('single sign-on is refused while it is unconfigured', async () => {
    // No tenant credentials exist in the test environment, so the flow must
    // fail closed with an explanation rather than build a broken
    // authorization request.
    const page = await request(app).get('/login').expect(200);
    // No usable Microsoft button until it is configured: absent, or disabled.
    assert.doesNotMatch(page.text, /btn--block[^"]*">\s*Sign in with Microsoft/);

    const cookies = page.headers['set-cookie'] as string[] | undefined;
    assert.ok(cookies, 'the login page must set a session cookie');
    const response = await request(app)
      .post('/auth/login')
      .set('Cookie', cookies)
      .type('form')
      .send({ _csrf: csrfFrom(page.text) });
    assert.equal(response.status, 400);
    assert.match(response.text, /not been configured/i);
  });

  test('there is no credential-free sign-in route', async () => {
    // The development stub is gone: nothing may hand out a session without
    // either a verified assertion or the local administrator password.
    await request(app).get('/auth/dev').expect(404);

    // The POST is refused by the CSRF check before routing even reaches the
    // (now non-existent) handler, which is equally fine - what matters is that
    // it cannot succeed.
    const posted = await request(app)
      .post('/auth/dev')
      .type('form')
      .send({ email: 'x@y.z' });
    assert.ok(
      posted.status === 403 || posted.status === 404,
      'expected a refusal, got ' + posted.status,
    );
  });

  test('the SAML endpoints are gone entirely', async () => {
    // SAML was removed: OpenID Connect is the only single sign-on method.
    await request(app).get('/auth/saml/metadata').expect(404);

    // The assertion consumer used to be the one endpoint exempt from the CSRF
    // token and the Sec-Fetch-Site check, because the IdP posted to it from
    // its own origin. With it gone that exemption list is empty, so this POST
    // is now stopped by the CSRF middleware before routing - a 403 rather than
    // a 404. Either way nothing can reach a handler, because there is none.
    const posted = await request(app)
      .post('/auth/saml/acs')
      .type('form')
      .send({ SAMLResponse: 'x' });
    assert.ok(
      posted.status === 403 || posted.status === 404,
      'expected a refusal, got ' + posted.status,
    );
  });

});

describe('CSRF protection', () => {
  test('rejects a state-changing request with no token', async () => {
    const agent = await signIn('csrf1@example.com', 'user');
    await agent.post('/tickets').type('form').send({ title: 'x', description: 'y' }).expect(403);
  });

  test('rejects a forged token', async () => {
    const agent = await signIn('csrf2@example.com', 'user');
    await agent
      .post('/tickets')
      .type('form')
      .send({ _csrf: 'not-the-real-token', title: 'x', description: 'y' })
      .expect(403);
  });

  test('rejects a valid token submitted from another origin', async () => {
    const agent = await signIn('csrf3@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .set('Origin', 'https://evil.test')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'Cross-origin attempt',
        description: 'This should never be accepted from a foreign origin.',
      })
      .expect(403);
  });

  test('accepts a same-origin request that arrived by another valid hostname', async () => {
    // Regression guard: reaching the app on 127.0.0.1 while APP_BASE_URL says
    // localhost is normal, and must not be mistaken for a cross-site request.
    // Sec-Fetch-Site is browser-set and already answers the question.
    const agent = await signIn('altname@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .set('Origin', 'http://127.0.0.1:3000')
      .set('Sec-Fetch-Site', 'same-origin')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'Raised via the 127.0.0.1 hostname',
        description: 'This must succeed: it is the same origin by another name.',
      })
      .expect(302);
  });

  test('a foreign Origin is still refused when Sec-Fetch-Site is absent', async () => {
    // Non-browser clients send no Sec-Fetch-Site, so Origin still has to hold.
    const agent = await signIn('noheader@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .set('Origin', 'https://evil.test')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'Foreign origin, no fetch metadata',
        description: 'This must be refused even though no Sec-Fetch-Site is sent.',
      })
      .expect(403);
  });

  test('rejects a cross-site request identified by Sec-Fetch-Site', async () => {
    const agent = await signIn('csrf4@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .set('Sec-Fetch-Site', 'cross-site')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'Cross-site attempt',
        description: 'This should never be accepted from a cross-site context.',
      })
      .expect(403);
  });
});

describe('role-based access control', () => {
  test('a requester cannot reach the administration pages', async () => {
    const agent = await signIn('plain.user@example.com', 'user');
    await agent.get('/admin/settings/users').expect(403);
    await agent.get('/admin/sync').expect(403);
    await agent.get('/admin/settings/audit').expect(403);
  });

  test('an agent cannot reach the administration pages', async () => {
    const agent = await signIn('plain.agent@example.com', 'agent');
    await agent.get('/admin/settings/users').expect(403);
  });

  test('an administrator can', async () => {
    const agent = await signIn('real.admin@example.com', 'admin');
    await agent.get('/admin/settings/users').expect(200);
    await agent.get('/admin/settings/users').expect(200);
    await agent.get('/admin/settings/templates').expect(200);
    await agent.get('/admin/settings/audit').expect(200);
    await agent.get('/admin/settings/integrations/entra/provisioning').expect(200);
  });

  test('a requester cannot triage, even their own ticket', async () => {
    const agent = await signIn('triage.attempt@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Requester triage attempt');
    const page = await agent.get('/tickets/' + ticketId).expect(200);
    await agent
      .post('/tickets/' + ticketId + '/update')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), status: 'closed' })
      .expect(403);
  });

  test('a requester cannot post an internal note by forging the field', async () => {
    const agent = await signIn('note.attempt@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Internal note forgery attempt');
    const page = await agent.get('/tickets/' + ticketId).expect(200);
    await agent
      .post('/tickets/' + ticketId + '/comments')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), body: 'Trying to be internal', internal: 'on' })
      .expect(302);

    // The comment is stored, but as a public one.
    const staff = await signIn('note.checker@example.com', 'agent');
    const staffView = await staff.get('/tickets/' + ticketId).expect(200);
    // The comment must not carry the internal-note badge; the checkbox label
    // in the staff form legitimately contains the same words.
    assert.doesNotMatch(staffView.text, /badge--internal/, 'the note flag must have been ignored');
    assert.doesNotMatch(staffView.text, /comment--internal/, 'the note must not render as internal');
    assert.match(staffView.text, /Trying to be internal/, 'the comment itself is still stored');
  });
});

describe('object-level access control', () => {
  test("another requester's ticket is reported as not found", async () => {
    const owner = await signIn('owner@example.com', 'user');
    const ticketId = await raiseTicket(owner, 'Confidential ticket');

    const stranger = await signIn('stranger@example.com', 'user');
    // 404, not 403: the existence of the ticket is not confirmed either.
    await stranger.get('/tickets/' + ticketId).expect(404);
    await stranger
      .post('/tickets/' + ticketId + '/comments')
      .type('form')
      .send({ body: 'prying' })
      .expect(403);
  });

  test('staff may open any ticket', async () => {
    const owner = await signIn('owner2@example.com', 'user');
    const ticketId = await raiseTicket(owner, 'Ticket visible to staff');
    const staff = await signIn('staff.viewer@example.com', 'agent');
    await staff.get('/tickets/' + ticketId).expect(200);
  });

  test('a malformed ticket id is a 404, not a server error', async () => {
    const agent = await signIn('malformed@example.com', 'user');
    await agent.get('/tickets/not-a-uuid').expect(404);
    await agent.get('/tickets/' + '../../etc/passwd').expect(404);
  });
});

describe('input validation', () => {
  test('a too-short ticket is redisplayed with an error, not saved', async () => {
    const agent = await signIn('validate@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    const response = await agent
      .post('/tickets')
      .type('form')
      .send({ _csrf: csrfFrom(form.text), title: 'ab', description: 'too short' })
      .expect(400);
    assert.match(response.text, /Give the ticket a short title|more detail/);
  });

  test('an unknown status value is refused', async () => {
    const staff = await signIn('enum.check@example.com', 'agent');
    const ticketId = await raiseTicket(staff, 'Enum validation ticket');
    const page = await staff.get('/tickets/' + ticketId).expect(200);
    await staff
      .post('/tickets/' + ticketId + '/update')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), status: 'deleted' })
      .expect(400);
  });

  test('user-supplied markup is escaped in the response', async () => {
    const agent = await signIn('xss@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    const response = await agent
      .post('/tickets')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: '<script>alert(1)</script>',
        description: 'Payload: <img src=x onerror=alert(2)> and "quotes" and \'apostrophes\'.',
        priority: 'low',
        category: 'other',
      })
      .expect(302);

    const page = await agent
      .get((response.headers['location'] as string))
      .expect(200);

    assert.doesNotMatch(page.text, /<script>alert\(1\)<\/script>/, 'no raw script tag');
    assert.doesNotMatch(page.text, /<img src=x/, 'no raw img tag');
    assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'escaped instead');
  });
});

describe('health endpoints', () => {
  test('respond without a session', async () => {
    const health = await request(app).get('/healthz').expect(200);
    assert.equal(health.text, 'ok');
    assert.equal(
      health.headers['set-cookie'],
      undefined,
      'health checks must not allocate sessions',
    );
    await request(app).get('/readyz').expect(200);
  });
});

describe('unknown routes', () => {
  test('render a 404 page rather than leaking a stack trace', async () => {
    const response = await request(app).get('/no/such/page').expect(404);
    assert.match(response.text, /Not found|does not exist/);
    assert.doesNotMatch(response.text, /at Object|node_modules/, 'no stack trace in the response');
  });
});
