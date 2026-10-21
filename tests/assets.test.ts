import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { queryOne } from '../src/db/index.js';
import {
  addColumn,
  createAsset,
  deleteColumn,
  deleteStatus,
  getAsset,
  listAssetEvents,
  listAssets,
  listColumns,
  updateColumn,
} from '../src/services/assets.js';

/** Assets, step 1 (services/assets.ts, 21 Oct 2026). */

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;

const as = (s: TestSession) => {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
};
const post = (s: TestSession, url: string, form: Record<string, string | string[]>) =>
  as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('assets.admin@example.com', 'admin');
  agent = await signInAs('assets.agent@example.com', 'agent');
  requester = await signInAs('assets.user@example.com', 'user');
});

describe('who works with assets', () => {
  test('a technician and an administrator; a requester gets a 404, and no link', async () => {
    await as(agent).get('/inventory').expect(200);
    await as(admin).get('/inventory').expect(200);
    await as(requester).get('/inventory').expect(404);
    const home = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(home.text, /href="\/inventory"/);
    const staff = await as(agent).get('/tickets').expect(200);
    assert.match(staff.text, /href="\/inventory"/);
  });
});

describe('an asset', () => {
  test('is added with its values, a status and a person, and shows on their page', async () => {
    const res = await post(agent, '/inventory', {
      statusId: 'assigned',
      assignee: 'assets.user@example.com',
      v_Model: 'ThinkPad T14',
      v_SerialNumber: 'PF-1234',
      v_DateBought: '2026-03-01',
    }).expect(302);
    const id = String(res.headers.location).replace('/inventory/', '');
    const asset = (await getAsset(id))!;
    assert.equal(asset.field_values.Model, 'ThinkPad T14');
    assert.equal(asset.assigned_to, requester.user.id);
    assert.equal(asset.status_name, 'Assigned');

    const page = await as(agent).get('/inventory/' + id).expect(200);
    assert.match(page.text, /ThinkPad T14 \(PF-1234\)/);
    const person = await as(agent).get('/people/' + requester.user.id).expect(200);
    assert.match(person.text, new RegExp('href="/inventory/' + id + '"'));
  });

  test('a value that is not what its column asks for is refused beside the form, with what was typed', async () => {
    const res = await post(agent, '/inventory', { statusId: 'in-stock', assignee: '', v_Model: 'Kept', v_DateBought: 'last week' }).expect(400);
    assert.match(res.text, /Date bought: enter a date/);
    assert.match(res.text, /value="Kept"/);
    assert.match(res.text, /dialog dialog--open" id="new-asset"/);
    const unknown = await post(agent, '/inventory', { statusId: 'in-stock', assignee: 'nobody@example.com', v_Model: 'X' }).expect(400);
    assert.match(unknown.text, /no active account with that address/);
  });

  test('every change is history: values, status and person', async () => {
    const id = await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'iPhone 15' } }, { id: agent.user.id });
    await post(agent, '/inventory/' + id, { statusId: 'assigned', assignee: 'assets.user@example.com', v_Model: 'iPhone 15 Pro' }).expect(302);
    const kinds = (await listAssetEvents(id)).map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['assigned', 'created', 'status', 'value']);
    await post(agent, '/inventory/' + id + '/comments', { body: 'Screen replaced.' }).expect(302);
    const page = await as(agent).get('/inventory/' + id).expect(200);
    assert.match(page.text, /Screen replaced\./);
    assert.match(page.text, /Status changed from In stock to Assigned/);
  });

  test('the list searches, filters and sorts in SQL', async () => {
    await createAsset({ statusId: 'retired', assignee: '', values: { Model: 'Old Dell', SerialNumber: 'ZZ-9' } }, null);
    assert.ok((await listAssets({ q: 'dell zz-9' })).items.every((a) => a.field_values.Model === 'Old Dell'));
    assert.ok((await listAssets({ statusId: 'retired' })).items.length >= 1);
    assert.ok((await listAssets({ unassigned: true })).items.every((a) => a.assigned_to === null));
    const sorted = (await listAssets({ sort: 'Model', dir: 'asc' })).items.map((a) => (a.field_values.Model ?? '').toLowerCase());
    assert.deepEqual(sorted, [...sorted].sort());
    const page = await as(agent).get('/inventory?q=Dell').expect(200);
    assert.match(page.text, /Old Dell/);
    assert.doesNotMatch(page.text, /ThinkPad/);
  });
});

describe('Settings - Assets', () => {
  test('a column is renamed, given another format, or switched off; its variable stays', async () => {
    await post(admin, '/admin/settings/assets/columns/Type', { label: 'Kind', format: 'select', choices: 'Laptop\nPhone', enabled: 'on' }).expect(302);
    const type = (await listColumns()).find((c) => c.key === 'Type')!;
    assert.deepEqual([type.label, type.format, type.choices], ['Kind', 'select', ['Laptop', 'Phone']]);
    const refused = await post(agent, '/inventory', { statusId: 'in-stock', assignee: '', v_Type: 'Toaster' }).expect(400);
    assert.match(refused.text, /Kind: choose one of the options/);

    await post(admin, '/admin/settings/assets/columns/Imei', { label: 'IMEI / Other', format: 'text' }).expect(302);
    assert.equal((await listColumns()).find((c) => c.key === 'Imei')!.is_enabled, false);
    const form = await as(agent).get('/inventory').expect(200);
    assert.doesNotMatch(form.text, /name="v_Imei"/);
  });

  test('Assigned to stays a person; a built-in column is switched off rather than removed', async () => {
    await updateColumn('AssignedTo', { label: 'Holder', format: 'date', choices: [], enabled: true }, null);
    assert.equal((await listColumns()).find((c) => c.key === 'AssignedTo')!.format, 'person');
    await assert.rejects(deleteColumn('Model', null), /switched off rather than removed/);
    const key = await addColumn({ label: 'Warranty until', format: 'date', choices: [], enabled: true }, null);
    assert.equal(key, 'WarrantyUntil');
    await deleteColumn(key, null);
  });

  test('statuses are added and renamed; one in use cannot be removed', async () => {
    await post(admin, '/admin/settings/assets/statuses', { name: 'Lost' }).expect(302);
    const lost = await queryOne<{ id: string }>("SELECT id FROM asset_statuses WHERE name = 'Lost'");
    assert.ok(lost);
    await post(admin, '/admin/settings/assets/statuses/' + lost!.id, { name: 'Missing' }).expect(302);
    assert.ok(await queryOne("SELECT id FROM asset_statuses WHERE name = 'Missing'"));
    await assert.rejects(deleteStatus('assigned', null), /Give them another first/);
    await deleteStatus(lost!.id, null);
  });

  test('only for an administrator or the Assets settings permission', async () => {
    assert.equal((await as(agent).get('/admin/settings/assets/columns')).status, 403);
    await as(admin).get('/admin/settings/assets/columns').expect(200);
    await as(admin).get('/admin/settings/assets/statuses').expect(200);
  });
});
