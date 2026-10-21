import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { updateSettings } from '../src/settings/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;

const SECTIONS = ['integrations', 'customization'];

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('settings.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);
});

describe('settings structure', () => {
  test('every section has its own page', async () => {
    for (const section of SECTIONS) {
      const page = await adminAgent.get('/admin/settings/' + section).expect(200);
      // Each page shows the sidebar with every section linked.
      for (const other of SECTIONS) {
        assert.match(
          page.text,
          new RegExp('/admin/settings/' + other),
          section + ' should link to ' + other,
        );
      }
    }
  });

  test('the index redirects to the first section', async () => {
    await adminAgent
      .get('/admin/settings')
      .expect(302)
      .expect('location', '/admin/settings/integrations');
  });

  test('the current section is marked in the sidebar', async () => {
    const page = await adminAgent.get('/admin/settings/customization').expect(200);
    assert.match(page.text, /settings-nav__item--current/);
    assert.match(page.text, /aria-current=page/);
  });

  test('an unknown section is a 404, not a render error', async () => {
    await adminAgent.get('/admin/settings/nonsense').expect(404);
  });

  test('a non-admin cannot reach any section', async () => {
    const session = await signInAs('settings.user@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);
    for (const section of SECTIONS) {
      await agent.get('/admin/settings/' + section).expect(403);
    }
  });
});

describe('OpenID Connect is the only sign-in method', () => {
  test('the authentication page offers no method to choose', async () => {
    const page = await adminAgent.get('/admin/settings/integrations/entra/authentication').expect(200);

    assert.match(page.text, /name="tenantId"/);
    assert.match(page.text, /name="clientId"/);
    assert.match(page.text, /name="clientSecret"/);
    assert.doesNotMatch(page.text, /name="authMode"/, "there is nothing to switch");
  });

  test('no SAML field or form survives anywhere on it', async () => {
    const page = await adminAgent.get('/admin/settings/integrations/entra/authentication').expect(200);

    for (const field of [
      'entryPoint',
      'idpIssuer',
      'idpCertificates',
      'spEntityId',
      'spPrivateKey',
      'spCertificate',
    ]) {
      assert.doesNotMatch(
        page.text,
        new RegExp('name="' + field + '"'),
        'SAML field ' + field + ' must be gone',
      );
    }
    assert.doesNotMatch(page.text, /action="\/admin\/settings\/saml"/);
    assert.doesNotMatch(page.text, /SAML/i);
  });

  test('the method and SAML endpoints are gone, not merely unlinked', async () => {
    await adminAgent
      .post('/admin/settings/method')
      .type('form')
      .send({ _csrf: admin.csrfToken, authMode: 'saml' })
      .expect(404);

    await adminAgent
      .post('/admin/settings/saml')
      .type('form')
      .send({ _csrf: admin.csrfToken, entryPoint: 'https://evil.test/sso' })
      .expect(404);
  });

  test('the directory-sync section is gone', async () => {
    await adminAgent.get('/admin/settings/sync').expect(404);
    // Kept as a redirect rather than a 404, so an old bookmark still lands somewhere.
    await adminAgent.get('/admin/sync').expect(308);
  });

  test('it shows the redirect URI and no SAML URLs', async () => {
    const page = await adminAgent.get('/admin/settings/integrations/entra/authentication').expect(200);
    assert.match(page.text, /auth\/oidc\/callback/);
    assert.doesNotMatch(page.text, /Reply URL \(ACS\)/);
    assert.doesNotMatch(page.text, /saml\/metadata/);
  });
});

describe('roles are assigned in the application, not during provisioning', () => {
  test('the provisioning page offers no role mapping', async () => {
    const page = await adminAgent.get('/admin/settings/integrations/entra/provisioning').expect(200);

    for (const field of [
      'adminGroups',
      'agentGroups',
      'adminAppRoles',
      'agentAppRoles',
      'defaultRole',
      'bootstrapAdminEmails',
    ]) {
      assert.doesNotMatch(
        page.text,
        new RegExp('name="' + field + '"'),
        field + ' must no longer be configurable',
      );
    }
  });

  test('it offers the SCIM endpoint instead', async () => {
    const page = await adminAgent.get('/admin/settings/integrations/entra/provisioning').expect(200);
    assert.match(page.text, /\/scim\/v2/);
    assert.match(page.text, /name="scimEnabled"/);
    assert.match(page.text, /name="jitEnabled"/);
  });

  test('the users page is where roles are set', async () => {
    const page = await adminAgent.get('/admin/settings/users').expect(200);
    // The one explanation worth keeping on this page: nothing else says that
    // an Entra group does not grant a role, and an administrator would
    // reasonably assume it did.
    assert.match(page.text, /Roles are set here and nowhere else/i);
    // Worded for any identity provider, not only Entra ID.
    assert.match(page.text, /Groups and roles from your\s+identity provider are ignored/i);
    assert.doesNotMatch(page.text, /name="lock"/, "there is no role lock any more");
  });
});
describe('the application no longer ships an invented logo', () => {
  test('there are no bundled brand assets', async () => {
    // These used to be shipped in public/. Branding is uploaded now, so a
    // request for them must not find anything.
    await request(app).get('/assets/logo.svg').expect(404);
    await request(app).get('/assets/favicon.svg').expect(404);
  });

  test('with no logo uploaded, the name is shown instead', async () => {
    await updateSettings({ branding: { logo: null, appName: 'Plain Name Desk' } }, null);

    const login = await request(app).get('/login').expect(200);
    assert.match(login.text, /Plain Name Desk/);
    assert.doesNotMatch(login.text, /branding\/logo/);

    const page = await adminAgent.get('/tickets').expect(200);
    assert.match(page.text, /brand__name/);
    assert.doesNotMatch(page.text, /brand__logo/);
  });
});

describe('the profile page', () => {
  test('shows a directory account its own details and no password form', async () => {
    const session = await signInAs('profile.user@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    const page = await agent.get('/profile').expect(200);
    assert.match(page.text, /profile\.user@example\.com/);
    assert.match(page.text, /Directory account/);
    assert.match(page.text, /managed by your organisation/i);
    assert.doesNotMatch(page.text, /name="currentPassword"/);
  });

  test('is reachable from the header and requires sign-in', async () => {
    const page = await adminAgent.get('/tickets').expect(200);
    assert.match(page.text, /href="\/profile"/);

    await request(app).get('/profile').expect(302).expect('location', /^\/login/);
  });

  test('refuses a password change for a directory account', async () => {
    const session = await signInAs('profile.nopass@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    await agent
      .post('/profile/password')
      .type('form')
      .send({
        _csrf: session.csrfToken,
        currentPassword: 'whatever',
        newPassword: 'A long enough replacement-1',
        confirmPassword: 'A long enough replacement-1',
      })
      .expect(403);
  });

  test('shows the viewer their own ticket counts', async () => {
    const session = await signInAs('profile.counts@example.com', 'user');
    const agent = request.agent(app);
    agent.set('Cookie', session.cookie);

    const form = await agent.get('/tickets/new').expect(200);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(form.text)?.[1];
    assert.ok(csrf);
    await agent
      .post('/tickets')
      .type('form')
      .send({
        _csrf: csrf,
        title: 'A ticket for the profile count',
        description: 'Long enough description to pass validation checks here.',
        priority: 'normal',
        category: 'other',
      })
      .expect(302);

    const page = await agent.get('/profile').expect(200);
    assert.match(page.text, /Raised, all time/);
    assert.match(page.text, /stat__value">1</);
  });
});

describe('the pages that moved under Settings', () => {
  // The first version of these redirects matched only the exact section path,
  // which left /admin/templates/new and every /admin/users/{id}/... as a 404.
  test('a section root redirects', async () => {
    const moved: [string, string][] = [
      ['/admin/users', '/admin/settings/users'],
      ['/admin/accounts', '/admin/settings/users'],
      ['/admin/templates', '/admin/settings/templates'],
      ['/admin/audit', '/admin/settings/audit'],
      ['/admin/sync', '/admin/settings/integrations/entra/provisioning'],
    ];
    for (const [from, to] of moved) {
      await adminAgent.get(from).expect(308).expect('location', to);
    }
  });

  test('and so does everything beneath it, keeping the rest of the path', async () => {
    const moved: [string, string][] = [
      ['/admin/templates/new', '/admin/settings/templates/new'],
      ['/admin/users/abc-123/role', '/admin/settings/users/abc-123/role'],
      ['/admin/accounts/abc-123/password', '/admin/settings/users/abc-123/password'],
    ];
    for (const [from, to] of moved) {
      await adminAgent.get(from).expect(308).expect('location', to);
    }
  });

  test('a query string survives', async () => {
    await adminAgent
      .get('/admin/users?q=dana&page=2')
      .expect(308)
      .expect('location', '/admin/settings/users?q=dana&page=2');
  });

  test('the redirect actually lands on a page, not another 404', async () => {
    const page = await adminAgent.get('/admin/settings/templates/new').expect(200);
    assert.match(page.text, /New template/);
  });

  test('an admin path that never existed is still a 404', async () => {
    await adminAgent.get('/admin/nonsense').expect(404);
  });
});

describe('internal links use the current URLs', () => {
  // The redirects exist for bookmarks, not for the application's own markup.
  // A page that links to its own old URL still works, which is exactly why it
  // goes unnoticed until someone reads the network tab.
  const OLD = /(href|action)="\/admin\/(users|accounts|templates|audit|sync)(\/|"|\?)/;

  test('no settings page links to a moved URL', async () => {
    for (const section of [
      'integrations',
      'integrations/entra/authentication',
      'integrations/entra/provisioning',
      'users',
      'groups',
      'templates',
      'templates/categories',
      'customization',
      'customization/attachments',
      'customization/portal',
      'advanced/javascript',
      'audit',
    ]) {
      const page = await adminAgent.get('/admin/settings/' + section).expect(200);
      assert.doesNotMatch(page.text, OLD, section + ' links to a moved URL');
    }
  });

  test('nor does the template form', async () => {
    const page = await adminAgent.get('/admin/settings/templates/new').expect(200);
    assert.doesNotMatch(page.text, OLD);
  });
});

describe('the house style holds across the settings pages', () => {
  /** The four list pages, each of which creates something. */
  const LISTS = [
    { path: '/admin/settings/templates', creates: 'New template' },
    { path: '/admin/settings/templates/categories', creates: 'New category' },
    { path: '/admin/settings/groups', creates: 'New group' },
    { path: '/admin/settings/users', creates: 'New user' },
  ];

  test('every list page creates through the same button', async () => {
    // Reported as "New template button is different colour and style than
    // new category". One page had a filled primary button, the next three
    // plain ones in Title Case, and the two read as different products.
    for (const list of LISTS) {
      const page = await adminAgent.get(list.path).expect(200);

      const button = new RegExp(
        '<a class="btn btn--primary"[^>]*>\\s*<span aria-hidden="true">\\+</span>\\s*' +
          list.creates,
      );
      assert.match(page.text, button, list.path + ' should offer ' + list.creates);
    }
  });

  test('labels are sentence case, not Title Case', async () => {
    for (const list of LISTS) {
      const page = await adminAgent.get(list.path).expect(200);
      // Inside a button or a dialog heading, a capitalised second word is
      // the Title Case that made these pages look unrelated.
      const titleCased = /(New|Save and add) [A-Z][a-z]+ [A-Z][a-z]+/.exec(page.text);
      assert.equal(
        titleCased,
        null,
        list.path + ' has a Title Case label: ' + (titleCased?.[0] ?? ''),
      );
    }
  });

  test('a settings page does not explain where its defaults came from', async () => {
    for (const section of SECTIONS) {
      const page = await adminAgent.get('/admin/settings/' + section).expect(200);
      assert.doesNotMatch(
        page.text,
        /Using the values from the environment/,
        'that described a deployment detail, not anything about the screen',
      );
    }
  });

  test('tick boxes are drawn from the theme, not left as the browser blue', async () => {
    const css = await adminAgent.get('/assets/css/app.css').expect(200);

    // Drawn: the native control is replaced and the tick is ours.
    assert.match(css.text, /input\[type='checkbox'\],\s*\n\s*input\[type='radio'\] \{[^}]*appearance: none/);
    assert.match(css.text, /input\[type='checkbox'\]:checked \{[^}]*background-color: var\(--brand\)/);

    // ...and still coloured from the theme for a browser that ignores
    // `appearance: none`, which then shows its own control rather than an
    // empty square.
    assert.match(css.text, /accent-color:\s*var\(--brand\)/);
    assert.doesNotMatch(css.text, /accent-color:\s*(auto|revert)/);
  });
});
