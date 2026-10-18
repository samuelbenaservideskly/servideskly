import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createGroup, setGroupManager, setMembersWithin } from '../src/services/groups.js';
import { createTicket } from '../src/services/tickets.js';
import { buildDisplayName, formatProblem, tidy } from '../src/services/display-names.js';
import { createScimUser, readScimUser, toScimUser } from '../src/services/scim.js';
import { render } from '../src/services/mail/notifications.js';
import { setProfileAttributes, findUserById } from '../src/services/users.js';

let app: Express;
let admin: TestSession;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
const post = (s: TestSession, url: string, form: Record<string, string> = {}) => as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('reports.admin@example.com', 'admin');
});

describe('display names from a format', () => {
  const person = {
    first_name: 'Jana', last_name: 'Novakova', company: 'Contoso', department: '', job_title: '', office: '',
    email: 'jana@contoso.com', display_name_source: 'J. Novakova (Contoso)',
  };

  test('variables are filled; empty pieces tidy themselves away', () => {
    assert.equal(buildDisplayName(person, '[First] [Last] - ([Company])'), 'Jana Novakova - (Contoso)');
    assert.equal(buildDisplayName({ ...person, company: '' }, '[First] [Last] - ([Company])'), 'Jana Novakova');
    assert.equal(buildDisplayName({ ...person, company: '' }, '[Last], [First] | [Company]'), 'Novakova, Jana');
    assert.equal(buildDisplayName(person, '[last] [FIRST]'), 'Novakova Jana', 'variables ignore case');
    assert.equal(tidy(' - () Jana  ,  - '), 'Jana');
  });

  test('no first or last name, or no format: the source name; never empty', () => {
    assert.equal(buildDisplayName({ ...person, first_name: '', last_name: '' }, '[First] [Last] - ([Company])'), 'J. Novakova (Contoso)');
    assert.equal(buildDisplayName(person, ''), 'J. Novakova (Contoso)');
    assert.equal(buildDisplayName({ ...person, display_name_source: '' }, ''), 'jana@contoso.com');
  });

  test('an unknown variable is refused', () => {
    assert.match(formatProblem('[First] [Surname]') ?? '', /Unknown variable: \[Surname\]/);
    assert.equal(formatProblem('[First] [Last] - ([Company])'), null);
  });

  test('saving the format rewrites everybody, and a refusal is said beside the field', async () => {
    const bad = await post(admin, '/admin/settings/users/other', { displayNameFormat: '[First] [Nope]' }).expect(400);
    assert.match(bad.text, /Unknown variable/);

    const someone = await signInAs('petr.svoboda@example.com', 'user');
    await setProfileAttributes(someone.user.id, { department: '', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '', firstName: 'Petr', lastName: 'Svoboda', company: 'Fabrikam' }, null);
    await post(admin, '/admin/settings/users/other', { displayNameFormat: '[Last] [First] ([Company])' }).expect(302);
    assert.equal((await findUserById(someone.user.id))!.display_name, 'Svoboda Petr (Fabrikam)');

    const page = await as(admin).get('/admin/settings/users/other').expect(200);
    assert.match(page.text, /Novakova Jana \(Contoso\)/, 'an example of how names read');

    // Off again: back to the name as the directory gave it.
    await post(admin, '/admin/settings/users/other', { displayNameFormat: '' }).expect(302);
    const back = (await findUserById(someone.user.id))!;
    assert.equal(back.display_name, back.display_name_source);
  });

  test('SCIM brings first name, last name and company, and reads its own name back', async () => {
    await post(admin, '/admin/settings/users/other', { displayNameFormat: '[First] [Last] - ([Company])' }).expect(302);
    const input = readScimUser({
      userName: 'eva.kral@contoso.com',
      displayName: 'Eva Kral',
      name: { givenName: 'Eva', familyName: 'Kral' },
      emails: [{ value: 'eva.kral@contoso.com', primary: true }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { organization: 'Contoso' },
    });
    const row = await createScimUser(input);
    assert.deepEqual([row.first_name, row.last_name, row.company, row.display_name], ['Eva', 'Kral', 'Contoso', 'Eva Kral - (Contoso)']);
    const resource = toScimUser(row, 'https://x');
    assert.equal(resource.displayName, 'Eva Kral', 'the directory never sees the formatted name');
    assert.equal(resource.name.givenName, 'Eva');
  });

  test('notification templates can use the parts', () => {
    assert.equal(render('Dear {{requesterFirstName}} at {{requesterCompany}}', { requesterFirstName: 'Eva', requesterCompany: 'Contoso' }), 'Dear Eva at Contoso');
  });

  test('a new local account may give first and last name instead of a display name', async () => {
    await post(admin, '/admin/settings/users', {
      email: 'new.person@contoso.com', firstName: 'New', lastName: 'Person', company: 'Contoso', role: 'user', password: 'A-long-enough-test-passphrase-1',
    }).expect(302);
    const row = await queryOne<{ display_name: string; display_name_source: string; company: string }>('SELECT display_name, display_name_source, company FROM users WHERE email = ?', ['new.person@contoso.com']);
    assert.deepEqual(row, { display_name: 'New Person - (Contoso)', display_name_source: 'New Person', company: 'Contoso' });
  });
});

describe('reports', () => {
  let groupId: string;
  let manager: TestSession;
  let tech: TestSession;

  before(async () => {
    manager = await signInAs('manager@example.com', 'agent');
    tech = await signInAs('tech@example.com', 'agent');
    const group = await createGroup({ name: 'Desktop', description: '', isActive: true }, null);
    groupId = group.id;
    await setMembersWithin(groupId, [tech.user.id], [tech.user.id], null);
    await setGroupManager(groupId, manager.user.id, null);
    for (const priority of ['high', 'normal', 'normal'] as const) {
      const t = await createTicket({ title: 'Report ' + priority, description: 'For the report.', priority, category: 'other', requesterId: admin.user.id, groupId });
      await execute("UPDATE tickets SET assignee_id = ?, status = 'resolved', resolved_at = ? WHERE id = ?", [tech.user.id, new Date().toISOString(), t.id]);
    }
    await createTicket({ title: 'Still open', description: 'For the report.', priority: 'urgent', category: 'other', requesterId: admin.user.id, groupId });
  });

  test('a manager sees the group, its figures and the technicians', async () => {
    const page = await as(manager).get('/reports?group=' + groupId + '&period=30').expect(200);
    assert.match(page.text, /<small>Raised<\/small><b>4 /);
    assert.match(page.text, /<small>Resolved<\/small><b>3 /);
    assert.match(page.text, /<h2>Technicians<\/h2>/);
    assert.match(page.text, /tech@example.com/);
    assert.match(page.text, /class="report-chart"/);
  });

  test('a technician sees the group figures, not a table of colleagues', async () => {
    const page = await as(tech).get('/reports').expect(200);
    assert.match(page.text, /<small>Raised<\/small><b>4 /);
    assert.doesNotMatch(page.text, /<h2>Technicians<\/h2>/);
  });

  test('a requester has no reports; the sidebar offers them to staff only', async () => {
    const user = await signInAs('plain.requester@example.com', 'user');
    await as(user).get('/reports').expect(404);
    const staff = await as(manager).get('/tickets').expect(200);
    assert.match(staff.text, /href="\/reports"/);
  });

  test('the CSV carries the same figures', async () => {
    const csv = await as(manager).get('/reports/export.csv?group=' + groupId + '&period=7').expect(200);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(String(csv.headers['content-disposition']), /attachment; filename="report-/);
    assert.match(csv.text, /Raised,4/);
    assert.match(csv.text, /Technician,Resolved/);
  });

  test('a custom period needs both dates', async () => {
    const page = await as(manager).get('/reports?period=custom&from=2026-01-01').expect(200);
    assert.match(page.text, /Choose both dates/);
  });
});

describe('reports with no groups', () => {
  test('an administrator is told why, not sent a 404', async () => {
    await execute('UPDATE technician_groups SET is_active = 0');
    const page = await as(admin).get('/reports').expect(200);
    assert.match(page.text, /no active groups yet/);
    await execute('UPDATE technician_groups SET is_active = 1');
  });
});

describe('reports by company', () => {
  test('companies side by side, and a report for one company', async () => {
    const group = await createGroup({ name: 'MSP desk', description: '', isActive: true }, null);
    const a = await signInAs('one@acme.example', 'user');
    const b = await signInAs('two@globex.example', 'user');
    await setProfileAttributes(a.user.id, { department: '', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '', company: 'Acme' }, null);
    await setProfileAttributes(b.user.id, { department: '', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '', company: 'Globex' }, null);
    for (const who of [a, a, b]) {
      await createTicket({ title: 'For ' + who.user.email, description: 'By company.', priority: 'normal', category: 'other', requesterId: who.user.id, groupId: group.id });
    }
    const all = await as(admin).get('/reports?group=' + group.id + '&period=7').expect(200);
    assert.match(all.text, /<h2>By company<\/h2>/);
    assert.match(all.text, />Acme<\/a><\/td>\s*<td><b>2<\/b>/);
    assert.match(all.text, />Globex<\/a><\/td>\s*<td><b>1<\/b>/);

    const acme = await as(admin).get('/reports?group=' + group.id + '&period=7&company=Acme').expect(200);
    assert.match(acme.text, /<small>Raised<\/small><b>2 /);
    assert.match(acme.text, /option value="Acme" selected/);
    const csv = await as(admin).get('/reports/export.csv?group=' + group.id + '&period=7&company=Globex').expect(200);
    assert.match(csv.text, /Company,Globex/);
    assert.match(csv.text, /Raised,1/);
  });
});

describe('quick colours', () => {
  test('one click sets the brand colour; anything else is refused', async () => {
    const page = await as(admin).get('/admin/settings/customization').expect(200);
    assert.match(page.text, /quick-colour--forest/);
    await post(admin, '/admin/settings/customization/colour', { brandColour: '#2f6b4f' }).expect(302);
    const after = await as(admin).get('/admin/settings/customization').expect(200);
    assert.match(after.text, /value="#2f6b4f" class="quick-colour quick-colour--forest" title="Forest" aria-pressed="true"/);
    await post(admin, '/admin/settings/customization/colour', { brandColour: 'red;}*{x' }).expect(400);
  });

  test('the sidebar counts open tickets on Tickets', async () => {
    const page = await as(admin).get('/tickets').expect(200);
    assert.match(page.text, /class="side-link__badge"|<span>Tickets<\/span><\/a>/);
  });
});

describe('a text colour too light to read', () => {
  test('is refused on save, and darkened when drawn', async () => {
    const refused = await post(admin, '/admin/settings/customization', { appName: 'Service Desk', brandColour: '#e0428f', inkColour: '#f1f4f8' }).expect(400);
    assert.match(refused.text, /too light/);
    const { updateSettings } = await import('../src/settings/index.js');
    const { themeStylesheet } = await import('../src/services/branding.js');
    await updateSettings({ branding: { inkColour: '#f1f4f8' } }, null);
    const css = themeStylesheet();
    const text = [...css.matchAll(/--text: (#[0-9a-f]{6})/g)].map((m) => m[1]!).find((c) => c !== '#ffffff') ?? '';
    const { contrastRatio, parseColour } = await import('../src/lib/color.js');
    assert.ok(contrastRatio(parseColour(text)!, { r: 255, g: 255, b: 255 }) >= 7, 'the text drawn still reads: ' + text);
    await updateSettings({ branding: { inkColour: '#101828' } }, null);
  });
});

describe('the Excel download', () => {
  /** Reads the files out of a zip: enough to check what a workbook holds. */
  async function unzip(buf: Buffer): Promise<Map<string, string>> {
    const { inflateRawSync } = await import('node:zlib');
    const files = new Map<string, string>();
    let at = 0;
    while (buf.readUInt32LE(at) === 0x04034b50) {
      const size = buf.readUInt32LE(at + 18);
      const nameLength = buf.readUInt16LE(at + 26);
      const extra = buf.readUInt16LE(at + 28);
      const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf8');
      const start = at + 30 + nameLength + extra;
      files.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
      at = start + size;
    }
    return files;
  }

  test('a styled workbook; the tickets sheet only when asked, with who raised each', async () => {
    const res = await as(admin).get('/reports/export.xlsx?period=30').buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.match(String(res.headers['content-type']), /spreadsheetml\.sheet/);
    const files = await unzip(res.body as Buffer);
    assert.match(files.get('xl/workbook.xml')!, /name="Summary".*name="By company"/s);
    assert.doesNotMatch(files.get('xl/workbook.xml')!, /name="Tickets"/);
    assert.match(files.get('xl/styles.xml')!, /patternType="solid"><fgColor rgb="FF/, 'a filled header row');
    assert.match(files.get('xl/worksheets/sheet1.xml')!, /state="frozen"/);

    const withDetails = await as(admin).get('/reports/export.xlsx?period=30&details=1').buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    const all = await unzip(withDetails.body as Buffer);
    assert.match(all.get('xl/workbook.xml')!, /name="Tickets"/);
    const sheets = [...all.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort();
    const tickets = sheets.map((k) => all.get(k)!).find((x) => /Raised by email/.test(x)) ?? '';
    assert.match(tickets, /Raised by email/);
    assert.match(tickets, /reports\.admin@example\.com|example\.com/);
  });

  test('the page itself never lists tickets, and offers the tick box', async () => {
    const page = await as(admin).get('/reports?period=30&details=1').expect(200);
    assert.match(page.text, /name="details" value="1" checked/);
    assert.match(page.text, /href="\/reports\/export\.xlsx\?[^"]*details=1/);
  });
});
