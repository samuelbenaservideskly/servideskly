import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs } from './support/session.js';
import {
  applyScimPatch,
  generateScimToken,
  parseScimFilter,
  readScimUser,
  revokeScimToken,
  ScimError,
} from '../src/services/scim.js';
import { settings, updateSettings } from '../src/settings/index.js';
import { findUserByEmail, upsertUserFromDirectory } from '../src/services/users.js';
import { createTicket } from '../src/services/tickets.js';

let app: Express;
let token: string;

const JSON_TYPE = 'application/scim+json';

/** A request carrying the bearer token Entra would send. */
function scim() {
  return request(app);
}
const bearer = () => 'Bearer ' + token;

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  token = await generateScimToken(null);
});

// ---------------------------------------------------------------------------
// Payload reading, in isolation
// ---------------------------------------------------------------------------

describe('reading the payloads Entra sends', () => {
  test('takes the work email, the display name and the external id', () => {
    const input = readScimUser({
      externalId: 'oid-1',
      userName: 'a.person@example.com',
      name: { givenName: 'A', familyName: 'Person' },
      displayName: 'A Person',
      emails: [
        { value: 'personal@example.com', type: 'home' },
        { value: 'a.person@example.com', type: 'work', primary: true },
      ],
      active: true,
    });

    assert.equal(input.externalId, 'oid-1');
    assert.equal(input.userName, 'a.person@example.com');
    assert.equal(input.displayName, 'A Person');
    assert.equal(input.email, 'a.person@example.com', 'the primary work address wins');
    assert.equal(input.active, true);
  });

  test('falls back to assembling a name, then to the userName as address', () => {
    const input = readScimUser({
      userName: 'b.person@example.com',
      name: { givenName: 'B', familyName: 'Person' },
    });
    assert.equal(input.displayName, 'B Person');
    assert.equal(input.email, 'b.person@example.com');
  });

  test('ignores anything claiming to grant a role', () => {
    const input = readScimUser({
      userName: 'c@example.com',
      roles: [{ value: 'admin', primary: true }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'IT' },
    }) as Record<string, unknown>;
    assert.equal(input.role, undefined);
    assert.equal(input.roles, undefined);
  });
});

describe('applying a PATCH', () => {
  test('understands the Entra shape, with a capitalised op and a string value', () => {
    const input = applyScimPatch({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    assert.equal(input.active, false);
  });

  test('understands the pathless shape, with an object value', () => {
    const input = applyScimPatch({
      Operations: [{ op: 'replace', value: { active: true, displayName: 'New Name' } }],
    });
    assert.equal(input.active, true);
    assert.equal(input.displayName, 'New Name');
  });

  test('reads the company, department and title however Entra sends them in a PATCH', () => {
    const ent = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
    // Pathless, with the extension as flat keys - the shape that left Company empty.
    const flat = applyScimPatch({ Operations: [{ op: 'Add', value: { [ent + ':organization']: 'ABC', [ent + ':department']: 'IT', title: 'Engineer' } }] });
    assert.deepEqual([flat.company, flat.department, flat.jobTitle], ['ABC', 'IT', 'Engineer']);
    // With a path each.
    const pathed = applyScimPatch({
      Operations: [
        { op: 'Replace', path: ent + ':organization', value: 'ABC' },
        { op: 'Replace', path: ent + ':department', value: 'IT' },
        { op: 'Replace', path: 'title', value: 'Engineer' },
      ],
    });
    assert.deepEqual([pathed.company, pathed.department, pathed.jobTitle], ['ABC', 'IT', 'Engineer']);
  });

  test('treats removing active as deactivating', () => {
    assert.equal(applyScimPatch({ Operations: [{ op: 'remove', path: 'active' }] }).active, false);
  });

  test('ignores a patch that tries to set a role', () => {
    const input = applyScimPatch({
      Operations: [{ op: 'replace', path: 'roles', value: 'admin' }],
    }) as Record<string, unknown>;
    assert.equal(input.role, undefined);
    assert.equal(input.roles, undefined);
  });

  test('refuses a patch with no operations rather than silently doing nothing', () => {
    assert.throws(() => applyScimPatch({}), ScimError);
  });
});

describe('filters', () => {
  test('parses the forms Entra sends', () => {
    assert.deepEqual(parseScimFilter('userName eq "a@b.c"'), {
      attribute: 'userName',
      value: 'a@b.c',
    });
    assert.deepEqual(parseScimFilter('externalId eq "oid-9"'), {
      attribute: 'externalId',
      value: 'oid-9',
    });
    assert.deepEqual(parseScimFilter('emails.value eq "a@b.c"'), {
      attribute: 'email',
      value: 'a@b.c',
    });
  });

  test('refuses anything else rather than matching everything', () => {
    for (const bad of ['displayName sw "A"', 'active eq true', '', 'userName pr', 'x eq "y"']) {
      assert.throws(
        () => parseScimFilter(bad),
        ScimError,
        'expected ' + JSON.stringify(bad) + ' to be refused',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

describe('authentication', () => {
  test('refuses a missing, malformed or wrong token identically', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer', 'Bearer wrong-token']) {
      const req = scim().get('/scim/v2/Users');
      if (header) req.set('Authorization', header);
      const response = await req;
      assert.equal(response.status, 401, 'header: ' + String(header));
      assert.match(response.headers['www-authenticate'] ?? '', /Bearer/);
    }
  });

  test('accepts the issued token', async () => {
    await scim().get('/scim/v2/Users').set('Authorization', bearer()).expect(200);
  });

  test('allocates no session', async () => {
    const response = await scim().get('/scim/v2/Users').set('Authorization', bearer()).expect(200);
    assert.equal(response.headers['set-cookie'], undefined, 'SCIM must not mint a session');
  });

  test('answers in scim+json, not HTML', async () => {
    const response = await scim().get('/scim/v2/Users').set('Authorization', bearer());
    assert.match(response.headers['content-type'] ?? '', /scim\+json/);
  });

  test('a revoked token stops working at once', async () => {
    const throwaway = await generateScimToken(null);
    await scim().get('/scim/v2/Users').set('Authorization', 'Bearer ' + throwaway).expect(200);

    await revokeScimToken(null);
    await scim().get('/scim/v2/Users').set('Authorization', 'Bearer ' + throwaway).expect(401);

    // Re-issue for the rest of the file.
    token = await generateScimToken(null);
  });
});

describe('provisioning users', () => {
  let created: Record<string, unknown>;

  test('creates an account', async () => {
    const response = await scim()
      .post('/scim/v2/Users')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        externalId: 'oid-scim-1',
        userName: 'scim.one@example.com',
        name: { givenName: 'Scim', familyName: 'One' },
        displayName: 'Scim One',
        emails: [{ value: 'scim.one@example.com', type: 'work', primary: true }],
        active: true,
      })
      .expect(201);

    created = response.body as Record<string, unknown>;
    assert.ok(created.id);
    assert.equal(created.active, true);
    assert.equal(created.externalId, 'oid-scim-1');
    assert.match(response.headers.location ?? '', /\/scim\/v2\/Users\//);
  });

  test('as a plain user, whatever the payload asked for', async () => {
    const response = await scim()
      .post('/scim/v2/Users')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({
        userName: 'scim.wannabe@example.com',
        displayName: 'Would Be Admin',
        roles: [{ value: 'admin', primary: true }],
        active: true,
      })
      .expect(201);

    const row = await findUserByEmail('scim.wannabe@example.com');
    assert.ok(row);
    assert.equal(row.role, 'user', 'a role in a SCIM payload must never be honoured');
    assert.equal(row.source, 'sync');
    assert.equal(response.body.active, true);
  });

  test('refuses a duplicate address with a 409 and a uniqueness error', async () => {
    const response = await scim()
      .post('/scim/v2/Users')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ userName: 'scim.one@example.com', active: true })
      .expect(409);
    assert.equal(response.body.scimType, 'uniqueness');
  });

  test('refuses a payload with no usable address', async () => {
    await scim()
      .post('/scim/v2/Users')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ displayName: 'No Address' })
      .expect(400);
  });

  test('finds it again by userName and by externalId', async () => {
    const byName = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'userName eq "scim.one@example.com"' })
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(byName.body.totalResults, 1);
    assert.match(byName.body.schemas[0], /ListResponse$/);

    const byExternal = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'externalId eq "oid-scim-1"' })
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(byExternal.body.totalResults, 1);
  });

  test('an unmatched filter is an empty list, not an error', async () => {
    const response = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'userName eq "nobody@example.com"' })
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(response.body.totalResults, 0);
    assert.deepEqual(response.body.Resources, []);
  });

  test('an unsupported filter is refused', async () => {
    const response = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'displayName sw "S"' })
      .set('Authorization', bearer())
      .expect(400);
    assert.equal(response.body.scimType, 'invalidFilter');
  });

  test('deactivates and reactivates through PATCH', async () => {
    const id = created.id as string;

    const off = await scim()
      .patch('/scim/v2/Users/' + id)
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })
      .expect(200);
    assert.equal(off.body.active, false);
    assert.equal((await findUserByEmail('scim.one@example.com'))?.status, 'disabled');

    const on = await scim()
      .patch('/scim/v2/Users/' + id)
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ Operations: [{ op: 'replace', value: { active: true } }] })
      .expect(200);
    assert.equal(on.body.active, true);
    assert.equal((await findUserByEmail('scim.one@example.com'))?.status, 'active');
  });

  test('a PATCH never changes a role an administrator set', async () => {
    const row = await findUserByEmail('scim.one@example.com');
    assert.ok(row);
    const { setUserRole } = await import('../src/services/users.js');
    await setUserRole(row.id, 'agent', true);

    await scim()
      .patch('/scim/v2/Users/' + row.id)
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ Operations: [{ op: 'replace', path: 'roles', value: 'user' }] })
      .expect(200);

    assert.equal((await findUserByEmail('scim.one@example.com'))?.role, 'agent');
  });

  test('replaces the profile through PUT', async () => {
    const id = created.id as string;
    const response = await scim()
      .put('/scim/v2/Users/' + id)
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({
        userName: 'scim.one@example.com',
        displayName: 'Scim One-Renamed',
        emails: [{ value: 'scim.one@example.com', type: 'work', primary: true }],
        active: true,
      })
      .expect(200);
    assert.equal(response.body.displayName, 'Scim One-Renamed');
  });

  test('an unknown id is a 404 with a SCIM error document', async () => {
    const response = await scim()
      .get('/scim/v2/Users/00000000-0000-4000-8000-000000000000')
      .set('Authorization', bearer())
      .expect(404);
    assert.match(response.body.schemas[0], /2\.0:Error$/);
    assert.equal(response.body.status, '404');
  });

  test('only accounts SCIM provisioned are visible through it', async () => {
    // A local account exists in the same table and must not be listed, let
    // alone be deactivatable by the directory.
    const session = await signInAs('not.scim@example.com', 'admin');
    const hidden = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'userName eq "not.scim@example.com"' })
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(hidden.body.totalResults, 0, 'a non-SCIM account must not be addressable');
    assert.ok(session.cookie);
  });
});

describe('deleting', () => {
  test('disables rather than removes, so the ticket history survives', async () => {
    const response = await scim()
      .post('/scim/v2/Users')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ userName: 'scim.leaver@example.com', displayName: 'Scim Leaver', active: true })
      .expect(201);
    const id = response.body.id as string;

    const ticket = await createTicket({
      title: 'A ticket raised before the person left',
      description: 'It must survive their account being deprovisioned by the directory.',
      priority: 'normal',
      category: 'other',
      requesterId: id,
    });

    await scim().delete('/scim/v2/Users/' + id).set('Authorization', bearer()).expect(204);

    const after = await scim().get('/scim/v2/Users/' + id).set('Authorization', bearer()).expect(200);
    assert.equal(after.body.active, false, 'the account is deactivated, not removed');
    assert.ok(ticket.id, 'and the ticket is still there');
  });

  test('removes an account with no history when told to', async () => {
    await updateSettings({ scim: { disableOnDelete: false } }, null);
    try {
      const response = await scim()
        .post('/scim/v2/Users')
        .set('Authorization', bearer())
        .type(JSON_TYPE)
        .send({ userName: 'scim.ephemeral@example.com', active: true })
        .expect(201);
      const id = response.body.id as string;

      await scim().delete('/scim/v2/Users/' + id).set('Authorization', bearer()).expect(204);
      await scim().get('/scim/v2/Users/' + id).set('Authorization', bearer()).expect(404);
    } finally {
      await updateSettings({ scim: { disableOnDelete: true } }, null);
    }
  });

  test('still only disables an account that has tickets, even then', async () => {
    await updateSettings({ scim: { disableOnDelete: false } }, null);
    try {
      const response = await scim()
        .post('/scim/v2/Users')
        .set('Authorization', bearer())
        .type(JSON_TYPE)
        .send({ userName: 'scim.hashistory@example.com', active: true })
        .expect(201);
      const id = response.body.id as string;

      await createTicket({
        title: 'Another ticket that must outlive its requester',
        description: 'Deleting the account outright would take this ticket with it.',
        priority: 'low',
        category: 'other',
        requesterId: id,
      });

      await scim().delete('/scim/v2/Users/' + id).set('Authorization', bearer()).expect(204);

      const after = await scim()
        .get('/scim/v2/Users/' + id)
        .set('Authorization', bearer())
        .expect(200);
      assert.equal(after.body.active, false, 'falls back to disabling rather than failing');
    } finally {
      await updateSettings({ scim: { disableOnDelete: true } }, null);
    }
  });
});

describe('discovery and groups', () => {
  test('ServiceProviderConfig declares what is actually supported', async () => {
    const response = await scim()
      .get('/scim/v2/ServiceProviderConfig')
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(response.body.patch.supported, true);
    assert.equal(response.body.filter.supported, true);
    assert.equal(response.body.bulk.supported, false);
    assert.equal(response.body.authenticationSchemes[0].type, 'oauthbearertoken');
  });

  test('ResourceTypes and Schemas answer', async () => {
    await scim().get('/scim/v2/ResourceTypes').set('Authorization', bearer()).expect(200);
    await scim().get('/scim/v2/Schemas').set('Authorization', bearer()).expect(200);
  });

  test('Groups is an empty list rather than a 404, so Entra does not log errors', async () => {
    const response = await scim().get('/scim/v2/Groups').set('Authorization', bearer()).expect(200);
    assert.equal(response.body.totalResults, 0);
  });

  test('writing a group is refused with an explanation', async () => {
    const response = await scim()
      .post('/scim/v2/Groups')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({ displayName: 'Helpdesk Admins' })
      .expect(501);
    assert.match(response.body.detail, /not supported/i);
  });
});

describe('error handling', () => {
  test('malformed JSON is a SCIM 400, not an HTML page', async () => {
    const response = await scim()
      .post('/scim/v2/Users')
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send('{not json')
      .expect(400);
    assert.match(response.headers['content-type'] ?? '', /scim\+json/);
    assert.match(response.body.schemas[0], /2\.0:Error$/);
  });

  test('an unknown resource is a SCIM 404', async () => {
    const response = await scim().get('/scim/v2/Nonsense').set('Authorization', bearer()).expect(404);
    assert.match(response.body.schemas[0], /2\.0:Error$/);
  });
});

describe('the settings surface', () => {
  test('a generated token is stored only as a hash', () => {
    const scimSettings = settings().scim;
    assert.equal(scimSettings.configured, true);
    assert.equal(scimSettings.tokenHash.length, 64, 'a sha-256 hex digest');
    assert.notEqual(scimSettings.tokenHash, token, 'the raw token must not be stored');
    assert.equal(scimSettings.tokenHint, token.slice(-4));
  });

  test('the endpoint is derived from APP_BASE_URL', () => {
    assert.equal(settings().scim.endpoint, 'http://localhost:3000/scim/v2');
  });
});

describe('an account that signed in through Entra before SCIM was on', () => {
  test('is found by userName and paired, not created a second time', async () => {
    await updateSettings({ oidc: { tenantId: 'tenant-pair', clientId: 'client-pair', clientSecret: 'secret-pair' } }, null);
    const signedIn = await upsertUserFromDirectory({
      issuer: 'https://login.microsoftonline.com/tenant-pair/v2.0',
      externalId: 'oid-signed-in',
      email: 'early.bird@example.com',
      upn: 'early.bird@example.com',
      displayName: 'Early Bird',
      role: 'user',
      source: 'jit',
    });

    // Entra asks before it creates; the answer is the account that exists.
    const found = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'userName eq "early.bird@example.com"' })
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(found.body.totalResults, 1);
    assert.equal(found.body.Resources[0].id, signedIn.user.id);

    // It then updates that account. Entra's default externalId is
    // mailNickname; the object id the sign-in matches on is kept.
    await scim()
      .patch('/scim/v2/Users/' + signedIn.user.id)
      .set('Authorization', bearer())
      .type(JSON_TYPE)
      .send({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [
          { op: 'Replace', path: 'externalId', value: 'earlybird' },
          { op: 'Replace', path: 'title', value: 'Analyst' },
        ],
      })
      .expect(200);
    const row = await findUserByEmail('early.bird@example.com');
    assert.equal(row?.external_id, 'oid-signed-in');
    assert.equal(row?.job_title, 'Analyst');

    // And it can sign in again exactly as before.
    const again = await upsertUserFromDirectory({
      issuer: 'https://login.microsoftonline.com/tenant-pair/v2.0',
      externalId: 'oid-signed-in',
      email: 'early.bird@example.com',
      upn: 'early.bird@example.com',
      displayName: 'Early Bird',
      role: 'user',
      source: 'jit',
    });
    assert.equal(again.user.id, signedIn.user.id);
  });

  test('a password account with the same address stays out of reach', async () => {
    const { createLocalAccount } = await import('../src/auth/local-accounts.js');
    await createLocalAccount({ displayName: 'Local Person', email: 'local.only@example.com', role: 'user', password: 'A long enough passphrase-1' }, null);
    const found = await scim()
      .get('/scim/v2/Users')
      .query({ filter: 'userName eq "local.only@example.com"' })
      .set('Authorization', bearer())
      .expect(200);
    assert.equal(found.body.totalResults, 0);
  });
});
