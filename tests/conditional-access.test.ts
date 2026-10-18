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
import { addressAllowed, parseRange } from '../src/auth/conditional-access.js';
import { createLocalAccount } from '../src/auth/local-accounts.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { queuedMail } from './support/outbox.js';

/**
 * Conditional access for password accounts: addresses, and a code by email.
 *
 * The sign-in requests here come from 127.0.0.1 (supertest over a local
 * socket), so a range that includes it allows and one that does not refuses.
 */

let app: Express;
let admin: TestSession;

const PASSWORD = 'A-long-enough-test-passphrase-1';

function csrfFrom(html: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

async function access(next: {
  allowedRanges?: string[];
  breakGlassRanges?: string[];
  elsewhereNeedsCode?: boolean;
  codeForEveryone?: boolean;
}) {
  await updateSettings(
    {
      localAccounts: {
        ...settings().localAccounts,
        conditionalAccess: {
          allowedRanges: next.allowedRanges ?? [],
          breakGlassRanges: next.breakGlassRanges ?? [],
          elsewhereNeedsCode: next.elsewhereNeedsCode === true,
          codeForEveryone: next.codeForEveryone === true,
        },
      },
    },
    null,
  );
}

/** Signs in with a password, following nothing. */
async function signIn(email: string) {
  const agent = request.agent(app);
  const page = await agent.get('/login').expect(200);
  return {
    agent,
    response: await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email, password: PASSWORD }),
  };
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('ca.admin@example.com', 'admin');
  await createLocalAccount(
    { email: 'ca.user@example.com', displayName: 'Conditional', role: 'user', password: PASSWORD },
    null,
  );
  // A code needs somewhere to be sent from.
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
});

describe('ranges', () => {
  test('reads addresses and CIDR, in both families, and refuses nonsense', () => {
    assert.ok(parseRange('10.0.0.0/8'));
    assert.ok(parseRange('203.0.113.7'));
    assert.ok(parseRange('2001:db8::/32'));
    assert.equal(parseRange('10.0.0.0/33'), undefined, 'too many bits');
    assert.equal(parseRange('999.1.1.1'), undefined);
    assert.equal(parseRange('not an address'), undefined);
    assert.equal(parseRange(''), undefined);
  });

  test('matches inside a range and nowhere else', () => {
    assert.equal(addressAllowed('10.1.2.3', ['10.0.0.0/8']), true);
    assert.equal(addressAllowed('11.1.2.3', ['10.0.0.0/8']), false);
    assert.equal(addressAllowed('203.0.113.7', ['203.0.113.7']), true);
    assert.equal(addressAllowed('203.0.113.8', ['203.0.113.7']), false);

    // An IPv4 client on a dual-stack socket is still that IPv4 address.
    assert.equal(addressAllowed('::ffff:10.1.2.3', ['10.0.0.0/8']), true);

    // Different families never match each other, so an IPv6 /0 is not
    // "everything".
    assert.equal(addressAllowed('10.1.2.3', ['::/0']), false);

    // No ranges: anywhere. An unreadable address: the rule cannot be
    // applied, and locking everybody out over a header is worse.
    assert.equal(addressAllowed('10.1.2.3', []), true);
    assert.equal(addressAllowed('', ['10.0.0.0/8']), true);
  });
});

describe('signing in under conditional access', () => {
  test('inside the allowed addresses, a password is enough', async () => {
    await access({ allowedRanges: ['127.0.0.0/8'] });
    const { response } = await signIn('ca.user@example.com');
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/home');
  });

  test('outside them, sign-in is refused and says so', async () => {
    await access({ allowedRanges: ['203.0.113.0/24'] });
    const { response } = await signIn('ca.user@example.com');
    assert.equal(response.status, 403);
    assert.match(response.text, /not allowed from this network/);
  });

  test('outside them with a code, the sign-in waits for one', async () => {
    await access({ allowedRanges: ['203.0.113.0/24'], elsewhereNeedsCode: true });
    const { agent, response } = await signIn('ca.user@example.com');
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/login/verify');

    // No session yet: the page itself is still out of reach.
    await agent.get('/tickets').expect(302);

    const page = await agent.get('/login/verify').expect(200);
    assert.match(page.text, /A code has been sent/);

    // A wrong code does not let anybody in.
    const wrong = await agent
      .post('/auth/local/verify')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), code: '000000' });
    assert.equal(wrong.status, 400);
    await agent.get('/tickets').expect(302);
  });

  test('a code for everybody, even inside the allowed addresses', async () => {
    await access({ allowedRanges: ['127.0.0.0/8'], codeForEveryone: true });
    const { response } = await signIn('ca.user@example.com');
    assert.equal(response.headers.location, '/login/verify');
  });

  test('the break-glass account is never refused by address', async () => {
    await access({ allowedRanges: ['203.0.113.0/24'] });
    const agent = request.agent(app);
    const page = await agent.get('/login').expect(200);
    const response = await agent
      .post('/auth/local')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), email: 'admin@local', password: '1234' });
    // Either in, or asked to change a seeded password - never refused.
    assert.notEqual(response.status, 403);
  });

  test('the ranges are checked where they are typed', async () => {
    const page = await request
      .agent(app)
      .set('Cookie', admin.cookie)
      .get('/admin/settings/users/other')
      .expect(200);

    const refused = await request
      .agent(app)
      .set('Cookie', admin.cookie)
      .post('/admin/settings/users/other/access')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), allowedRanges: '10.0.0.0/8\nnot-an-address' });
    // Refused where it was typed, with the message beside the field (trap 6).
    assert.equal(refused.status, 400);
    assert.match(refused.text, /not an address or a range/);

    const saved = await request
      .agent(app)
      .set('Cookie', admin.cookie)
      .post('/admin/settings/users/other/access')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), allowedRanges: '10.0.0.0/8, 192.168.0.0/16', codeForEveryone: 'on' });
    assert.equal(saved.status, 302);
    assert.deepEqual(settings().localAccounts.conditionalAccess.allowedRanges, [
      '10.0.0.0/8',
      '192.168.0.0/16',
    ]);
    assert.equal(settings().localAccounts.conditionalAccess.codeForEveryone, true);
  });

  test('a code was queued, and only one per minute', async () => {
    await access({ codeForEveryone: true });
    await signIn('ca.user@example.com');
    const queued = await queuedMail((m) => m.subject.startsWith('Your sign-in code'));
    assert.ok(queued.length >= 1, 'a code was queued');

    const before = queued.length;
    await signIn('ca.user@example.com');
    const after = await queuedMail((m) => m.subject.startsWith('Your sign-in code'));
    assert.equal(after.length, before, 'a second attempt within the minute sends nothing');
  });
});

describe('the holes somebody would look for', () => {
  test('a temporary password does not skip the gate', async () => {
    // Found by the owner, 16 Oct 2026: must-change was checked first, so a
    // temporary password went straight to "choose a password" and got a
    // session - with the address rule never applied.
    const { setLocalPassword } = await import('../src/auth/local-accounts.js');
    const { findUserByEmail } = await import('../src/services/users.js');
    const person = await findUserByEmail('ca.user@example.com');
    assert.ok(person);
    await setLocalPassword(person.id, PASSWORD, null, { mustChange: true });

    await access({ allowedRanges: ['203.0.113.0/24'] });
    const refused = await signIn('ca.user@example.com');
    assert.equal(refused.response.status, 403, 'refused before any password page');
    await refused.agent.get('/login/new-password').expect(302);

    // With a code, the code comes first and the password after it.
    await access({ allowedRanges: ['203.0.113.0/24'], elsewhereNeedsCode: true });
    const { agent, response } = await signIn('ca.user@example.com');
    assert.equal(response.headers.location, '/login/verify');
    // Not into the password step until the code is given.
    const jumped = await agent.get('/login/new-password').expect(302);
    assert.equal(jumped.headers.location, '/login');

    await setLocalPassword(person.id, PASSWORD, null, { mustChange: false });
  });

  test('a code account answers the address rule, even though it is not asked for a second code', async () => {
    const { codeSignInAllowed } = await import('../src/auth/conditional-access.js');
    const { findUserByEmail } = await import('../src/services/users.js');
    const person = await findUserByEmail('ca.user@example.com');
    assert.ok(person);

    await access({ allowedRanges: ['203.0.113.0/24'] });
    assert.equal(codeSignInAllowed(person, '127.0.0.1'), false, 'outside the ranges');
    assert.equal(codeSignInAllowed(person, '203.0.113.5'), true, 'inside them');

    // "Elsewhere is fine as long as a code is given" - and one just was.
    await access({ allowedRanges: ['203.0.113.0/24'], elsewhereNeedsCode: true });
    assert.equal(codeSignInAllowed(person, '127.0.0.1'), true);
  });

  test('the page says which address the service desk reads', async () => {
    // Typed from a public address while the server saw ::1, and the code
    // step then looked like a bug (reported 16 Oct 2026). The page has to
    // say what it is actually comparing against.
    await access({ allowedRanges: ['203.0.113.0/24'], elsewhereNeedsCode: true });
    const page = await request
      .agent(app)
      .set('Cookie', admin.cookie)
      .get('/admin/settings/users/other')
      .expect(200);

    assert.match(page.text, /This device signs in from/);
    assert.match(page.text, /is not in the list above/, 'and whether the ranges cover it');

    await access({ allowedRanges: ['127.0.0.0/8', '::1/128'] });
    const covered = await request
      .agent(app)
      .set('Cookie', admin.cookie)
      .get('/admin/settings/users/other')
      .expect(200);
    assert.match(covered.text, /is inside the list above/);

    await access({});
  });

  test('the break-glass account can be pinned to its own addresses', async () => {
    const { accessDecision } = await import('../src/auth/conditional-access.js');
    // A break-glass-shaped row: the rule reads the locked administrator
    // role and nothing else, so this needs no seeding to be true of.
    const { findUserByEmail } = await import('../src/services/users.js');
    const person = await findUserByEmail('ca.user@example.com');
    assert.ok(person);
    const breakGlass = { ...person, role: 'admin' as const, role_locked: true };

    // Its own list, which the ordinary ranges never touch.
    await access({ allowedRanges: ['203.0.113.0/24'] });
    assert.equal(await accessDecision(breakGlass, '127.0.0.1'), 'allow');

    await updateSettings(
      {
        localAccounts: {
          ...settings().localAccounts,
          conditionalAccess: {
            allowedRanges: [],
            breakGlassRanges: ['10.9.9.0/24'],
            elsewhereNeedsCode: false,
            codeForEveryone: false,
          },
        },
      },
      null,
    );
    assert.equal(await accessDecision(breakGlass, '127.0.0.1'), 'refuse', 'outside its own list');
    assert.equal(await accessDecision(breakGlass, '10.9.9.4'), 'allow', 'inside it');

    await access({});
  });
});
