import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { formatDate, formatDateTime } from '../src/lib/format.js';

let app: Express;
let admin: TestSession;

function post(form: Record<string, string>) {
  const agent = request.agent(app);
  agent.set('Cookie', admin.cookie);
  return agent.post('/admin/settings/customization/locale').type('form').send({ _csrf: admin.csrfToken, ...form });
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('locale.admin@example.com', 'admin');
});

describe('locale', () => {
  // 14 Oct 2025 08:05 UTC = 10:05 in Prague (CEST).
  const instant = '2025-10-14T08:05:00.000Z';

  test('dates follow the time zone and format', async () => {
    await updateSettings({ locale: { timeZone: 'Europe/Prague', dateFormat: 'dd.MM.yyyy', timeFormat: '24h' } }, null);
    assert.equal(formatDateTime(instant), '14.10.2025 10:05');
    assert.equal(formatDate(instant), '14.10.2025');

    await updateSettings({ locale: { timeZone: 'America/New_York', dateFormat: 'MM/dd/yyyy', timeFormat: '12h' } }, null);
    assert.equal(formatDateTime(instant), '10/14/2025 4:05 AM');

    await updateSettings({ locale: { timeZone: 'UTC', dateFormat: 'dd MMM yyyy', timeFormat: '24h' } }, null);
    assert.equal(formatDateTime(instant), '14 Oct 2025 08:05');
  });

  test('a tab of Customisation that saves, and refuses what it does not know', async () => {
    const agent = request.agent(app);
    agent.set('Cookie', admin.cookie);
    const page = await agent.get('/admin/settings/customization/locale').expect(200);
    assert.match(page.text, /aria-current="page">Locale</);
    assert.match(page.text, /<option value="Europe\/Prague"/);

    await post({ timeZone: 'Europe/Prague', dateFormat: 'd. M. yyyy', timeFormat: '24h' }).expect(302);
    assert.equal(settings().locale.dateFormat, 'd. M. yyyy');

    const refused = await post({ timeZone: 'Mars/Olympus', dateFormat: 'nonsense', timeFormat: '25h' }).expect(400);
    assert.match(refused.text, /Choose a time zone from the list/);
    assert.equal(settings().locale.timeZone, 'Europe/Prague');
  });

  test('SLA counts in the Locale time zone', async () => {
    await updateSettings({ locale: { timeZone: 'Asia/Tokyo' } }, null);
    assert.equal(settings().sla.timeZone, 'Asia/Tokyo');
  });
});

describe('the time zone list', () => {
  test('is grouped regions with their offset, Windows style', async () => {
    const { timeZoneOptions } = await import('../src/lib/time-zones.js');
    const zones = timeZoneOptions();
    const prague = zones.find((z) => z.value === 'Europe/Prague');
    assert.equal(prague?.label, '(UTC+01:00) Belgrade, Bratislava, Budapest, Ljubljana, Prague');
    assert.equal(zones.find((z) => z.value === 'UTC')?.label, '(UTC) Coordinated Universal Time');
    assert.equal(zones.find((z) => z.value === 'Asia/Kolkata')?.label, '(UTC+05:30) Chennai, Kolkata, Mumbai, New Delhi');
    assert.ok(zones.length < 100, 'regions, not every city');
    // West to east.
    for (let i = 1; i < zones.length; i++) assert.ok(zones[i]!.offset >= zones[i - 1]!.offset);
  });

  test('a zone set before the list existed is kept as its own entry', async () => {
    const { timeZoneOptions } = await import('../src/lib/time-zones.js');
    assert.ok(timeZoneOptions('Europe/Vienna').some((z) => z.value === 'Europe/Vienna'));
  });
});
