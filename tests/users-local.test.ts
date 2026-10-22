import './env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { createLocalAccount, verifyLocalSignIn } from '../src/auth/local-accounts.js';
import { findUserByEmail } from '../src/services/users.js';
import { parseCsv } from '../src/lib/csv.js';

let app: Express;
let admin: TestSession;

const PASSWORD = 'Correct-horse-battery-staple-1';

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

function upload(csv: string, filename = 'people.csv') {
  return as(admin)
    .post('/admin/settings/users/import')
    .field('_csrf', admin.csrfToken)
    .attach('file', Buffer.from(csv, 'utf8'), { filename, contentType: 'text/csv' });
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('users.local.admin@example.com', 'admin');
  await createLocalAccount(
    { email: 'local.person@corp.test', displayName: 'Local person', role: 'user', password: PASSWORD },
    null,
  );
});

describe('integrations', () => {
  test('one section with an Entra ID tile, opening on its two settings', async () => {
    const page = await as(admin).get('/admin/settings/integrations').expect(200);
    assert.match(page.text, /class="integration-tile"/);
    assert.match(page.text, /Microsoft Entra ID/);
    assert.match(page.text, /<svg class="entra-logo"/);

    const auth = await as(admin).get('/admin/settings/integrations/entra/authentication').expect(200);
    assert.match(auth.text, /aria-current="page">Authentication/);
    assert.match(auth.text, /href="\/admin\/settings\/integrations\/entra\/provisioning"/);
    assert.match(auth.text, /class="back-link"/);
  });

  test('the old pages move with their whole subtree', async () => {
    await as(admin)
      .get('/admin/settings/authentication')
      .expect(308)
      .expect('location', '/admin/settings/integrations/entra/authentication');
    await as(admin)
      .post('/admin/settings/provisioning')
      .type('form')
      .send({ _csrf: admin.csrfToken })
      .expect(308)
      .expect('location', '/admin/settings/integrations/entra/provisioning');
  });

  test('the sidebar has Integrations and no longer Authentication or Provisioning', async () => {
    const page = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(page.text, /settings-nav__title">Integrations</);
    assert.doesNotMatch(page.text, /settings-nav__title">(Authentication|Provisioning)</);
  });
});

describe('users tabs', () => {
  test('the Entra ID tab cannot be opened until Entra ID is connected', async () => {
    const page = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(page.text, /class="subtabs__item--disabled"[^>]*>Identity providers/);
    assert.doesNotMatch(page.text, /href="\/admin\/settings\/users\/entra"/);
    await as(admin).get('/admin/settings/users/entra').expect(302).expect('location', '/admin/settings/users');
  });

  test('local users and Entra ID accounts are listed apart', async () => {
    // SCIM switched on counts as connected.
    await updateSettings({ scim: { enabled: true } }, null);
    after(() => updateSettings({ scim: { enabled: false } }, null));
    const local = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(local.text, /aria-current="page">Local users/);
    assert.match(local.text, /local.person@corp.test/);
    assert.doesNotMatch(local.text, /users\.local\.admin@example\.com<\/div>/);

    const entra = await as(admin).get('/admin/settings/users/entra').expect(200);
    assert.match(entra.text, /aria-current="page">Identity providers/);
    assert.match(entra.text, /users\.local\.admin@example\.com/);
    assert.doesNotMatch(entra.text, /local.person@corp.test/);
    assert.doesNotMatch(entra.text, /Import from CSV/, 'directory accounts are not created here');
  });

  test('the new account form asks for an email, not a username', async () => {
    const page = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(page.text, /id="email" name="email" type="email" required/);
    assert.doesNotMatch(page.text, /name="username"/);
  });
});

describe('CSV import', () => {
  test('the template downloads as CSV with the expected columns', async () => {
    const file = await as(admin).get('/admin/settings/users/import/template.csv').expect(200);
    assert.match(String(file.headers['content-type']), /text\/csv/);
    assert.match(String(file.headers['content-disposition']), /attachment/);
    const rows = parseCsv(file.text);
    assert.deepEqual(rows[0], ['email', 'first_name', 'last_name', 'display_name', 'company', 'role', 'password', 'phone', 'department', 'job_title', 'office', 'extension_attribute_1', 'extension_attribute_2', 'extension_attribute_3']);
  });

  test('the template uploaded unchanged is refused, so nobody invents example accounts', async () => {
    const template = await as(admin).get('/admin/settings/users/import/template.csv').expect(200);
    const refused = await upload(template.text).expect(400);
    assert.match(refused.text, /replace the example row/);
    assert.match(refused.text, /dialog--open/);
  });

  test('a good sheet creates accounts that sign in by email and must change the password', async () => {
    const csv = [
      'Email;Display name;Role;Password',
      'Eva.Kral@corp.test;Eva Král;agent;',
      'tomas@corp.test;;user;' + PASSWORD,
    ].join('\r\n');
    const page = await upload(csv).expect(200);
    assert.match(page.text, /Imported 2 accounts/);
    assert.match(page.text, /Copy the generated passwords now/);

    const eva = await findUserByEmail('eva.kral@corp.test');
    assert.equal(eva?.role, 'agent');
    assert.equal(eva?.display_name, 'Eva Král');

    const tomas = await verifyLocalSignIn('tomas@corp.test', PASSWORD);
    assert.equal(tomas.mustChange, true);
    assert.equal(tomas.user.display_name, 'tomas', 'a blank name falls back to the address');
  });

  test('every attribute in the sheet is imported; an empty cell is skipped', async () => {
    const csv = [
      'email,display_name,role,password,phone,department,job_title,office,extension_attribute_1',
      'olga@corp.test,Olga,user,,+420 777 000 111,Finance,,Prague,cost-centre-12',
      'pavel@corp.test,Pavel,user,,,,,,',
    ].join('\r\n');
    await upload(csv).expect(200);
    const olga = await findUserByEmail('olga@corp.test');
    assert.equal(olga?.phone, '+420 777 000 111');
    assert.equal(olga?.department, 'Finance');
    assert.equal(olga?.job_title, '', 'an empty cell stays empty');
    assert.equal(olga?.office, 'Prague');
    assert.equal(olga?.extension_attribute_1, 'cost-centre-12');
    const pavel = await findUserByEmail('pavel@corp.test');
    assert.equal(pavel?.phone, '');
  });

  test('one bad row creates nobody, and every problem is listed', async () => {
    const csv = [
      'email,display_name,role,password',
      'fine@corp.test,Fine,user,',
      'not-an-address,Broken,user,',
      'boss@corp.test,Boss,emperor,',
    ].join('\n');
    const refused = await upload(csv).expect(400);
    assert.match(refused.text, /Nobody was imported/);
    assert.match(refused.text, /Line 3: &#34;not-an-address&#34; is not an email address/);
    assert.match(refused.text, /Line 4: the role must be user, agent or admin/);
    assert.equal(await findUserByEmail('fine@corp.test'), undefined);
  });

  test('uploading the same sheet twice skips who is already there', async () => {
    const csv = 'email,display_name\ntwice@corp.test,Twice\n';
    await upload(csv).expect(200);
    const again = await upload(csv).expect(200);
    assert.match(again.text, /Imported 0 accounts/);
    assert.match(again.text, /Already had an account, left as it is: twice@corp\.test/);
  });

  test('without the CSRF token the upload is refused', async () => {
    await as(admin)
      .post('/admin/settings/users/import')
      .attach('file', Buffer.from('email\nx@corp.test\n'), 'x.csv')
      .expect(403);
  });

  test('a sheet without an email column is refused with a pointer to the template', async () => {
    const refused = await upload('name,role\nX,user\n').expect(400);
    assert.match(refused.text, /must be &#34;email&#34;/);
  });
});

describe('switching local sign-in off', () => {
  test('is refused while Entra ID could not let an administrator in', async () => {
    await as(admin)
      .post('/admin/settings/users/local-signin')
      .type('form')
      .send({ _csrf: admin.csrfToken })
      .expect(302);
    assert.equal(settings().localAccounts.signInEnabled, true);
    const page = await as(admin).get('/admin/settings/users').expect(200);
    assert.match(page.text, /Set up an identity provider under Integrations first./);
    assert.match(page.text, />Disable sign-in with local accounts</);
  });

  test('when off, the sign-in page drops the form and a posted password is refused', async () => {
    // Set directly: the guard is covered above, and a test tenant cannot
    // make Entra ID genuinely configured.
    await updateSettings({ localAccounts: { signInEnabled: false } }, null);
    try {
      const login = await request(app).get('/login').expect(200);
      assert.doesNotMatch(login.text, /name="password"/);
      assert.doesNotMatch(login.text, /Sign in with email and password/);

      const agent = request.agent(app);
      const page = await agent.get('/login').expect(200);
      const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1] ?? '';
      await agent
        .post('/auth/local')
        .type('form')
        .send({ _csrf: csrf, email: 'admin@local', password: 'whatever' })
        .expect(403);

      const users = await as(admin).get('/admin/settings/users').expect(200);
      assert.match(users.text, /The sign-in page offers single sign-on only/);
      assert.match(users.text, />Enable sign-in with local accounts</);
    } finally {
      await updateSettings({ localAccounts: { signInEnabled: true } }, null);
    }
  });
});

describe('filtering users', () => {
  test('by role, by technician group, by user group - and the user groups column', async () => {
    const { createGroup, setMembers } = await import('../src/services/groups.js');
    const { createUserGroup, setManualMember } = await import('../src/services/user-groups.js');
    const tech = await signInAs('filter.tech@example.com', 'agent');
    const plain = await signInAs('filter.plain@example.com', 'user');
    const team = await createGroup({ name: 'Filter team', description: '', isActive: true }, null);
    await setMembers(team.id, [tech.user.id], null);
    const finance = await createUserGroup({ name: 'Filter finance', description: '', isActive: true }, null);
    await setManualMember(finance.id, plain.user.id, true, null);

    await updateSettings({ scim: { enabled: true } }, null);
    try {
      const agents = await as(admin).get('/admin/settings/users/entra?role=agent').expect(200);
      assert.match(agents.text, /filter\.tech@example\.com/);
      assert.doesNotMatch(agents.text, /filter\.plain@example\.com/);

      const inTeam = await as(admin).get('/admin/settings/users/entra?tg=' + team.id).expect(200);
      assert.match(inTeam.text, /filter\.tech@example\.com/);
      assert.doesNotMatch(inTeam.text, /filter\.plain@example\.com/);

      const inFinance = await as(admin).get('/admin/settings/users/entra?ug=' + finance.id).expect(200);
      assert.match(inFinance.text, /filter\.plain@example\.com/);
      assert.match(inFinance.text, /<th scope="col"[^>]*class="col-ugroups[^"]*">[\s\S]*?User groups/);
      assert.match(inFinance.text, />\s*Filter finance\s*</);
    } finally {
      await updateSettings({ scim: { enabled: false } }, null);
    }
  });
});
