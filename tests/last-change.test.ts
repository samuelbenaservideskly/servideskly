import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { execute } from '../src/db/index.js';
import { lastChangeFor } from '../src/routes/last-change.js';
import { createGroup } from '../src/services/groups.js';
import { createPortal } from '../src/services/portal.js';
import { audit } from '../src/lib/audit.js';

let app: Express;
let admin: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('lc.admin@example.com', 'admin');
  // A clean trail, so each test sees only what it does.
  await execute('DELETE FROM audit_log');
});

describe('last changed, per page', () => {
  test('a page nobody has changed says nothing', async () => {
    const page = await as(admin).get('/admin/settings/customization/locale').expect(200);
    assert.doesNotMatch(page.text, /Last changed/);
  });

  test('saving a page shows when, and who, on that page only', async () => {
    await as(admin)
      .post('/admin/settings/customization/locale')
      .type('form')
      .send({ _csrf: admin.csrfToken, timeZone: 'Europe/Prague', dateFormat: 'dd.MM.yyyy', timeFormat: '24h' })
      .expect(302);

    const locale = await as(admin).get('/admin/settings/customization/locale').expect(200);
    assert.match(locale.text, /Last changed just now by lc\.admin@example\.com/);

    // A different page is not "changed" by it.
    const attachments = await as(admin).get('/admin/settings/customization/attachments').expect(200);
    assert.doesNotMatch(attachments.text, /Last changed/);
  });

  test('a detail page narrows to its own item', async () => {
    const one = await createGroup({ name: 'LC one', description: '', isActive: true }, admin.user.id);
    const two = await createGroup({ name: 'LC two', description: '', isActive: true }, admin.user.id);
    await execute("UPDATE audit_log SET created_at = '2020-01-01T00:00:00.000Z' WHERE target_id = ?", [one.id]);

    const first = await lastChangeFor('/groups/' + one.id);
    const second = await lastChangeFor('/groups/' + two.id);
    assert.equal(first?.at, '2020-01-01T00:00:00.000Z');
    assert.notEqual(second?.at, first?.at);
    assert.equal(second?.by, 'lc.admin@example.com', 'the email comes from the user when the entry has only an id');

    // The list takes the newest of them all.
    assert.equal((await lastChangeFor('/groups'))?.at, second?.at);
  });

  test('the requester portal and the approval page are kept apart', async () => {
    const approval = await createPortal('LC approval', admin.user.id, undefined, 'approval');
    assert.ok(await lastChangeFor('/mail/approval'));
    assert.equal(
      (await lastChangeFor('/customization/portal'))?.at ?? null,
      null,
      'an approval page change is not a portal change',
    );
    assert.ok(await lastChangeFor('/mail/approval/' + approval.id));
  });

  test('a change made by the system says so', async () => {
    audit({ action: 'settings.sla.changed', actorId: null, targetType: 'settings' });
    await new Promise((r) => setTimeout(r, 20));
    const page = await as(admin).get('/admin/settings/templates/other').expect(200);
    assert.match(page.text, /by the system/);
  });

  test('Mail - Other settings is audited now, and shows it', async () => {
    await as(admin)
      .post('/admin/settings/mail/automation')
      .type('form')
      .send({ _csrf: admin.csrfToken, autoCloseDays: '5', reopenWithinDays: '0' })
      .expect(302);
    await new Promise((r) => setTimeout(r, 20));
    const page = await as(admin).get('/admin/settings/mail/automation').expect(200);
    assert.match(page.text, /Last changed just now by lc\.admin@example\.com/);
  });
});

describe('the audit trail action filter', () => {
  test('is a grouped dropdown, not a free-text box with a datalist', async () => {
    const page = await as(admin).get('/admin/settings/audit').expect(200);
    assert.doesNotMatch(page.text, /<datalist/);
    assert.match(page.text, /<select id="action" name="action">/);
    assert.match(page.text, /<optgroup label="Settings">/);
    assert.match(page.text, /<option value="settings\.">All settings<\/option>/);
    assert.match(page.text, /<option value="settings\.locale\.changed">Locale changed<\/option>/);
  });

  test('choosing an area filters by its prefix, and the choice stays selected', async () => {
    const page = await as(admin).get('/admin/settings/audit?action=settings.').expect(200);
    assert.match(page.text, /<option value="settings\." selected>/);
    assert.match(page.text, /settings\.locale\.changed/);
    assert.doesNotMatch(page.text, /<td class="small mono">group\.created<\/td>/);
  });

  test('a filter from an old link is kept as its own option', async () => {
    const page = await as(admin).get('/admin/settings/audit?action=auth.login').expect(200);
    assert.match(page.text, /<option value="auth\.login" selected>auth\.login<\/option>/);
  });
});
