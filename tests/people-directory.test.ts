import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { setProfileAttributes } from '../src/services/users.js';

/**
 * The directory at /people: who may search it, and what each reader is
 * shown. The person page itself is covered by groups-both-ways.test.ts.
 */

let app: Express;
let admin: TestSession;
let agentUser: TestSession;
let requester: TestSession;
let colleague: TestSession;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

function post(session: TestSession, url: string, form: Record<string, string> = {}) {
  return as(session).post(url).type('form').send({ _csrf: session.csrfToken, ...form });
}

async function directory(open: { technicians?: boolean; users?: boolean; ownCompanyOnly?: boolean }) {
  await updateSettings(
    {
      people: {
        ...settings().people,
        directory: {
          technicians: open.technicians === true,
          users: open.users === true,
          ownCompanyOnly: open.ownCompanyOnly === true,
        },
      },
    },
    null,
  );
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('dir.admin@example.com', 'admin');
  agentUser = await signInAs('dir.tech@example.com', 'agent');
  requester = await signInAs('dir.user@contoso.test', 'user');
  colleague = await signInAs('dir.mate@contoso.test', 'user');
  await setProfileAttributes(requester.user.id, { department: '', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '', company: 'Contoso' }, null);
  await setProfileAttributes(colleague.user.id, { department: '', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '', company: 'Contoso', phone: '555 0100' }, null);
  await setProfileAttributes(agentUser.user.id, { department: '', jobTitle: '', office: '', extension1: '', extension2: '', extension3: '', company: 'Fabrikam' }, null);
});

describe('the people directory', () => {
  test('off by default for everybody but an administrator', async () => {
    await directory({});
    await as(admin).get('/people').expect(200);
    // A 404, not a 403: a refusal would say the page is there and closed.
    await as(agentUser).get('/people').expect(404);
    await as(requester).get('/people').expect(404);
  });

  test('a switch each, and the sidebar link follows it', async () => {
    await directory({ technicians: true });
    const open = await as(agentUser).get('/people').expect(200);
    assert.match(open.text, /dir\.user@contoso\.test/);
    await as(requester).get('/people').expect(404);

    await directory({ technicians: true, users: true });
    const forUser = await as(requester).get('/people').expect(200);
    assert.match(forUser.text, /dir\.tech@example\.com/);

    // The link is offered to whoever may use it, and to nobody else.
    const page = await as(requester).get('/tickets').expect(200);
    assert.match(page.text, /href="\/people"/);
    await directory({});
    const closed = await as(requester).get('/tickets').expect(200);
    assert.doesNotMatch(closed.text, /href="\/people"/);
  });

  test('own company only narrows a search, and never an administrator', async () => {
    await directory({ technicians: true, users: true, ownCompanyOnly: true });

    const forUser = await as(requester).get('/people').expect(200);
    assert.match(forUser.text, /dir\.mate@contoso\.test/, 'their colleague');
    assert.doesNotMatch(forUser.text, /dir\.tech@example\.com/, 'somebody at another company');

    const forAdmin = await as(admin).get('/people').expect(200);
    assert.match(forAdmin.text, /dir\.tech@example\.com/, 'an administrator is not narrowed');
  });

  test('a requester sees how to reach somebody, never what they raised', async () => {
    await directory({ users: true });
    const page = await as(requester).get('/people/' + colleague.user.id).expect(200);
    assert.match(page.text, /555 0100/);
    assert.doesNotMatch(page.text, /Latest tickets they raised/);
    assert.doesNotMatch(page.text, /Open in Users/);

    // A technician sees the tickets, whether or not the directory is open.
    await directory({});
    const staffView = await as(agentUser).get('/people/' + colleague.user.id).expect(200);
    assert.match(staffView.text, /Latest tickets they raised/);
  });

  test('searching finds by name and by address', async () => {
    await directory({ technicians: true });
    const byAddress = await as(agentUser).get('/people?q=dir.mate').expect(200);
    assert.match(byAddress.text, /dir\.mate@contoso\.test/);
    assert.doesNotMatch(byAddress.text, /dir\.user@contoso\.test/);

    const nothing = await as(agentUser).get('/people?q=nobody-by-that-name').expect(200);
    assert.match(nothing.text, /Nobody matches/);
  });

  test('the switches are saved from Users - Other settings', async () => {
    await post(admin, '/admin/settings/users/other/directory', {
      technicians: 'on',
      ownCompanyOnly: 'on',
    }).expect(302);
    assert.deepEqual(settings().people.directory, {
      technicians: true,
      users: false,
      ownCompanyOnly: true,
    });
  });
});
