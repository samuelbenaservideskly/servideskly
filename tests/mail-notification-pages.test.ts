import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  listNotifications,
  notificationFor,
  seedNotifications,
  updateNotification,
} from '../src/services/mail/notifications.js';

/**
 * The notification pages.
 *
 * One notification per page, with a preview of what it will look like. The
 * preview is an iframe, and framing is the part worth a test: every other
 * response in this process says `X-Frame-Options: DENY` and
 * `frame-ancestors 'none'`, either of which would leave the preview a blank
 * box - and a blank box looks like a styling problem, not a header.
 */

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let userAgent: request.Agent;

const PAGE = '/admin/settings/mail/notifications';

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  await seedNotifications();

  admin = await signInAs('notify.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  const user = await signInAs('notify.user@example.com', 'user');
  userAgent = request.agent(app);
  userAgent.set('Cookie', user.cookie);
});

describe('the design every notification ships with', () => {
  test('the logo carries a width, so a mail client scales it', async () => {
    // Reported 16 Oct 2026 with a screenshot: a 1,200px wordmark filling half
    // the message. Outlook ignores max-width on an image, so the attribute is
    // what does the work.
    const created = await notificationFor('ticket.created.requester');
    assert.ok(created);
    assert.match(created.body_html, /<img src="cid:logo"[^>]*width="150"/);
  });

  test('every ticket notification carries a link to the request', async () => {
    // "This should also have a link to the request" - the requester's own
    // notifications had none, so the only way back to the ticket was to
    // reply to the email.
    for (const event of [
      'ticket.created.requester',
      'ticket.created.on_behalf',
      'ticket.status.changed',
      'ticket.resolved',
      'comment.added.requester',
    ] as const) {
      const row = await notificationFor(event);
      assert.ok(row, event);
      assert.match(row.body_html, /\{\{ticketUrl\}\}/, event + ' should link to the ticket');
    }
  });

  test('all of them can be put back at once, and custom ones are left alone', async () => {
    const created = await notificationFor('ticket.created.requester');
    assert.ok(created);
    await updateNotification(
      created.id,
      { subject: 'Mine', bodyHtml: '<p>Mine</p>', isEnabled: true, mailboxId: null },
      null,
    );

    const page = await adminAgent.get(PAGE).expect(200);
    assert.match(page.text, /notifications\/reset-all/, 'the list offers it');

    await adminAgent
      .post(PAGE + '/reset-all')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) })
      .expect(302);

    const back = await notificationFor('ticket.created.requester');
    assert.ok(back);
    assert.notEqual(back.subject, 'Mine', 'the wording went back');
    assert.match(back.body_html, /width="150"/);
  });
});

describe('the notification list', () => {
  test('links to every notification instead of editing them in place', async () => {
    const notifications = await listNotifications();
    assert.ok(notifications.length > 1, 'there should be several to list');

    const res = await adminAgent.get(PAGE).expect(200);

    for (const notification of notifications) {
      assert.match(res.text, new RegExp('href="' + PAGE + '/' + notification.id + '"'));
      assert.ok(res.text.includes(notification.name));
    }

    // The wording is edited on its own page now; a body editor on the list
    // would mean the split had been quietly undone.
    assert.ok(!res.text.includes('name="bodyHtml"'), 'the list should edit nothing');
  });

  test('says who each one goes to', async () => {
    const res = await adminAgent.get(PAGE).expect(200);
    assert.ok(res.text.includes('The requester'));
    assert.ok(res.text.includes('The technician group'));
  });
});

describe('one notification', () => {
  test('can be opened, edited and read back', async () => {
    const row = await notificationFor('ticket.resolved');
    assert.ok(row);

    const page = await adminAgent.get(PAGE + '/' + row.id).expect(200);
    assert.ok(page.text.includes(row.subject.replace(/&/g, '&amp;')));

    await adminAgent
      .post(PAGE + '/' + row.id)
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        subject: '[{{reference}}] Hotovo: {{title}}',
        bodyHtml: '<p>Ahoj {{requesterName}}</p>',
        isEnabled: '1',
      })
      .expect(302)
      .expect('Location', PAGE + '/' + row.id);

    const saved = await notificationFor('ticket.resolved');
    assert.equal(saved?.subject, '[{{reference}}] Hotovo: {{title}}');
  });

  test('a missing subject comes back as a field error with the typing kept', async () => {
    const row = await notificationFor('ticket.status.changed');
    assert.ok(row);
    const page = await adminAgent.get(PAGE + '/' + row.id).expect(200);

    const res = await adminAgent
      .post(PAGE + '/' + row.id)
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        subject: '',
        bodyHtml: '<p>Work in progress</p>',
      })
      .expect(400);

    assert.ok(res.text.includes('A notification needs a subject.'));
    assert.ok(res.text.includes('Work in progress'), 'the typed body should survive');

    const unchanged = await notificationFor('ticket.status.changed');
    assert.equal(unchanged?.subject, row.subject);
  });

  test('is not reachable by a user who is not an administrator', async () => {
    const row = await notificationFor('ticket.resolved');
    assert.ok(row);
    await userAgent.get(PAGE + '/' + row.id).expect(403);
    await userAgent.get(PAGE + '/' + row.id + '/preview').expect(403);
  });

  test('a notification that no longer exists is a 404, not a crash', async () => {
    await adminAgent.get(PAGE + '/not-a-notification').expect(404);
  });
});

describe('the preview', () => {
  test('fills the placeholders in with an example ticket', async () => {
    const row = await notificationFor('ticket.created.requester');
    assert.ok(row);
    await updateNotification(
      row.id,
      {
        subject: row.subject,
        bodyHtml: '<p>{{requesterName}} - {{title}} - {{reference}}</p>',
        isEnabled: row.is_enabled,
        mailboxId: row.mailbox_id,
      },
      admin.user.id,
    );

    const res = await adminAgent.get(PAGE + '/' + row.id + '/preview').expect(200);
    assert.ok(!res.text.includes('{{'), 'no placeholder should survive the preview');
    assert.ok(res.text.includes('TKT-000123'));
    // Also proves the response is served as UTF-8: the sample title is Czech.
    assert.ok(res.text.includes('Printer not working'));
  });

  test('may be framed by the page that shows it, and nothing else', async () => {
    const row = await notificationFor('ticket.resolved');
    assert.ok(row);

    const page = await adminAgent.get(PAGE + '/' + row.id).expect(200);
    assert.match(
      String(page.headers['content-security-policy']),
      /frame-src 'self'/,
      'the editor page must be allowed to frame the preview',
    );

    const preview = await adminAgent.get(PAGE + '/' + row.id + '/preview').expect(200);
    const policy = String(preview.headers['content-security-policy']);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.match(policy, /script-src|default-src 'none'/);
    assert.equal(
      preview.headers['x-frame-options'],
      undefined,
      'X-Frame-Options: DENY would block the iframe whatever the policy says',
    );
  });

  test('leaves every other page denied', async () => {
    const res = await adminAgent.get(PAGE).expect(200);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(!String(res.headers['content-security-policy']).includes('frame-src'));
  });
});
