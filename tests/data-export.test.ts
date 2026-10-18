import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { ensureLocalAdmin, LOCAL_EXTERNAL_ID } from '../src/auth/local-accounts.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { ensureDefaultTemplate } from '../src/services/templates.js';
import { createTicket, listTickets } from '../src/services/tickets.js';
import { createGroup } from '../src/services/groups.js';
import { query } from '../src/db/index.js';
import { findUserByEmail, findUserById, listUsers } from '../src/services/users.js';
import { anonymousUserId } from '../src/services/erasure.js';
import {
  DELETE_PHRASE,
  deleteEverything,
  exportEverything,
  exportSize,
} from '../src/services/data-export.js';

/**
 * Export everything, and delete everything (asked for 16 Oct 2026).
 *
 * The delete is the only irreversible action in the application, so the two
 * things worth testing are that it needs the words typed, and that what it
 * leaves is a service desk somebody can still sign in to and use.
 */

let app: Express;
let admin: TestSession;

const BASE = '/admin/settings/advanced/data';

/** The file names a zip holds, read from its central directory. */
function namesIn(zip: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i < zip.length - 4; i += 1) {
    if (zip.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLength = zip.readUInt16LE(i + 28);
    names.push(zip.subarray(i + 46, i + 46 + nameLength).toString('utf8'));
  }
  return names;
}

/** One file out of a zip, by name. */
function fileIn(zip: Buffer, wanted: string): Buffer | undefined {
  for (let i = 0; i < zip.length - 4; i += 1) {
    if (zip.readUInt32LE(i) !== 0x04034b50) continue;
    const nameLength = zip.readUInt16LE(i + 26);
    const extraLength = zip.readUInt16LE(i + 28);
    const size = zip.readUInt32LE(i + 18);
    const name = zip.subarray(i + 30, i + 30 + nameLength).toString('utf8');
    const start = i + 30 + nameLength + extraLength;
    if (name === wanted) return inflateRawSync(zip.subarray(start, start + size));
  }
  return undefined;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  await ensureLocalAdmin();
  app = createApp();
  admin = await signInAs('export.admin@example.com', 'admin');

  const requester = await signInAs('export.user@example.com', 'user');
  await createGroup({ name: 'Exported group', description: '', isActive: true }, null);
  await createTicket({
    title: 'Something to export',
    description: 'A ticket that should be in the zip.',
    priority: 'normal',
    category: 'other',
    requesterId: requester.user.id,
  });
});

describe('export everything', () => {
  test('is a zip of every table, with the tickets in it', async () => {
    const { zip, summary } = await exportEverything(null);
    const names = namesIn(zip);
    assert.ok(names.includes('data.json'));
    assert.ok(summary.rows > 0);

    const document = JSON.parse(String(fileIn(zip, 'data.json')));
    assert.ok(document.tables.tickets, 'the tickets table is there');
    assert.ok(document.tables.users);
    assert.match(JSON.stringify(document.tables.tickets), /Something to export/);
    assert.equal(document.tables.sessions, undefined, 'who is signed in is not data');
  });

  test('the page offers it, and the download is a zip', async () => {
    const page = await request.agent(app).set('Cookie', admin.cookie).get(BASE).expect(200);
    assert.match(page.text, /Download everything/);
    assert.match(page.text, /Delete all data/);

    const file = await request.agent(app).set('Cookie', admin.cookie)
      .get(BASE + '/export').expect(200);
    assert.match(file.headers['content-type'] ?? '', /zip/);
    assert.match(file.headers['content-disposition'] ?? '', /attachment; filename="service-desk-/);
  });
});

describe('delete everything', () => {
  test('every administrator is offered it, behind the typed confirmation', async () => {
    const page = await request.agent(app).set('Cookie', admin.cookie).get(BASE).expect(200);
    assert.match(page.text, /href="#delete-everything"/);
    const refused = await request.agent(app).set('Cookie', admin.cookie)
      .post(BASE + '/delete').type('form')
      .send({ _csrf: admin.csrfToken, phrase: 'nope' })
      .expect(400);
    assert.match(refused.text, /dialog--open/);
    const tickets = await query<{ n: number }>('SELECT count(*) AS n FROM tickets');
    assert.ok(Number(tickets[0]?.n) > 0, 'nothing was deleted');
  });

  test('needs the words typed, exactly', async () => {
    await assert.rejects(() => deleteEverything('yes', null), /DELETE EVERYTHING/);
    await assert.rejects(() => deleteEverything('delete everything', null), /capitals/);
    const still = await exportSize();
    assert.ok(still.rows > 0, 'nothing was deleted');
  });

  test('and then there is nothing left but a way back in', async () => {
    // The placeholder erased people are filed under exists here, so the
    // wipe has something to keep.
    await anonymousUserId();
    const before = await exportSize();
    const summary = await deleteEverything(DELETE_PHRASE, null);
    assert.ok(summary.rows >= before.rows - 1);

    const tickets = await query('SELECT id FROM tickets');
    assert.equal(tickets.length, 0);
    assert.equal((await query('SELECT id FROM technician_groups')).length, 0);
    assert.equal((await query('SELECT id FROM ticket_templates')).length, 0);

    // The break-glass administrator survives: an empty service desk nobody
    // can sign in to is not a service desk.
    const breakGlass = await query<{ id: string; role: string }>(
      'SELECT id, role FROM users WHERE role = ? AND external_id = ?',
      ['admin', LOCAL_EXTERNAL_ID],
    );
    assert.equal(breakGlass.length, 1, 'exactly the one account that lets somebody back in');

    // ...and the ordinary accounts do not: what is listed is that one.
    const people = await listUsers({ limit: 50, offset: 0 });
    assert.deepEqual(people.rows.map((p) => p.role_locked), [true], 'only the break-glass account');
    assert.equal(await findUserByEmail('export.user@example.com'), undefined);

    // The hidden placeholders are kept: rows may point at them again.
    const reserved = await query<{ issuer: string }>(
      "SELECT issuer FROM users WHERE issuer LIKE 'urn:helpdesk:%' AND issuer <> 'urn:helpdesk:local'",
    );
    assert.ok(reserved.length >= 1);
  });

  test('the service desk still starts: a template can be made again', async () => {
    const template = await ensureDefaultTemplate();
    assert.ok(template, 'start-up would create the default form again');
    const admins = await query<{ id: string }>("SELECT id FROM users WHERE role = 'admin'");
    const viewer = await findUserById(String(admins[0]?.id));
    assert.ok(viewer);
    const page = await listTickets(viewer, { scope: 'all', status: 'any', page: 1, perPage: 10 });
    assert.equal(page.items.length, 0, 'an empty queue, not a broken one');
  });
});
