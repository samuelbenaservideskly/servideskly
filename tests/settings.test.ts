import './env.js';
import assert from 'node:assert/strict';
import test, { describe, before } from 'node:test';
import {
  clearSecret,
  hasOidcClientSecret,
  settings,
  settingsDocument,
  settingsProblems,
  updateSettings,
} from '../src/settings/index.js';
import { isSealed, open, seal } from '../src/lib/secret-box.js';
import { queryOne, execute } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

before(async () => {
  await bootstrapTestDatabase();
});

describe('secret storage', () => {
  test('round-trips a value through authenticated encryption', async () => {
    const sealed = seal('super-secret-value');
    assert.ok(isSealed(sealed));
    assert.notEqual(sealed.enc, 'super-secret-value', 'the plaintext must not be stored');
    assert.doesNotMatch(sealed.enc, /super-secret/);
    assert.equal(open(sealed), 'super-secret-value');
  });

  test('refuses a tampered ciphertext instead of returning altered plaintext', async () => {
    const sealed = seal('another-secret');
    const raw = Buffer.from(sealed.enc, 'base64');
    // Flip a bit in the ciphertext body; GCM must reject it.
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    assert.throws(() => open({ enc: raw.toString('base64') }), /could not be decrypted/);
  });

  test('produces different ciphertext for the same plaintext', async () => {
    // A fresh IV each time, so identical secrets are not detectable as equal.
    assert.notEqual(seal('same').enc, seal('same').enc);
  });
});

describe('settings persistence', () => {
  test('starts from the environment and reports no stored row', async () => {
    const effective = settings();
    assert.equal(effective.ssoConfigured, false, 'no tenant credentials are set');
    assert.equal(effective.provisioning.jitEnabled, true, 'the default when nothing is stored');
    assert.equal(effective.scim.enabled, false);
    assert.equal(effective.scim.configured, false, 'no token has been generated');
  });

  test('a saved change takes effect immediately', async () => {
    await updateSettings({ provisioning: { jitEnabled: false } }, null);
    assert.equal(settings().provisioning.jitEnabled, false);

    await updateSettings({ provisioning: { jitEnabled: true } }, null);
    assert.equal(settings().provisioning.jitEnabled, true);
  });

  test('derived values follow the stored tenant id', async () => {
    await updateSettings({ oidc: { tenantId: 'tenant-abc' } }, null);
    assert.match(settings().oidc.discoveryUrl, /tenant-abc/);
  });

  test('the SCIM endpoint is derived, not stored', async () => {
    assert.match(settings().scim.endpoint, /\/scim\/v2$/);
  });

  test('there is no role mapping left to configure', async () => {
    // The whole point of the change: nothing in the settings document can
    // grant a role, so there is no key here to set one with.
    const stored = JSON.stringify(settingsDocument());
    for (const gone of [
      'adminGroups',
      'agentGroups',
      'adminAppRoles',
      'agentAppRoles',
      'defaultRole',
      'bootstrapAdminEmails',
      'authMode',
      'saml',
      'graph',
    ]) {
      assert.doesNotMatch(stored, new RegExp(gone), gone + " must not be in the document");
    }
  });
  test('stores the client secret sealed, never in the clear', async () => {
    await updateSettings({ oidc: { clientSecret: 'the-client-secret' } }, null);

    // Readable through the effective settings...
    assert.equal(settings().oidc.clientSecret, 'the-client-secret');
    // ...but not present in the stored row.
    const row = await queryOne<{ document: unknown }>(
      "SELECT document FROM settings WHERE id = 'current'",
    );
    assert.ok(row);
    assert.doesNotMatch(
      JSON.stringify(row.document),
      /the-client-secret/,
      'the secret must be encrypted at rest',
    );
    assert.ok(isSealed(settingsDocument().oidc.clientSecret));
    assert.equal(hasOidcClientSecret(), true);
  });

  test('an empty secret leaves the stored one alone', async () => {
    await updateSettings({ oidc: { clientSecret: '' } }, null);
    assert.equal(
      settings().oidc.clientSecret,
      'the-client-secret',
      'a blank field in the form means "keep what is stored"',
    );
  });

  test('a secret can be removed outright', async () => {
    await clearSecret('oidcClientSecret', null);
    assert.equal(hasOidcClientSecret(), false);
    assert.equal(settings().oidc.clientSecret, '');
  });

  test('an unreadable stored document falls back to the environment', async () => {
    // A structurally valid document that no longer matches the schema - a
    // hand-edited row, or one written by an older version.
    await execute("UPDATE settings SET document = ? WHERE id = 'current'", [
      JSON.stringify({ oidc: 'not an object', provisioning: 'yes please' }),
    ]);
    // Force a reload by writing through the normal path afterwards.
    const effective = await updateSettings({}, null);
    assert.ok(effective.oidc, 'the service must stay usable');
    assert.equal(effective.provisioning.jitEnabled, true, 'back to the environment defaults');
  });
});

describe('settings validation', () => {
  const base = {
    oidc: { tenantId: 'tenant', clientId: 'client', hasSecret: true },
    scim: { enabled: false, configured: false },
    provisioning: { jitEnabled: true },
  };

  test('accepts a complete OpenID Connect configuration', () => {
    assert.deepEqual(settingsProblems(base), []);
  });

  test('refuses OpenID Connect without credentials', () => {
    const problems = settingsProblems({
      ...base,
      oidc: { tenantId: '', clientId: '', hasSecret: false },
    });
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => /tenant/i.test(p)));
    assert.ok(problems.some((p) => /client secret/i.test(p)));
  });

  test('refuses switching SCIM on before a token exists', () => {
    const problems = settingsProblems({
      ...base,
      scim: { enabled: true, configured: false },
    });
    assert.ok(problems.some((p) => /bearer token/i.test(p)));
  });

  test('accepts SCIM once a token is set', () => {
    assert.deepEqual(
      settingsProblems({ ...base, scim: { enabled: true, configured: true } }),
      [],
    );
  });

  test('warns when nothing at all can provision a directory account', () => {
    const problems = settingsProblems({
      ...base,
      provisioning: { jitEnabled: false },
      scim: { enabled: false, configured: false },
    });
    assert.ok(problems.some((p) => /no directory account can sign in/i.test(p)));
  });
});
