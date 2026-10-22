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
    assert.match(res.text, /Date bought: &#34;last week&#34; is not a date/);
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

describe('importing assets from a CSV', () => {
  const upload = (s: TestSession, csv: string) =>
    as(s).post('/inventory/import').field('_csrf', s.csrfToken).attach('file', Buffer.from(csv, 'utf8'), 'assets.csv');

  test('the template is the columns switched on, and Status', async () => {
    const res = await as(agent).get('/inventory/import/template.csv').expect(200);
    const header = res.text.replace(/^\uFEFF/, '').split('\r\n')[0]!;
    assert.match(header, /^Status,Model,/);
    assert.match(header, /\(email\)/);
    assert.doesNotMatch(header, /IMEI/, 'switched off above');
  });

  test('a good sheet imports; a serial number already here, or twice in the sheet, is skipped and said', async () => {
    const csv = [
      'Status;Model;Serial number;Holder (email)',
      'In stock;Surface Pro;SP-1;',
      'assigned;Surface Laptop;SP-2;assets.user@example.com',
      'In stock;Surface Pro again;SP-1;',
      'In stock;Old;PF-1234;',
    ].join('\n');
    const res = await upload(agent, csv).expect(200);
    assert.match(res.text, /2 assets imported/);
    assert.match(res.text, /Row 4: serial number SP-1 is earlier in the sheet/);
    assert.match(res.text, /Row 5: serial number PF-1234 is already here/);
    const laptop = (await listAssets({ q: 'SP-2' })).items[0]!;
    assert.equal(laptop.assigned_to, requester.user.id);
    assert.equal(laptop.status_id, 'assigned');
  });

  test('one bad row imports nothing, and every problem has its row', async () => {
    const before = (await listAssets({ perPage: 200 })).total;
    const csv = ['Status,Model,Date bought,Holder (email)', 'In stock,Fine,2026-01-01,', 'Unknown,Bad,yesterday,nobody@example.com'].join('\n');
    const res = await upload(agent, csv).expect(400);
    assert.match(res.text, /Nothing was imported/);
    assert.match(res.text, /Row 3: no status called &#34;Unknown&#34;/);
    assert.match(res.text, /Row 3: nobody active has the address nobody@example.com/);
    assert.match(res.text, /Row 3: Date bought: &#34;yesterday&#34; is not a date/);
    assert.equal((await listAssets({ perPage: 200 })).total, before);
    const unknown = await upload(agent, 'Model,Colour\nX,Red').expect(400);
    assert.match(unknown.text, /Unknown column &#34;Colour&#34;/);
  });

  test('dates as Excel saves them are read, and stored as 2026-10-21', async () => {
    const csv = ['Status;Model;Serial number;Date bought', 'In stock;Czech Excel;XL-1;21.10.2026', 'In stock;British Excel;XL-2;21/10/2026', 'In stock;With a time;XL-3;2026-10-21 00:00', 'In stock;Excel day number;XL-4;46316'].join('\n');
    const res = await upload(agent, csv).expect(200);
    assert.match(res.text, /4 assets imported/);
    for (const serial of ['XL-1', 'XL-2', 'XL-3', 'XL-4']) {
      const row = (await listAssets({ q: serial })).items[0]!;
      assert.equal(row.field_values.DateBought, '2026-10-21', serial);
    }
  });

  test('a requester cannot import', async () => {
    await upload(requester, 'Model\nX').expect(404);
  });
});

describe('the asset list, Excel-like', () => {
  test('every header has a menu; filters on two columns narrow the same list; a value counts what is left', async () => {
    await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'Filter Model A', Vendor: 'Acme' } }, null);
    await createAsset({ statusId: 'retired', assignee: '', values: { Model: 'Filter Model A', Vendor: 'Acme' } }, null);
    await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'Filter Model B', Vendor: 'Acme' } }, null);

    const page = await as(agent).get('/inventory').expect(200);
    assert.match(page.text, /name="cf_Model"/);
    assert.match(page.text, /name="cf_status"/);

    const both = await as(agent).get('/inventory?cf_Model=Filter+Model+A&cf_status=in-stock').expect(200);
    const rows = both.text.split('<tbody>')[1]!.split('</tbody>')[0]!;
    assert.equal((rows.match(/<tr>/g) ?? []).length, 1, 'Model A and In stock: one asset');
    assert.match(both.text, /Clear column filters/);
    assert.match(both.text, /<input type="hidden" name="cf_Model" value="Filter Model A">/, 'kept by the search bar');

    const one = await listAssets({ columns: { Model: ['Filter Model A'] } });
    assert.equal(one.total, 2);
  });
});

describe('unassigning, and files on an asset (22 Oct 2026)', () => {
  test('Unassign takes the asset back in one press, and says so in the history', async () => {
    const id = await createAsset({ statusId: 'assigned', assignee: 'assets.user@example.com', values: { Model: 'Unassign me' } }, null);
    const page = await as(agent).get('/inventory/' + id).expect(200);
    assert.match(page.text, /action="\/inventory\/[^"]+\/unassign"/);
    await post(agent, '/inventory/' + id + '/unassign', {}).expect(302);
    assert.equal((await getAsset(id))?.assigned_to, null);
    assert.ok((await listAssetEvents(id)).some((e) => e.kind === 'unassigned'));
    const after = await as(agent).get('/inventory/' + id).expect(200);
    assert.doesNotMatch(after.text, /\/unassign"/, 'nothing to take back any more');
  });

  test('files are added, listed, downloaded and removed; a file that is not what it says is refused', async () => {
    const id = await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'With a receipt' } }, null);
    // A real PNG header, and a text file pretending to be one.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const upload = (name: string, bytes: Buffer) =>
      as(agent).post('/inventory/' + id + '/attachments').field('_csrf', agent.csrfToken).attach('files', bytes, name);

    await upload('receipt.png', png).expect(302);
    const page = await as(agent).get('/inventory/' + id).expect(200);
    const link = page.text.match(/href="(\/inventory\/[^"]+\/attachments\/[^"]+)"/)?.[1];
    assert.ok(link, 'listed with a download link');
    const file = await as(agent).get(link!).expect(200);
    assert.match(String(file.headers['content-disposition']), /attachment; filename="receipt\.png"/);
    assert.equal(Buffer.compare(file.body as Buffer, png), 0, 'the same bytes back');

    await upload('fake.png', Buffer.from('not an image at all')).expect(302);
    const refused = await as(agent).get('/inventory/' + id).expect(200);
    assert.match(refused.text, /do not match its \.png extension/);

    const fileId = link!.split('/').pop()!;
    await post(agent, '/inventory/' + id + '/attachments/' + fileId + '/delete', {}).expect(302);
    await as(agent).get(link!).expect(404);
    const kinds = (await listAssetEvents(id)).map((e) => e.kind);
    assert.ok(kinds.includes('file') && kinds.includes('file_removed'));
  });

  test('a requester cannot reach a file', async () => {
    const id = await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'Private' } }, null);
    await as(requester).get('/inventory/' + id + '/attachments/00000000-0000-0000-0000-000000000000').expect(404);
  });
});
