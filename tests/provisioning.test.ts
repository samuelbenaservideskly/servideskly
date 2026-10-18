import './env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before, describe } from 'node:test';
import { execute } from '../src/db/index.js';
import { provisionOnLogin, type DirectoryIdentity } from '../src/auth/provisioning.js';
import {
  findUserByEmail,
  setUserRole,
  setUserStatus,
  upsertUserFromDirectory,
} from '../src/services/users.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { HttpError } from '../src/lib/errors.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

const ISSUER = 'https://login.microsoftonline.com/test-tenant/v2.0';

function identity(overrides: Partial<DirectoryIdentity> = {}): DirectoryIdentity {
  return {
    issuer: ISSUER,
    externalId: 'oid-' + Math.random().toString(36).slice(2, 10),
    email: 'person' + Math.random().toString(36).slice(2, 8) + '@example.com',
    upn: null,
    displayName: 'Test Person',
    ...overrides,
  };
}

before(async () => {
  await bootstrapTestDatabase();
  // A row for the foreign-key tests at the bottom to point at.
  await upsertUserFromDirectory({
    issuer: ISSUER,
    externalId: 'oid-seed-existing',
    email: 'seed.existing@example.com',
    upn: null,
    displayName: 'Seed Existing',
    role: 'user',
    source: 'manual',
  });
});

describe('roles never come from the directory', () => {
  test('a new account is always a plain user', async () => {
    const { user, created } = await provisionOnLogin(identity({ email: 'fresh@example.com' }), 'jit');
    assert.equal(created, true);
    assert.equal(user.role, 'user');
  });

  test('an administrator-set role survives every later sign-in', async () => {
    const id = identity({ email: 'promoted@example.com' });
    const { user } = await provisionOnLogin(id, 'jit');
    assert.equal(user.role, 'user');

    // An administrator promotes them in the application.
    await setUserRole(user.id, 'agent', true);

    const again = await provisionOnLogin(id, 'jit');
    assert.equal(
      again.user.role,
      'agent',
      'signing in must not reset a role an administrator set',
    );
  });

  test('a demotion is not undone by signing in', async () => {
    const id = identity({ email: 'demoted@example.com' });
    const { user } = await provisionOnLogin(id, 'jit');
    await setUserRole(user.id, 'admin', true);
    await setUserRole(user.id, 'user', true);

    const again = await provisionOnLogin(id, 'jit');
    assert.equal(again.user.role, 'user');
  });
});

describe('just-in-time provisioning', () => {
  test('creates the account on first sign-in', async () => {
    const id = identity({
      email: 'JIT.User@Example.COM',
      displayName: 'Jit User',
    });
    const { user, created } = await provisionOnLogin(id, 'jit');

    assert.equal(created, true);
    // Emails are stored folded to lower case so lookups are stable.
    assert.equal(user.email, 'jit.user@example.com');
    assert.equal(user.role, 'user');
    assert.equal(user.status, 'active');
    assert.equal(user.source, 'jit');
    assert.ok(user.last_login_at, 'last_login_at should be stamped');
  });

  test('reuses the account on later sign-ins and refreshes the profile', async () => {
    const id = identity({ email: 'repeat@example.com', displayName: 'Before' });
    const first = await provisionOnLogin(id, 'jit');
    assert.equal(first.created, true);

    const second = await provisionOnLogin({ ...id, displayName: 'After' }, 'jit');
    assert.equal(second.created, false);
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.display_name, 'After', 'the profile is refreshed');
  });

  test('with it switched off, an unknown account is refused', async () => {
    await updateSettings({ provisioning: { jitEnabled: false } }, null);
    assert.equal(settings().provisioning.jitEnabled, false);

    try {
      await assert.rejects(
        () => provisionOnLogin(identity({ email: 'unprovisioned@example.com' }), 'jit'),
        (err: unknown) =>
          err instanceof HttpError && err.status === 403 && err.code === 'not_provisioned',
      );

      // An account SCIM already provisioned still gets in.
      await upsertUserFromDirectory({
        issuer: ISSUER,
        externalId: 'oid-presynced',
        email: 'presynced@example.com',
        upn: null,
        displayName: 'Pre Synced',
        role: 'user',
        source: 'sync',
      });
      const { created } = await provisionOnLogin(
        identity({ externalId: 'oid-presynced', email: 'presynced@example.com' }),
        'jit',
      );
      assert.equal(created, false, 'the provisioned account must be reused, not recreated');
    } finally {
      await updateSettings({ provisioning: { jitEnabled: true } }, null);
    }
  });

  test('a disabled account cannot sign in', async () => {
    const id = identity({ email: 'disabled@example.com' });
    const { user } = await provisionOnLogin(id, 'jit');
    await setUserStatus(user.id, 'disabled');

    await assert.rejects(
      () => provisionOnLogin(id, 'jit'),
      (err: unknown) =>
        err instanceof HttpError && err.status === 403 && err.code === 'account_disabled',
    );
  });

  test('tracks the directory object id, not the email address', async () => {
    const id = identity({ email: 'renamed@example.com', externalId: 'stable-oid-1' });
    const { user } = await provisionOnLogin(id, 'jit');

    // The person's address changes in the directory; the object id does not.
    const renamed = await provisionOnLogin(
      { ...id, email: 'new.address@example.com' },
      'jit',
    );
    assert.equal(renamed.created, false);
    assert.equal(renamed.user.id, user.id, 'the same local account must be reused');
  });

  test('binds a hand-seeded account to its directory object on first sign-in', async () => {
    // An administrator seeds the account with no external id.
    await upsertUserFromDirectory({
      issuer: ISSUER,
      externalId: null,
      email: 'seeded@example.com',
      upn: null,
      displayName: 'Seeded Person',
      role: 'agent',
      source: 'manual',
    });

    const { user, created } = await provisionOnLogin(
      identity({ email: 'seeded@example.com', externalId: 'oid-seeded' }),
      'jit',
    );
    assert.equal(created, false, 'the seeded row must be reused, not duplicated');
    assert.equal(user.external_id, 'oid-seeded');
    assert.equal(
      user.role,
      'agent',
      'and the role it was seeded with is kept, not reset to user',
    );
  });
});
describe('database constraints', () => {
  test('rejects a role outside the allowed set', async () => {
    await assert.rejects(
      () =>
        execute(
          'INSERT INTO users (id, issuer, email, display_name, role, source)' +
            " VALUES (?, 'i', 'constraint@example.com', 'n', 'superuser', 'manual')",
          [randomUUID()],
        ),
      /CHECK constraint failed: role|users_role_check/,
    );
  });

  test('rejects a ticket status outside the allowed set', async () => {
    const requester = await findUserByEmail('seed.existing@example.com');
    assert.ok(requester);
    await assert.rejects(
      () =>
        execute(
          'INSERT INTO tickets (id, seq, title, description, status, requester_id)' +
            " VALUES (?, ?, 'x', 'y', 'deleted', ?)",
          [randomUUID(), 9001, requester.id],
        ),
      /CHECK constraint failed: status|tickets_status_check/,
    );
  });

  test('enforces the foreign key from a ticket to its requester', async () => {
    await assert.rejects(
      () =>
        execute(
          'INSERT INTO tickets (id, seq, title, description, requester_id)' +
            ' VALUES (?, ?, ?, ?, ?)',
          [randomUUID(), 9002, 'x', 'y', randomUUID()],
        ),
      /FOREIGN KEY constraint failed|violates foreign key constraint/,
    );
  });
});

describe('an address that already belongs to another directory object', () => {
  test('is refused as a 409 with words, not a 500', async () => {
    // As SCIM leaves it with Entra's default mapping: externalId = mailNickname.
    await upsertUserFromDirectory({
      issuer: 'urn:helpdesk:scim',
      externalId: 'mailnickname',
      email: 'bound.elsewhere@example.com',
      upn: null,
      displayName: 'Bound Elsewhere',
      role: 'user',
      source: 'manual',
    });
    await assert.rejects(
      () => provisionOnLogin(identity({ email: 'bound.elsewhere@example.com' }), 'jit'),
      (err: unknown) => err instanceof HttpError && err.status === 409 && /already belongs to another account/.test(err.message),
    );
  });
});

describe('details from the directory', () => {
  test('are written when stated, and kept when a later sign-in states nothing', async () => {
    const who = identity({ company: 'Contoso', department: 'IT', jobTitle: 'Engineer', office: 'Praha', phone: '+420 1' });
    const { user } = await provisionOnLogin(who, 'jit');
    const row = await findUserByEmail(who.email);
    assert.deepEqual([row?.company, row?.department, row?.job_title, row?.office, row?.phone], ['Contoso', 'IT', 'Engineer', 'Praha', '+420 1']);

    await provisionOnLogin({ ...who, company: undefined, department: 'Finance', jobTitle: undefined, office: undefined, phone: undefined }, 'jit');
    const again = await findUserByEmail(who.email);
    assert.equal(again?.id, user.id);
    assert.deepEqual([again?.company, again?.department, again?.office], ['Contoso', 'Finance', 'Praha']);
  });
});
