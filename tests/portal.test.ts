import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import {
  adoptCurrentStarter,
  listPortals,
  OLD_STARTER_LAYOUT,
  setDefaultPortal,
  defaultPortal,
  composePortal,
  createPortal,
  findPortal,
  partProblems,
  portalForUser,
  STANDARD_PORTAL,
  type PortalContext,
} from '../src/services/portal.js';
import { createUserGroup, setManualMember } from '../src/services/user-groups.js';
import { execute } from '../src/db/index.js';
import { loadSettings, updateSettings } from '../src/settings/index.js';

const BASE = '/admin/settings/customization/portal';

let app: Express;
let admin: TestSession;
let requester: TestSession;
let agentUser: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

function post(session: TestSession, url: string, form: Record<string, string> = {}) {
  return as(session)
    .post(url)
    .type('form')
    .send({ _csrf: session.csrfToken, ...form });
}

/** Creates a portal through the dialog and returns its id. */
async function newPortal(name: string): Promise<string> {
  const response = await post(admin, BASE, { name }).expect(302);
  const id = /\/portal\/([^/?#]+)$/.exec(response.headers.location ?? '')?.[1];
  assert.ok(id, 'redirected to the new portal: ' + response.headers.location);
  return id;
}

function savePart(id: string, part: string, code: string) {
  return post(admin, BASE + '/' + id + '/parts/' + part, { code });
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('portal.admin@example.com', 'admin');
  requester = await signInAs('portal.requester@example.com', 'user');
  agentUser = await signInAs('portal.agent@example.com', 'agent');
});

describe('customisation tabs', () => {
  test('attachments live under customisation, and the old URL moves with its subtree', async () => {
    const page = await as(admin).get('/admin/settings/customization/attachments').expect(200);
    assert.match(page.text, /action="\/admin\/settings\/customization\/attachments"/);
    assert.match(page.text, /href="\/admin\/settings\/customization\/portal"/);

    await as(admin)
      .get('/admin/settings/attachments?x=1')
      .expect(308)
      .expect('location', '/admin/settings/customization/attachments?x=1');
  });

  test('the sidebar no longer lists attachments as a section', async () => {
    const page = await as(admin).get('/admin/settings/customization').expect(200);
    assert.doesNotMatch(page.text, /settings-nav__item[^"]*"[^>]*>\s*<span class="settings-nav__title">Attachments/);
    assert.doesNotMatch(page.text, /href="\/admin\/settings\/attachments"/);
  });

  test('an out-of-range attachment limit is refused on the page, not as an error page', async () => {
    const response = await post(admin, '/admin/settings/customization/attachments', {
      maxMegabytes: '500',
      maxPerTicket: '5',
    }).expect(400);
    assert.match(response.text, /between 0\.1 and 100 MB/);
    assert.match(response.text, /settings-nav/);
  });

  test('attachment limits still save', async () => {
    await post(admin, '/admin/settings/customization/attachments', {
      enabled: 'on',
      maxMegabytes: '12',
      maxPerTicket: '7',
    })
      .expect(302)
      .expect('location', '/admin/settings/customization/attachments');
  });

  test('a current tab is marked with a real attribute, not an escaped one', async () => {
    const page = await as(admin).get('/admin/settings/customization/portal').expect(200);
    assert.match(page.text, /aria-current="page">Requester portal/);
    assert.doesNotMatch(page.text, /aria-current=&#34;/);
  });
});

describe('the standard portal', () => {
  test('is listed, active by default, and cannot be removed', async () => {
    const page = await as(admin).get(BASE).expect(200);
    assert.match(page.text, /Standard/);
    assert.match(page.text, /Built in/);
    assert.equal(await defaultPortal(), undefined);

    await post(admin, BASE + '/standard/delete').expect(302);
    const after = await as(admin).get(BASE).expect(200);
    assert.match(after.text, /built in and cannot be removed/);
  });

  test('has no editor', async () => {
    await as(admin).get(BASE + '/standard').expect(302).expect('location', BASE);
  });

  test('a requester with no portal active sees the built-in masthead', async () => {
    const page = await as(requester).get('/tickets').expect(200);
    assert.match(page.text, /class="shell"/);
    assert.doesNotMatch(page.text, /\/portal\/[^/]+\/theme\.css/);
  });

  test('/home falls through to My tickets when no portal has a home page', async () => {
    await as(requester).get('/home').expect(302).expect('location', '/tickets');
  });
});

describe('editing a portal', () => {
  test('a new portal starts from a working layout and a home page', async () => {
    const id = await newPortal('Starter check');
    const portal = await findPortal(id);
    assert.ok(portal);
    assert.match(portal.layout_html, /\{\{page\}\}/);
    assert.match(portal.pages.home ?? '', /\{\{button_new_ticket\}\}/);
    assert.equal(portal.is_active, false);
  });

  test('a duplicate name is refused in the dialog', async () => {
    await newPortal('Twice');
    const response = await post(admin, BASE, { name: 'twice' }).expect(400);
    assert.match(response.text, /dialog--open/);
    assert.match(response.text, /already exists/);
  });

  test('the editor is split between code and a framed preview', async () => {
    const id = await newPortal('Split view');
    const page = await as(admin).get(BASE + '/' + id + '?part=new').expect(200);
    assert.match(page.text, /<textarea id="portal-code"/);
    assert.match(page.text, /<iframe class="portal-editor__frame[^"]*"[^>]*src="\/tickets\/new\?portalFrame=/);
    assert.match(page.text, /sandbox="allow-same-origin"/);
    // The editor page itself may frame our own pages, and nothing else.
    assert.match(String(page.headers['content-security-policy']), /frame-src 'self'/);
  });

  test('a layout without {{page}} is refused, and what was typed comes back', async () => {
    const id = await newPortal('No page slot');
    const response = await savePart(id, 'layout', '<header>Hello there</header>').expect(400);
    assert.match(response.text, /\{\{page\}\} exactly once/);
    assert.match(response.text, /Hello there/);
  });

  test('script, inline handlers and inline styles are refused', async () => {
    const id = await newPortal('Unsafe');
    for (const html of [
      '{{content}}<script>alert(1)</script>',
      '{{content}}<a href="/" onclick="x()">x</a>',
      '{{content}}<div style="color:red">x</div>',
    ]) {
      await savePart(id, 'tickets', html).expect(400);
    }
    const portal = await findPortal(id);
    assert.equal(portal?.pages.tickets, undefined, 'nothing was stored');
  });

  test('a page that would hide its own content is refused', async () => {
    const id = await newPortal('Lost content');
    const response = await savePart(id, 'new', '<h1>Raise a ticket</h1>').expect(400);
    assert.match(response.text, /needs \{\{content\}\}/);
  });

  test('an unknown variable, or a template that does not exist, is refused', async () => {
    const id = await newPortal('Typos');
    const unknown = await savePart(id, 'home', '{{button_new_tiket}}').expect(400);
    assert.match(unknown.text, /Not a variable this portal knows/);
    const missing = await savePart(id, 'home', '{{button_template:nope}}').expect(400);
    assert.match(missing.text, /does not name an active template/);
  });

  test('saving keeps the editor on the same part', async () => {
    const id = await newPortal('Saves');
    await savePart(id, 'css', '.marker-css { color: red; }')
      .expect(302)
      .expect('location', BASE + '/' + id + '?part=css#editor');
    const portal = await findPortal(id);
    assert.equal(portal?.css, '.marker-css { color: red; }');
  });
});

describe('what a requester sees', () => {
  let id: string;

  before(async () => {
    id = await newPortal('Live portal');
    await savePart(id, 'layout', '<div class="marker-layout">{{nav}}</div>{{page}}<p>{{user_name}}</p>').expect(302);
    await savePart(id, 'tickets', '<h2 class="marker-tickets">{{page_title}}</h2>{{content}}').expect(302);
    await savePart(id, 'home', '<h1 class="marker-home">Hi</h1>{{button_new_ticket}}').expect(302);
    await savePart(id, 'css', '.marker-css { color: red; }').expect(302);
    await post(admin, BASE + '/' + id + '/default').expect(302);
  });

  test('requesters get the active portal around the real page', async () => {
    const page = await as(requester).get('/tickets').expect(200);
    assert.match(page.text, /class="marker-layout"/);
    assert.match(page.text, /class="marker-tickets">My tickets</);
    assert.match(page.text, /<main id="main"/, 'the page itself is still there');
    assert.doesNotMatch(page.text, /class="shell"/);
    assert.match(page.text, /portal\.requester@example\.com/);
  });

  test('the portal stylesheet is linked and served', async () => {
    const page = await as(requester).get('/tickets').expect(200);
    const href = /href="(\/portal\/[^"]+\/theme\.css\?v=[^"]+)"/.exec(page.text)?.[1];
    assert.ok(href);
    const css = await as(requester).get(href.replace(/&amp;/g, '&')).expect(200);
    assert.match(String(css.headers['content-type']), /text\/css/);
    assert.match(css.text, /marker-css/);
  });

  test('pages with no HTML of their own still sit inside the layout', async () => {
    const page = await as(requester).get('/tickets/new').expect(200);
    assert.match(page.text, /class="marker-layout"/);
    assert.match(page.text, /name="title"|<form/);
  });

  test('the home page is the portal one, and / leads to it', async () => {
    await as(requester).get('/').expect(302).expect('location', '/home');
    const home = await as(requester).get('/home').expect(200);
    assert.match(home.text, /class="marker-home"/);
    assert.match(home.text, /<a class="btn portal-button portal-button--new_ticket" href="\/tickets\/new">/);
  });

  test('staff keep the built-in look', async () => {
    for (const session of [agentUser, admin]) {
      const page = await as(session).get('/tickets').expect(200);
      assert.match(page.text, /class="shell"/);
      assert.doesNotMatch(page.text, /marker-layout/);
    }
  });

  test('values inserted by variables are escaped', async () => {
    const hostile = await signInAs('<img src=x onerror=alert(1)>@example.com', 'user');
    const page = await as(hostile).get('/tickets').expect(200);
    assert.doesNotMatch(page.text, /<img src=x onerror/);
  });

  test('an active portal cannot be removed', async () => {
    await post(admin, BASE + '/' + id + '/delete').expect(302);
    assert.ok(await findPortal(id));
  });

  test('switching back to standard takes the portal away from requesters', async () => {
    await post(admin, BASE + '/standard/default').expect(302);
    const page = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(page.text, /marker-layout/);
    await post(admin, BASE + '/' + id + '/default').expect(302);
  });
});

describe('previews', () => {
  test('the editor frame may be framed by our own page, and only for an administrator', async () => {
    const id = await newPortal('Framed');
    const framed = await as(admin).get('/tickets?portalFrame=' + id).expect(200);
    assert.equal(framed.headers['x-frame-options'], undefined);
    assert.match(String(framed.headers['content-security-policy']), /frame-ancestors 'self'/);
    assert.match(framed.text, /<body class="portal-frame">/);
    assert.match(String(framed.headers['content-security-policy']), /script-src 'none'/);

    // A requester cannot use the parameter to get a framable page.
    const notFramed = await as(requester).get('/tickets?portalFrame=' + id).expect(200);
    assert.equal(notFramed.headers['x-frame-options'], 'DENY');
    assert.match(String(notFramed.headers['content-security-policy']), /frame-ancestors 'none'/);
  });

  test('a full-screen preview themes the real pages for that administrator until they leave', async () => {
    const id = await newPortal('Full screen');
    await savePart(id, 'layout', '<div class="marker-preview">{{page}}</div>').expect(302);

    const agent = as(admin);
    await agent
      .post(BASE + '/' + id + '/preview')
      .type('form')
      .send({ _csrf: admin.csrfToken })
      .expect(302)
      .expect('location', '/home');

    const page = await agent.get('/tickets').expect(200);
    assert.match(page.text, /class="marker-preview"/);
    assert.match(page.text, /portal-preview-bar/);
    assert.match(page.text, /Back to editor/);

    // Nobody else is affected.
    const other = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(other.text, /marker-preview/);

    await agent
      .post(BASE + '/preview/exit')
      .type('form')
      .send({ _csrf: admin.csrfToken })
      .expect(302)
      .expect('location', BASE + '/' + id);
    const after = await agent.get('/tickets').expect(200);
    assert.doesNotMatch(after.text, /marker-preview/);
  });

  test('previewing the standard portal is allowed too', async () => {
    await post(admin, BASE + '/standard/preview').expect(302);
    await post(admin, BASE + '/preview/exit').expect(302).expect('location', BASE);
  });
});

describe('composition', () => {
  const ctx: PortalContext = {
    appName: 'Desk',
    logoUrl: null,
    userName: 'Jan',
    userEmail: 'jan@example.com',
    pageTitle: 'Home',
    currentPath: '/home',
    csrfToken: 't',
    templates: new Map([['tpl-1', 'Laptop <request>']]),
  };

  test('dollar signs in the HTML are kept as written', async () => {
    const portal = await createPortal('Dollars', null);
    portal.layout_html = '<p>$& $1 $\'</p>{{page}}';
    const { head } = composePortal(portal, 'tickets', ctx);
    assert.match(head, /\$& \$1 \$'/);
  });

  test('a template button names the template, escaped', async () => {
    const portal = await createPortal('Template buttons', null);
    portal.layout_html = '{{page}}';
    portal.pages = { home: '{{button_template:tpl-1}}' };
    const { head } = composePortal(portal, 'home', ctx);
    assert.match(head, /href="\/tickets\/new\?template=tpl-1">Laptop &lt;request&gt;<\/a>/);
  });

  test('partProblems accepts the starter portal as it is', async () => {
    const portal = await createPortal('Starter valid', null);
    const none = new Set<string>();
    assert.deepEqual(partProblems('layout', portal.layout_html, none), []);
    assert.deepEqual(partProblems('home', portal.pages.home ?? '', none), []);
    assert.deepEqual(partProblems('css', portal.css, none), []);
  });

  test('setting the default moves the flag rather than adding a second one', async () => {
    const a = await createPortal('Flag A', null);
    const b = await createPortal('Flag B', null);
    await setDefaultPortal(a.id, null);
    await setDefaultPortal(b.id, null);
    assert.equal((await findPortal(a.id))?.is_active, false);
    assert.equal((await defaultPortal())?.id, b.id);
    await setDefaultPortal(STANDARD_PORTAL, null);
    assert.equal(await defaultPortal(), undefined);
  });
});

describe('assigning a portal to user groups', () => {
  let finance: { id: string };
  let member: TestSession;
  let outsider: TestSession;
  let financePortal: string;

  before(async () => {
    await setDefaultPortal(STANDARD_PORTAL, null);
    finance = await createUserGroup({ name: 'Finance', description: '', isActive: true }, null);
    member = await signInAs('portal.finance@example.com', 'user');
    outsider = await signInAs('portal.outsider@example.com', 'user');
    await setManualMember(finance.id, member.user.id, true, null);

    financePortal = await newPortal('Finance portal');
    await savePart(financePortal, 'layout', '<div class="marker-finance">{{page}}</div>').expect(302);
    await savePart(financePortal, 'css', '.marker-finance-css {}').expect(302);
  });

  test('the list says Set default and offers group assignment, with no second create button', async () => {
    const page = await as(admin).get(BASE).expect(200);
    assert.match(page.text, />\s*Set default\s*</);
    assert.match(page.text, /Assign to groups/);
    assert.match(page.text, /id="groups-standard"/);
    assert.match(page.text, /name="groups" value="[^"]+"/);
    assert.doesNotMatch(page.text, /Make active|Start a new portal/);
  });

  test('members of an assigned group see that portal; nobody else does', async () => {
    await post(admin, BASE + '/' + financePortal + '/groups', { groups: finance.id })
      .expect(302)
      .expect('location', BASE);

    const mine = await as(member).get('/tickets').expect(200);
    assert.match(mine.text, /class="marker-finance"/);

    const theirs = await as(outsider).get('/tickets').expect(200);
    assert.doesNotMatch(theirs.text, /marker-finance/);
    assert.match(theirs.text, /class="shell"/);

    const list = await as(admin).get(BASE).expect(200);
    assert.match(list.text, /<div class="small">Finance<\/div>/);
  });

  test('a requester may fetch only the stylesheet of the portal they are shown', async () => {
    const href = '/portal/' + financePortal + '/theme.css';
    await as(member).get(href).expect(200);
    await as(outsider).get(href).expect(404);
  });

  test('a group assigned elsewhere moves, rather than following two portals', async () => {
    const other = await newPortal('Other portal');
    await post(admin, BASE + '/' + other + '/groups', { groups: finance.id }).expect(302);
    assert.equal((await portalForUser(member.user.id))?.id, other);

    const list = await as(admin).get(BASE).expect(200);
    assert.match(list.text, /\(now Other portal - ticking moves it\)/);

    await post(admin, BASE + '/' + financePortal + '/groups', { groups: finance.id }).expect(302);
    assert.equal((await portalForUser(member.user.id))?.id, financePortal);
  });

  test('a group can be held on the standard portal while the default is custom', async () => {
    await post(admin, BASE + '/' + financePortal + '/default').expect(302);
    const custom = await newPortal('Everyone else');
    await post(admin, BASE + '/' + custom + '/default').expect(302);

    await post(admin, BASE + '/standard/groups', { groups: finance.id }).expect(302);
    const mine = await as(member).get('/tickets').expect(200);
    assert.match(mine.text, /class="shell"/);
    assert.equal((await portalForUser(outsider.user.id))?.id, custom);

    await setDefaultPortal(STANDARD_PORTAL, null);
  });

  test('unticking every group sends them back to the default', async () => {
    await post(admin, BASE + '/standard/groups', {}).expect(302);
    assert.equal(await portalForUser(member.user.id), undefined);
  });

  test('the editor offers group assignment and warns when a group sees the portal', async () => {
    await post(admin, BASE + '/' + financePortal + '/groups', { groups: finance.id }).expect(302);
    const page = await as(admin).get(BASE + '/' + financePortal).expect(200);
    assert.match(page.text, /href="\/admin\/settings\/customization\/portal#groups-/);
    assert.match(page.text, /Requesters are using this portal/);
    assert.match(page.text, /1 group</);
  });

  test('removing an assigned portal returns its groups to the default', async () => {
    const response = await post(admin, BASE + '/' + financePortal + '/delete').expect(302);
    assert.equal(response.headers.location, BASE);
    assert.equal(await findPortal(financePortal), undefined);
    assert.equal(await portalForUser(member.user.id), undefined);
  });

  test('an unknown group is refused without changing anything', async () => {
    const id = await newPortal('Bad group');
    await post(admin, BASE + '/' + id + '/groups', { groups: 'no-such-group' }).expect(302);
    const list = await as(admin).get(BASE).expect(200);
    assert.match(list.text, /no longer exists/);
  });
});

describe('a custom portal is styled by itself alone', () => {
  test('its pages do not load the Appearance colours', async () => {
    const id = await newPortal('Independent');
    await post(admin, BASE + '/' + id + '/default').expect(302);
    try {
      const page = await as(requester).get('/tickets').expect(200);
      assert.doesNotMatch(page.text, /\/branding\/theme\.css/);
      assert.match(page.text, /\/portal\/[^/]+\/theme\.css/);

      // The built-in look still has them.
      const staff = await as(admin).get('/tickets').expect(200);
      assert.match(staff.text, /\/branding\/theme\.css/);
    } finally {
      await post(admin, BASE + '/standard/default').expect(302);
    }
  });

  test('a new portal starts with its own colours', async () => {
    const id = await newPortal('Own colours');
    const portal = await findPortal(id);
    assert.match(portal?.css ?? '', /:root \{\s*--brand:/);
  });
});

describe('seeing the HTML while editing', () => {
  test('an empty page part shows {{content}}; the page HTML sits under the code, the right side is preview only', async () => {
    const id = await newPortal('Shows HTML');
    const page = await as(admin).get(BASE + '/' + id + '?part=tickets').expect(200);
    assert.match(page.text, /<textarea id="portal-code"[^>]*>\{\{content\}\}<\/textarea>/);
    assert.doesNotMatch(page.text, /id="view-html"/, 'no Preview / HTML switch');
    assert.match(page.text, /<details class="portal-source">/);
    assert.ok(page.text.includes('src="/tickets?portalFrame=' + id + '&amp;source=1"'));
    // The editor is a settings page, not a page dressed in the portal it edits.
    assert.match(page.text, /<aside class="sidebar"/);
    assert.doesNotMatch(page.text, /<link rel="stylesheet" href="">/);
  });

  test('the two sign-in steps have parts of their own, and fall back to Sign-in', async () => {
    const id = await newPortal('Sign-in steps');
    const editor = await as(admin).get(BASE + '/' + id + '?part=login_code').expect(200);
    assert.match(editor.text, />Sign-in code</);
    assert.match(editor.text, /src="\/login\/code\?portalFrame=/);

    await savePart(id, 'login', '<div class="marker-signin">{{content}}</div>').expect(302);
    const framed = await as(admin).get('/login/code?portalFrame=' + id).expect(200);
    assert.match(framed.text, /marker-signin/, 'a blank step uses the Sign-in part');
    assert.match(framed.text, /Enter your code/);

    await savePart(id, 'login_code', '<div class="marker-code">{{content}}</div>').expect(302);
    const own = await as(admin).get('/login/code?portalFrame=' + id).expect(200);
    assert.match(own.text, /marker-code/);
    assert.doesNotMatch(own.text, /marker-signin/);
  });

  test('the source view returns the page markup as text, for an administrator only', async () => {
    const id = await newPortal('Source view');
    const source = await as(admin).get('/tickets?portalFrame=' + id + '&source=1').expect(200);
    assert.match(String(source.headers['content-type']), /text\/plain/);
    assert.match(source.text, /<main id="main"/);
    const asRequester = await as(requester).get('/tickets?portalFrame=' + id + '&source=1').expect(200);
    assert.match(String(asRequester.headers['content-type']), /text\/html/);
  });
});

describe('the sign-in page in the portal', () => {
  test('signed out, /login is drawn in the default portal, with the real form inside', async () => {
    const id = await newPortal('Sign-in look');
    await savePart(id, 'login', '<div class="marker-login">{{content}}</div>').expect(302);
    await post(admin, BASE + '/' + id + '/default').expect(302);
    try {
      const page = await request(app).get('/login').expect(200);
      assert.match(page.text, /class="marker-login"/);
      // This test database has no local admin, so the form shown is the
      // Microsoft one - either way, the page's own form is inside.
      assert.match(page.text, /action="\/auth\/(local|login)(\/identify)?"/, 'the sign-in form is still there');
      assert.match(page.text, /name="_csrf"/);
      assert.doesNotMatch(page.text, /portal-sign-out/, 'nobody to sign out');

      // Its stylesheet is public; a draft's is not.
      const href = /href="(\/portal\/[^"]+\/theme\.css)\?v=/.exec(page.text)?.[1];
      assert.ok(href);
      await request(app).get(href).expect(200);
      const draft = await newPortal('Private draft');
      await request(app).get('/portal/' + draft + '/theme.css').expect(404);
    } finally {
      await post(admin, BASE + '/standard/default').expect(302);
    }
  });


  test('the editor drops the Customisation tabs, and the list keeps them', async () => {
    const id = await newPortal('No tabs in here');
    const editor = await as(admin).get(BASE + '/' + id).expect(200);
    // The way out of a portal is All portals, not a tab row for a page that
    // is not a tab (reported 15 Oct 2026).
    // The parts row (Layout, CSS, Home...) stays - that is the editor's
    // own; the Customisation row above it does not.
    assert.doesNotMatch(editor.text, /customization\/attachments/, 'no Customisation tabs inside a portal');
    assert.doesNotMatch(editor.text, /customization\/locale/);
    assert.match(editor.text, /All portals/);
    assert.match(editor.text, /aria-label="Parts of the/, 'the parts row is still there');

    const list = await as(admin).get(BASE).expect(200);
    assert.match(list.text, /customization\/attachments/, 'the list is itself a tab of Customisation');
  });

  test('the editor lists the dashboards, and says which this portal shows', async () => {
    const id = await newPortal('With a dashboard');
    const before = await as(admin).get(BASE + '/' + id).expect(200);
    assert.match(before.text, /\{\{dashboard:technician-availability\}\}/, 'offered as a variable');

    await savePart(id, 'home', '<h1>Hi</h1>{{dashboard:technician-availability}}{{content}}').expect(302);
    const after = await as(admin).get(BASE + '/' + id).expect(200);
    // The row says Yes once the portal writes it; the design itself is still
    // under Settings - Dashboards, which the row links to.
    assert.match(after.text, /\/admin\/settings\/dashboards\/user\/technician-availability/);
  });

  test('a sign-in page is dressed as a visitor sees it, not as the administrator', async () => {
    // Reported 16 Oct 2026: the Sign-in password preview carried the
    // navigation, the administrator's name and a Sign out button - none of
    // which somebody who has not signed in yet has.
    const id = await newPortal('Sign-in dressing');
    await setDefaultPortal(id, null);

    for (const path of ['/login', '/login/password']) {
      const page = await as(admin).get(path + '?portalFrame=' + id).expect(200);
      assert.doesNotMatch(page.text, /portal-sign-out/, path + ' offers nobody a sign out');
      assert.doesNotMatch(page.text, /portal-nav/, path + ' has no navigation to pages needing an account');
      assert.doesNotMatch(page.text, /portal\.admin@example\.com|Local administrator/, path + ' names nobody');
    }

    // ...and a page behind the sign-in still does.
    const inside = await as(admin).get('/tickets?portalFrame=' + id).expect(200);
    assert.match(inside.text, /portal-sign-out/);
    assert.match(inside.text, /portal-nav/);

    await setDefaultPortal(STANDARD_PORTAL, null);
  });

  test('the built-in portal can be duplicated, and the copy is the current design', async () => {
    const list = await as(admin).get(BASE).expect(200);
    assert.match(list.text, new RegExp(BASE.replace(/\//g, '\\/') + '\\/standard\\/duplicate'), 'the button is on the built-in row');

    const before = (await listPortals()).length;
    const made = await post(admin, BASE + '/standard/duplicate').expect(302);
    assert.equal((await listPortals()).length, before + 1);
    const id = String(made.headers.location).split('/').pop();
    const copy = await findPortal(String(id));
    assert.ok(copy);
    assert.match(copy.layout_html, /portal-shell/, 'the design the service desk wears now');
  });

  test('a portal nobody touched moves onto the current design by itself', async () => {
    // Reported three times: the editor shows what is saved, so a portal made
    // before the design changed still showed the old one. An untouched
    // starter is not somebody's design, so it is moved at start-up.
    const untouched = await newPortal('Untouched');
    await execute('UPDATE portal_themes SET layout_html = ? WHERE id = ?', [OLD_STARTER_LAYOUT, untouched]);

    const mine = await newPortal('Mine');
    await savePart(mine, 'layout', '<div class="mine">{{page}}</div>').expect(302);

    assert.equal(await adoptCurrentStarter(null), 1, 'only the untouched one');
    const moved = await findPortal(untouched);
    assert.match(moved!.layout_html, /portal-shell/, 'the sidebar shell');
    assert.match(String(moved!.pages.home), /portal-hero/);
    assert.match(moved!.css, /--portal-radius/, 'with a stylesheet to match');

    const theirs = await findPortal(mine);
    assert.match(theirs!.layout_html, /class="mine"/, 'a design of their own is never rewritten');

    assert.equal(await adoptCurrentStarter(null), 0, 'and only once');
  });

  test('start again from the current design replaces the layout, CSS and Home', async () => {
    // The starter copies in whatever colour the service desk is wearing.
    await updateSettings({ branding: { brandColour: "#22bb55" } }, null);
    await loadSettings();
    const id = await newPortal('Old design');
    await savePart(id, 'layout', '<div class="mine">{{page}}</div>').expect(302);
    await savePart(id, 'css', '.mine { color: red }').expect(302);
    await savePart(id, 'ticket', '<section class="kept">{{content}}</section>').expect(302);

    await post(admin, BASE + '/' + id + '/reset-design').expect(302);

    const portal = await findPortal(id);
    assert.ok(portal);
    assert.doesNotMatch(portal.layout_html, /class="mine"/, 'the layout went back');
    assert.match(portal.layout_html, /portal-shell/, 'to the current starter');
    assert.match(portal.css, /--brand: #22bb55/, 'and its colours are the ones Appearance is set to');
    assert.doesNotMatch(portal.css, /color: red/);
    assert.match(String(portal.pages.ticket), /class="kept"/, 'the other pages are the author\'s');
  });

  test('the editor can preview the sign-in page while signed in', async () => {
    const id = await newPortal('Sign-in preview');
    const editor = await as(admin).get(BASE + '/' + id + '?part=login').expect(200);
    assert.ok(editor.text.includes('src="/login?portalFrame=' + id + '"'));
    await as(admin).get('/login?portalFrame=' + id).expect(200);
    // Anyone else signed in is still sent on.
    await as(requester).get('/login?portalFrame=' + id).expect(302);
  });
});
