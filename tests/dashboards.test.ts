import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { execute, query } from '../src/db/index.js';
import { flushAudit } from '../src/lib/audit.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import {
  addDays,
  availabilityData,
  designProblems,
  findDashboard,
  isoWeekday,
  renderDashboard,
  todayIn,
  DEFAULT_AVAILABILITY_OPTIONS,
} from '../src/services/dashboards.js';
import { partProblems } from '../src/services/portal.js';
import { createUserGroup, setManualMember } from '../src/services/user-groups.js';
import { findUserByEmail } from '../src/services/users.js';
import { settings } from '../src/settings/index.js';
import { ensureLocalAdmin } from '../src/auth/local-accounts.js';
import { createGroup, setMembersWithin } from '../src/services/groups.js';
import { setUsualWeek } from '../src/services/dashboards.js';
import { createTicket } from '../src/services/tickets.js';

const BASE = '/admin/settings/dashboards';
const ID = 'technician-availability';

let app: Express;
let admin: TestSession;
let agent: TestSession;
let requester: TestSession;


function as(session: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', session.cookie);
  return a;
}
function post(session: TestSession, url: string, form: Record<string, string | string[]> = {}) {
  return as(session).post(url).type('form').send({ _csrf: session.csrfToken, ...form });
}

let today = '';
let hqId = '';
let secretId = '';

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('dash.admin@example.com', 'admin');
  agent = await signInAs('dash.agent@example.com', 'agent');
  requester = await signInAs('dash.requester@example.com', 'user');
  await signInAs('dash.insider@example.com', 'user');
  today = todayIn(settings().locale.timeZone);
});

describe('settings', () => {
  test('the section opens on User dashboards, listing the availability dashboard, off', async () => {
    await as(admin).get(BASE).expect(302).expect('location', BASE + '/user');
    const page = await as(admin).get(BASE + '/user').expect(200);
    assert.match(page.text, /Technician availability/);
    assert.match(page.text, /\{\{dashboard:technician-availability\}\}/);
    assert.equal((await findDashboard(ID))?.is_enabled, false);
    await as(requester).get(BASE + '/user').expect(403);
  });

  test('locations are created in a dialog, and must say who sees them', async () => {
    const refused = await post(admin, BASE + '/locations', { name: 'Nowhere' }).expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="new-location"/);
    assert.match(refused.text, /Choose who may see it/);

    await post(admin, BASE + '/locations', { name: 'Headquarters', everyone: 'on' }).expect(302);
    const group = await createUserGroup({ name: 'Insiders', description: '', isActive: true }, null);
    const insiderUser = await findUserByEmail('dash.insider@example.com');
    await setManualMember(group.id, insiderUser!.id, true, null);
    await post(admin, BASE + '/locations', { name: 'Secret lab', groupIds: group.id }).expect(302);

    const dup = await post(admin, BASE + '/locations', { name: 'headquarters', everyone: 'on' }).expect(400);
    assert.match(dup.text, /already exists/);

    const rows = await query<{ id: string; name: string }>('SELECT id, name FROM locations ORDER BY name');
    hqId = rows.find((r) => r.name === 'Headquarters')!.id;
    secretId = rows.find((r) => r.name === 'Secret lab')!.id;
  });

  test('a custom design refuses script, inline style and unknown variables', () => {
    assert.ok(designProblems('<script>x</script>').length > 0);
    assert.ok(designProblems('<p style="color:red">x</p>').length > 0);
    assert.ok(designProblems('<p onclick="x()">x</p>').length > 0);
    assert.match(designProblems('{{nope}} {{count:mood}}').join(' '), /\{\{nope\}\}.*\{\{count:mood\}\}/);
    assert.deepEqual(designProblems('<h2>{{title}}</h2>{{today}}{{week}}{{count:vacation}}{{available_count}}'), []);
  });
});

describe('a technician states their availability', () => {
  test('the profile card appears only once the dashboard is on, and only for staff', async () => {
    const off = await as(agent).get('/profile').expect(200);
    assert.doesNotMatch(off.text, /Your availability/);
    await post(agent, '/profile/availability/week', {}).expect(403);

    await post(admin, BASE + '/user/' + ID + '/enabled', { enabled: 'on' }).expect(302);
    const on = await as(agent).get('/profile').expect(200);
    assert.match(on.text, /Your availability/);
    const user = await as(requester).get('/profile').expect(200);
    assert.doesNotMatch(user.text, /Your availability/);
    await post(requester, '/profile/availability/week', {}).expect(403);
  });

  test('the usual week and a dated entry, which wins on its day', async () => {
    const week: Record<string, string> = {};
    for (let d = 1; d <= 7; d += 1) {
      week['status_' + d] = 'office';
      week['location_' + d] = secretId;
    }
    await post(agent, '/profile/availability/week', week).expect(302);

    const data = await availabilityData({ ...DEFAULT_AVAILABILITY_OPTIONS, view: 'today' }, today);
    const mine = data.rows.find((r) => r.name.length > 0 && r.cells[0]);
    assert.equal(mine?.cells[0]?.status, 'office');

    await post(agent, '/profile/availability/entries', { startsOn: today, status: 'sick' }).expect(302);
    const after = await availabilityData({ ...DEFAULT_AVAILABILITY_OPTIONS, view: 'today' }, today);
    assert.ok(after.rows.some((r) => r.cells[0]?.status === 'sick'));

    // Refused rather than stored: a period that ended, or ends before it starts.
    await post(agent, '/profile/availability/entries', { startsOn: addDays(today, -3), endsOn: addDays(today, -2), status: 'vacation' }).expect(302);
    await post(agent, '/profile/availability/entries', { startsOn: today, endsOn: addDays(today, -1), status: 'vacation' }).expect(302);
    const rows = await query<{ c: number }>("SELECT count(*) AS c FROM availability_entries WHERE status = 'vacation'");
    assert.equal(Number(rows[0]?.c), 0);
  });
});

describe('what a requester reads', () => {
  test('a sick day is shown only as Not available, by default', async () => {
    const row = (await findDashboard(ID))!;
    const html = await renderDashboard(row, null);
    assert.match(html, /Not available/);
    assert.doesNotMatch(html, /Sick day/);
  });

  test('a location is shown only to the user groups allowed to see it', async () => {
    // Clear today's sick day so the office, and its location, show.
    await execute('DELETE FROM availability_entries', []);
    const row = (await findDashboard(ID))!;
    const outsider = await findUserByEmail('dash.requester@example.com');
    const member = await findUserByEmail('dash.insider@example.com');
    const forOutsider = await renderDashboard(row, outsider!);
    const forMember = await renderDashboard(row, member!);
    assert.match(forOutsider, /Office/);
    assert.doesNotMatch(forOutsider, /Secret lab/);
    assert.match(forMember, /Secret lab/);
    assert.ok(hqId);
  });

  test('the standard look shows it above My tickets; off, it is gone', async () => {
    const on = await as(requester).get('/tickets').expect(200);
    assert.match(on.text, /data-dashboard="technician-availability"/);
    const staff = await as(agent).get('/tickets').expect(200);
    assert.doesNotMatch(staff.text, /data-dashboard=/);

    await post(admin, BASE + '/user/' + ID + '/enabled', {}).expect(302);
    const off = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(off.text, /data-dashboard=/);
    await post(admin, BASE + '/user/' + ID + '/enabled', { enabled: 'on' }).expect(302);
  });

  test('a portal may place it with {{dashboard:<id>}}, and only a real one', () => {
    const ids = new Set([ID]);
    assert.deepEqual(partProblems('home', '{{dashboard:technician-availability}}', new Set(), 'requester', ids), []);
    assert.match(partProblems('home', '{{dashboard:nope}}', new Set(), 'requester', ids).join(' '), /does not name a dashboard/);
    assert.ok(partProblems('layout', '{{page}}{{dashboard:technician-availability}}', new Set(), 'approval', ids).length > 0);
  });

  test('a custom design fills in its variables', async () => {
    await post(admin, BASE + '/user/' + ID + '/design', {
      design: 'custom',
      html: '<p class="mine">{{available_count}} of us, {{count:office}} in the office</p>',
    }).expect(302);
    const html = await renderDashboard((await findDashboard(ID))!, null);
    assert.match(html, /<p class="mine">1 of us, 1 in the office<\/p>/);

    const refused = await post(admin, BASE + '/user/' + ID + '/design', { design: 'custom', html: '<script></script>' }).expect(400);
    assert.match(refused.text, /Scripts are not allowed/);
  });

  test('the preview is framed by our own page only, and the editor may frame it', async () => {
    const edit = await as(admin).get(BASE + '/user/' + ID).expect(200);
    assert.match(String(edit.headers['content-security-policy']), /frame-src 'self'/);
    const preview = await as(admin).get(BASE + '/user/' + ID + '/preview').expect(200);
    assert.equal(preview.headers['x-frame-options'], undefined);
    assert.match(String(preview.headers['content-security-policy']), /frame-ancestors 'self'/);
    assert.match(String(preview.headers['content-security-policy']), /script-src 'none'/);
  });

  test('week maths: Monday is 1 and Sunday 7', () => {
    assert.equal(isoWeekday('2026-10-12'), 1);
    assert.equal(isoWeekday('2026-10-18'), 7);
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  });
});

describe('an administrator sets a technician availability', () => {
  test('from the technician page under Settings - Users, audited', async () => {
    await post(admin, BASE + '/user/' + ID + '/enabled', { enabled: 'on' }).expect(302);
    const page = await as(admin).get('/admin/settings/users/' + agent.user.id).expect(200);
    assert.match(page.text, /<h2 class="section-title">Availability<\/h2>/);
    assert.match(page.text, new RegExp('action="/admin/settings/users/' + agent.user.id + '/availability/entries"'));

    await post(admin, '/admin/settings/users/' + agent.user.id + '/availability/entries', { startsOn: today, status: 'sick' })
      .expect(302)
      .expect('location', '/admin/settings/users/' + agent.user.id + '#availability');
    const rows = await query<{ status: string }>("SELECT status FROM availability_entries WHERE user_id = ? AND status = 'sick'", [agent.user.id]);
    assert.equal(rows.length, 1);
    // Audit writes are queued; wait for them rather than racing the database.
    await flushAudit();
    const audit = await query("SELECT id FROM audit_log WHERE action = 'availability.entry_added'");
    assert.equal(audit.length, 1);
  });

  test('not for a plain user, and not by a technician for somebody else', async () => {
    await post(admin, '/admin/settings/users/' + requester.user.id + '/availability/week', {}).expect(403);
    await post(agent, '/admin/settings/users/' + admin.user.id + '/availability/week', {}).expect(403);
  });
});

describe('more dashboards', () => {
  test('the list offers all four, each with its portal variable', async () => {
    const page = await as(admin).get(BASE + '/user').expect(200);
    for (const id of ['technician-availability', 'my-tickets', 'announcements', 'service-desk']) {
      assert.match(page.text, new RegExp('\{\{dashboard:' + id + '\}\}'));
    }
  });

  test('My tickets shows the reader their own, and nobody else\'s', async () => {
    await post(admin, BASE + '/user/my-tickets/enabled', { enabled: 'on' }).expect(302);
    await post(requester, '/tickets', { title: 'Mine to see', description: 'A ticket for my own dashboard.' }).expect(302);
    const mine = await renderDashboard((await findDashboard('my-tickets'))!, (await findUserByEmail('dash.requester@example.com'))!);
    assert.match(mine, /Mine to see/);
    const theirs = await renderDashboard((await findDashboard('my-tickets'))!, (await findUserByEmail('dash.insider@example.com'))!);
    assert.doesNotMatch(theirs, /Mine to see/);
    assert.match(theirs, /You have no tickets yet/);
  });

  test('Announcements: made in a dialog, shown while current, gone when there is nothing', async () => {
    await post(admin, BASE + '/user/announcements/enabled', { enabled: 'on' }).expect(302);
    const empty = await renderDashboard((await findDashboard('announcements'))!, null);
    assert.equal(empty, '', 'nothing current, nothing shown');

    const refused = await post(admin, BASE + '/user/announcements/announcements', { title: '', severity: 'info', startsOn: today }).expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="new-announcement"/);

    await post(admin, BASE + '/user/announcements/announcements', { title: 'Email is down <b>now</b>', body: 'Working on it.', severity: 'outage', startsOn: today }).expect(302);
    await post(admin, BASE + '/user/announcements/announcements', { title: 'Next week only', severity: 'info', startsOn: addDays(today, 7) }).expect(302);
    const html = await renderDashboard((await findDashboard('announcements'))!, null);
    assert.match(html, /announcement--outage/);
    assert.match(html, /Email is down &lt;b&gt;now&lt;\/b&gt;/, 'escaped');
    assert.doesNotMatch(html, /Next week only/, 'not yet current');
  });

  test('Service desk at a glance counts without naming anybody', async () => {
    const row = (await findDashboard('service-desk'))!;
    const html = await renderDashboard(row, null, { ignoreEnabled: true });
    assert.match(html, /Open now/);
    assert.match(html, /Raised today/);
    assert.doesNotMatch(html, /Mine to see/);
  });

  test('a custom design may use only its own kind\'s variables', async () => {
    assert.deepEqual(designProblems('{{open_count}} {{list}}', 'my_tickets'), []);
    assert.match(designProblems('{{today}}', 'my_tickets').join(' '), /\{\{today\}\}/);
    await post(admin, BASE + '/user/service-desk/design', { design: 'custom', html: '<p class="mine">{{open_count}} open</p>' }).expect(302);
    const html = await renderDashboard((await findDashboard('service-desk'))!, null, { ignoreEnabled: true });
    assert.match(html, /<p class="mine">\d+ open<\/p>/);
  });
});

describe('dashboards of your own', () => {
  test('a copy of availability, scoped to one technician group, lists the break-glass admin when it is a member', async () => {
    await ensureLocalAdmin();
    const breakGlass = (await query<{ id: string }>("SELECT id FROM users WHERE external_id = 'local:administrator'"))[0]!;
    const network = await createGroup({ name: 'Network team', description: '', isActive: true }, null);
    await setMembersWithin(network.id, [breakGlass.id], [breakGlass.id], null);
    await setUsualWeek(breakGlass.id, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, status: 'office' as const, locationId: null })));

    const refused = await post(admin, BASE + '/user', { name: '', kind: 'technician_availability' }).expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="new-dashboard"/);
    await post(admin, BASE + '/user', { name: 'Nonsense', kind: 'nonsense' }).expect(400);

    const made = await post(admin, BASE + '/user', { name: 'Network team availability', kind: 'technician_availability' }).expect(302);
    assert.equal(made.headers.location, BASE + '/user/network-team-availability');
    const copy = (await findDashboard('network-team-availability'))!;
    assert.equal(copy.kind, 'technician_availability');
    assert.equal(copy.is_enabled, false);

    await post(admin, BASE + '/user/network-team-availability/options', {
      view: 'week', statuses: ['office'], groupIds: [network.id],
    }).expect(302);
    await post(admin, BASE + '/user/network-team-availability/design', { design: 'standard', html: '' }).expect(302);
    const html = await renderDashboard((await findDashboard('network-team-availability'))!, null, { ignoreEnabled: true });
    const name = (await query<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', [breakGlass.id]))[0]!.display_name;
    assert.ok(html.includes(name), 'the break-glass admin is listed');
    assert.doesNotMatch(html, /Dash agent|dash\.agent/i, 'not in the group, not on this copy');

    // Copies can go; the built-in ones cannot.
    const list = await as(admin).get(BASE + '/user').expect(200);
    assert.match(list.text, /Network team availability/);
    await post(admin, BASE + '/user/technician-availability/delete').expect(409);
    await post(admin, BASE + '/user/network-team-availability/delete').expect(302);
    assert.equal(await findDashboard('network-team-availability'), undefined);
  });
});

describe('copies of the other kinds', () => {
  test('a Service desk copy counts only its technician groups', async () => {
    const team = await createGroup({ name: 'Counted team', description: '', isActive: true }, null);
    await post(admin, BASE + '/user', { name: 'Counted desk', kind: 'service_desk' }).expect(302);
    const counted = async () => {
      const html = await renderDashboard((await findDashboard('counted-desk'))!, null, { ignoreEnabled: true });
      return Number(/<span class="dashboard-stat__value">(\d+)<\/span><span class="dashboard-stat__label">Open now/.exec(html)![1]);
    };
    await post(admin, BASE + '/user/counted-desk/design', { design: 'standard', html: '' }).expect(302);
    const everything = await counted();

    const t = await createTicket({ title: 'Routed', description: 'Routed to the counted team.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    await execute('UPDATE tickets SET group_id = ? WHERE id = ?', [team.id, t.id]);
    await post(admin, BASE + '/user/counted-desk/options', { groupIds: [team.id] }).expect(302);
    assert.equal(await counted(), 1, 'only the team\'s ticket');
    assert.ok(everything >= 0);

    await post(admin, BASE + '/user/counted-desk/options', {}).expect(302);
    assert.equal(await counted(), everything + 1, 'none ticked counts everything');
  });

  test('an Announcements copy has its own notices, which go with it', async () => {
    await post(admin, BASE + '/user', { name: 'Office news', kind: 'announcements' }).expect(302);
    await post(admin, BASE + '/user/office-news/announcements', { title: 'Kitchen closed on Friday', severity: 'info', startsOn: today }).expect(302);
    const news = await renderDashboard((await findDashboard('office-news'))!, null, { ignoreEnabled: true });
    const builtIn = await renderDashboard((await findDashboard('announcements'))!, null, { ignoreEnabled: true });
    assert.match(news, /Kitchen closed on Friday/);
    assert.doesNotMatch(builtIn, /Kitchen closed on Friday/);

    await post(admin, BASE + '/user/office-news/delete').expect(302);
    assert.equal((await query("SELECT id FROM announcements WHERE dashboard_id = 'office-news'")).length, 0);
  });
});

describe('renaming a dashboard', () => {
  test('a new name, the same id; a clash or a blank is refused on the page', async () => {
    await post(admin, BASE + '/user', { name: 'Floor two', kind: 'my_tickets' }).expect(302);
    const page = await as(admin).get(BASE + '/user/floor-two').expect(200);
    assert.match(page.text, /id="dashboard-name"[^>]*value="Floor two"/);

    await post(admin, BASE + '/user/floor-two/name', { name: 'Second floor' }).expect(302);
    assert.equal((await findDashboard('floor-two'))?.name, 'Second floor', 'the id portals use stays');

    const blank = await post(admin, BASE + '/user/floor-two/name', { name: '  ' }).expect(400);
    assert.match(blank.text, /Name the dashboard/);
    const taken = (await findDashboard('my-tickets'))!.name.toUpperCase();
    const clash = await post(admin, BASE + '/user/floor-two/name', { name: taken }).expect(400);
    assert.match(clash.text, /already exists/);
    assert.equal((await findDashboard('floor-two'))?.name, 'Second floor');

    // A built-in can be renamed too: the name is only its title.
    await post(admin, BASE + '/user/' + ID + '/name', { name: 'Who is in today' }).expect(302);
    assert.equal((await findDashboard(ID))?.name, 'Who is in today');
  });
});
