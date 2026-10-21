import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import fs from 'node:fs';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs } from './support/session.js';
import {
  attachmentPath,
  findAttachment,
  sanitiseFilename,
  verifyType,
} from '../src/services/attachments.js';
import { HttpError } from '../src/lib/errors.js';
import { queryOne } from '../src/db/index.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';

let app: Express;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 1)]);

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

/**
 * Returns a supertest agent already carrying a session for a fresh account.
 *
 * The session is minted directly by the test helper, because the application
 * ships no credential-free sign-in route.
 */
async function signIn(email: string, role: 'user' | 'agent' | 'admin') {
  const session = await signInAs(email, role);
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

async function raiseTicket(agent: request.Agent, title: string): Promise<string> {
  const form = await agent.get('/tickets/new').expect(200);
  const response = await agent
    .post('/tickets')
    .type('form')
    .send({
      _csrf: csrfFrom(form.text),
      title,
      description: 'A description long enough to satisfy the minimum length requirement.',
      priority: 'normal',
      category: 'other',
    })
    .expect(302);
  return (response.headers['location'] as string).replace('/tickets/', '');
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
});

describe('filename sanitisation', () => {
  test('strips every directory component', async () => {
    assert.equal(sanitiseFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitiseFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
    assert.equal(sanitiseFilename('/absolute/path/report.pdf'), 'report.pdf');
    assert.equal(sanitiseFilename('C:\\Users\\bob\\notes.txt'), 'notes.txt');
  });

  test('removes characters that would break a Content-Disposition header', async () => {
    const cleaned = sanitiseFilename('we"ird:name*?.png');
    assert.doesNotMatch(cleaned, /["*?:]/);
    assert.match(cleaned, /\.png$/);
  });

  test('never yields an empty or dot-only name', async () => {
    assert.equal(sanitiseFilename(''), 'attachment');
    assert.equal(sanitiseFilename('...'), 'attachment');
    assert.equal(sanitiseFilename('   '), 'attachment');
  });

  test('bounds the length while keeping the extension', async () => {
    const long = 'a'.repeat(400) + '.png';
    const cleaned = sanitiseFilename(long);
    assert.ok(cleaned.length <= 180);
    assert.match(cleaned, /\.png$/);
  });
});

describe('content type verification', () => {
  test('accepts a real PNG named .png', async () => {
    assert.deepEqual(verifyType('shot.png', PNG), {
      contentType: 'image/png',
      extension: '.png',
    });
  });

  test('rejects HTML dressed up as an image', async () => {
    // The classic stored-XSS attempt: script content under an image extension.
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    assert.throws(
      () => verifyType('payload.png', html),
      (err: unknown) => err instanceof HttpError && err.code === 'type_mismatch',
    );
  });

  test('rejects an SVG, which browsers treat as active content', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    assert.throws(
      () => verifyType('logo.svg', svg),
      (err: unknown) => err instanceof HttpError && err.code === 'type_not_allowed',
    );
  });

  test('rejects executables and scripts by extension', async () => {
    for (const name of ['tool.exe', 'run.sh', 'evil.html', 'macro.docm', 'x.php']) {
      assert.throws(
        () => verifyType(name, PDF),
        (err: unknown) => err instanceof HttpError && err.code === 'type_not_allowed',
        'expected ' + name + ' to be refused',
      );
    }
  });

  test('rejects a file with no extension at all', async () => {
    assert.throws(
      () => verifyType('README', PDF),
      (err: unknown) => err instanceof HttpError && err.code === 'no_extension',
    );
  });

  test('rejects a real image renamed to .txt', async () => {
    assert.throws(
      () => verifyType('notes.txt', PNG),
      (err: unknown) => err instanceof HttpError && err.code === 'type_mismatch',
    );
  });

  test('accepts genuine text and CSV', async () => {
    const text = Buffer.from('first line\nsecond line\ttabbed\r\n');
    assert.equal(verifyType('notes.txt', text).contentType, 'text/plain');
    assert.equal(verifyType('rows.csv', Buffer.from('a,b\n1,2\n')).contentType, 'text/csv');
  });
});

describe('upload and download', () => {
  test('stores a file, then serves it back as a download', async () => {
    const agent = await signIn('uploader@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Ticket with an attachment');
    const page = await agent.get('/tickets/' + ticketId).expect(200);

    await agent
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(page.text))
      .attach('files', PNG, { filename: 'screenshot.png', contentType: 'image/png' })
      .expect(302);

    const listed = await agent.get('/tickets/' + ticketId).expect(200);
    assert.match(listed.text, /screenshot\.png/);

    const row = await queryOne<{ id: string; content_type: string; storage_key: string }>('SELECT id, content_type, storage_key FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.ok(row);
    assert.equal(row.content_type, 'image/png');
    // The name on disk must not be the uploaded name.
    assert.doesNotMatch(row.storage_key, /screenshot/);

    // An image opens in the browser rather than landing in a downloads
    // folder - but only under the headers that make that safe.
    const viewed = await agent
      .get('/tickets/' + ticketId + '/attachments/' + row.id)
      .expect(200);
    assert.equal(viewed.headers['content-type'], 'image/png');
    assert.match(viewed.headers['content-disposition'] ?? '', /^inline;/);
    assert.equal(viewed.headers['x-content-type-options'], 'nosniff');
    assert.match(
      viewed.headers['content-security-policy'] ?? '',
      /sandbox/,
      'an opaque origin is what stops a rendered file reaching the session',
    );
    assert.ok(Buffer.from(viewed.body).equals(PNG), 'the bytes must come back intact');

    const download = await agent
      .get('/tickets/' + ticketId + '/attachments/' + row.id + '?download')
      .expect(200);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    assert.match(download.headers['content-disposition'] ?? '', /^attachment;/);
    assert.match(download.headers['content-disposition'] ?? '', /screenshot\.png/);
    assert.ok(Buffer.from(download.body).equals(PNG), 'the bytes must come back intact');
  });

  test('a type the browser must not render is still a download', async () => {
    const agent = await signIn('zipper@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Ticket with an archive');
    const page = await agent.get('/tickets/' + ticketId).expect(200);

    // A zip is the one on the allow-list that a browser would happily try to
    // do something with; docx and the rest share its signature.
    const ZIP = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(60),
    ]);

    await agent
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(page.text))
      .attach('files', ZIP, { filename: 'logs.zip', contentType: 'application/zip' })
      .expect(302);

    const row = await queryOne<{ id: string }>(
      "SELECT id FROM ticket_attachments WHERE ticket_id = ? AND filename = 'logs.zip'",
      [ticketId],
    );
    assert.ok(row);

    const served = await agent
      .get('/tickets/' + ticketId + '/attachments/' + row.id)
      .expect(200);
    assert.equal(served.headers['content-type'], 'application/octet-stream');
    assert.match(served.headers['content-disposition'] ?? '', /^attachment;/);
  });

  test('refuses a payload whose bytes contradict its extension', async () => {
    const agent = await signIn('badupload@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Ticket for a bad upload');
    const page = await agent.get('/tickets/' + ticketId).expect(200);

    // Refused by going back to the form, not by replacing the page with an
    // error: everything typed on the ticket would otherwise be lost to one
    // sentence about a file.
    await agent
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(page.text))
      .attach('files', Buffer.from('<script>alert(1)</script>'), {
        filename: 'sneaky.png',
        contentType: 'image/png',
      })
      .expect(302)
      .expect('Location', '/tickets/' + ticketId + '#reply');

    assert.equal(
      (await queryOne<{ c: number }>(
        'SELECT count(*) AS c FROM ticket_attachments WHERE ticket_id = ?',
        [ticketId],
      ))?.c,
      0,
      'nothing may be stored when verification fails',
    );

    // And the reason is waiting beside the one file picker the page has -
    // the reply box, since the redesign of 21 Oct 2026 - rather than as a
    // banner at the top of the page.
    const back = await agent.get('/tickets/' + ticketId).expect(200);
    assert.match(back.text, /do not match its \.png extension/);
    const form = /<form[^>]*id="reply"[\s\S]*?<\/form>/.exec(back.text);
    assert.ok(form, 'the reply box should be on the page');
    assert.match(form[0], /field-error/, 'the refusal belongs inside that form');
  });

  test('an upload without a CSRF token is refused', async () => {
    const agent = await signIn('nocsrf@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Ticket for a token-less upload');

    await agent
      .post('/tickets/' + ticketId + '/attachments')
      .attach('files', PDF, { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(403);
  });

  test('another requester can neither list nor download the file', async () => {
    const owner = await signIn('attowner@example.com', 'user');
    const ticketId = await raiseTicket(owner, 'Private ticket with a file');
    const page = await owner.get('/tickets/' + ticketId).expect(200);
    await owner
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(page.text))
      .attach('files', PDF, { filename: 'private.pdf', contentType: 'application/pdf' })
      .expect(302);

    const row = await queryOne<{ id: string }>('SELECT id FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.ok(row);

    const stranger = await signIn('attstranger@example.com', 'user');
    await stranger.get('/tickets/' + ticketId).expect(404);
    await stranger.get('/tickets/' + ticketId + '/attachments/' + row.id).expect(404);
  });

  test('an internal attachment is hidden from the requester', async () => {
    const requester = await signIn('intreq@example.com', 'user');
    const ticketId = await raiseTicket(requester, 'Ticket with an internal file');

    const staff = await signIn('intstaff@example.com', 'agent');
    const staffPage = await staff.get('/tickets/' + ticketId).expect(200);
    await staff
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(staffPage.text))
      .field('internal', 'on')
      .attach('files', PDF, { filename: 'internal-notes.pdf', contentType: 'application/pdf' })
      .expect(302);

    const row = await queryOne<{ id: string; is_internal: boolean }>('SELECT id, is_internal FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.ok(row);
    assert.equal(row.is_internal, true);

    const requesterView = await requester.get('/tickets/' + ticketId).expect(200);
    assert.doesNotMatch(requesterView.text, /internal-notes\.pdf/);
    await requester.get('/tickets/' + ticketId + '/attachments/' + row.id).expect(404);

    // Staff can still fetch it.
    await staff.get('/tickets/' + ticketId + '/attachments/' + row.id).expect(200);
  });

  test('a requester cannot mark their own attachment internal', async () => {
    const agent = await signIn('fakeinternal@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Ticket for an internal flag attempt');
    const page = await agent.get('/tickets/' + ticketId).expect(200);

    await agent
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(page.text))
      .field('internal', 'on')
      .attach('files', PDF, { filename: 'claim.pdf', contentType: 'application/pdf' })
      .expect(302);

    const row = await queryOne<{ is_internal: boolean }>('SELECT is_internal FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.equal(row?.is_internal, false, 'the internal flag must be ignored for a requester');
  });

  test('removing an attachment deletes the row and the file', async () => {
    const agent = await signIn('deleter@example.com', 'user');
    const ticketId = await raiseTicket(agent, 'Ticket for a deletion');
    const page = await agent.get('/tickets/' + ticketId).expect(200);
    await agent
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(page.text))
      .attach('files', PDF, { filename: 'temp.pdf', contentType: 'application/pdf' })
      .expect(302);

    const row = await queryOne<{ id: string }>('SELECT id FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.ok(row);
    const stored = await findAttachment(row.id);
    assert.ok(stored);
    const onDisk = attachmentPath(stored);
    assert.ok(fs.existsSync(onDisk), 'the file should be on disk before deletion');

    const withFile = await agent.get('/tickets/' + ticketId).expect(200);
    await agent
      .post('/tickets/' + ticketId + '/attachments/' + row.id + '/delete')
      .type('form')
      .send({ _csrf: csrfFrom(withFile.text) })
      .expect(302);

    assert.equal(await findAttachment(row.id), undefined, 'the row must no longer be visible');
    assert.equal(fs.existsSync(onDisk), false, 'the file must be gone from disk');
  });

  test('a requester cannot remove a file uploaded by someone else', async () => {
    const requester = await signIn('delreq@example.com', 'user');
    const ticketId = await raiseTicket(requester, 'Ticket for a deletion attempt');

    const staff = await signIn('delstaff@example.com', 'agent');
    const staffPage = await staff.get('/tickets/' + ticketId).expect(200);
    await staff
      .post('/tickets/' + ticketId + '/attachments')
      .field('_csrf', csrfFrom(staffPage.text))
      .attach('files', PDF, { filename: 'staff-upload.pdf', contentType: 'application/pdf' })
      .expect(302);

    const row = await queryOne<{ id: string }>('SELECT id FROM ticket_attachments WHERE ticket_id = ?', [ticketId]);
    assert.ok(row);

    const page = await requester.get('/tickets/' + ticketId).expect(200);
    await requester
      .post('/tickets/' + ticketId + '/attachments/' + row.id + '/delete')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) })
      .expect(403);

    assert.ok(await findAttachment(row.id), 'the attachment must survive the refused deletion');
  });
});

describe('attaching a file while raising the ticket', () => {
  test('the form offers a file input and is multipart', async () => {
    const agent = await signIn('raiseattach@example.com', 'user');
    const page = await agent.get('/tickets/new').expect(200);
    assert.match(page.text, /enctype="multipart\/form-data"/);
    assert.match(page.text, /name="files" type="file"/);
  });

  test('the ticket and its attachment are created together', async () => {
    const agent = await signIn('raiseattach2@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);

    const created = await agent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', 'Printer leaves a grey band down every page')
      .field('description', 'Every page comes out with a grey band down the right-hand side.')
      .field('priority', 'normal')
      .field('category', 'hardware')
      .attach('files', PNG, { filename: 'band.png', contentType: 'image/png' })
      .expect(302);

    const path = created.headers.location as string;
    const page = await agent.get(path).expect(200);
    assert.match(page.text, /band\.png/);

    const id = /\/attachments\/([0-9a-f-]{36})/.exec(page.text)?.[1];
    assert.ok(id, 'the attachment should be linked from the ticket');

    const download = await agent.get(path + '/attachments/' + id).expect(200);
    assert.ok(Buffer.from(download.body).equals(PNG), 'the bytes must come back intact');
  });

  test('several files can be attached at once', async () => {
    const agent = await signIn('raiseattach3@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);

    const created = await agent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', 'Two files attached while raising this one')
      .field('description', 'There are two files attached to this ticket from the outset.')
      .field('priority', 'low')
      .field('category', 'other')
      .attach('files', PNG, { filename: 'one.png', contentType: 'image/png' })
      .attach('files', PDF, { filename: 'two.pdf', contentType: 'application/pdf' })
      .expect(302);

    const page = await agent.get(created.headers.location as string).expect(200);
    assert.match(page.text, /one\.png/);
    assert.match(page.text, /two\.pdf/);
  });

  test('raising one without a file still works', async () => {
    const agent = await signIn('raisenofile@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', 'No attachment on this one at all')
      .field('description', 'Nothing is attached here and that has to be perfectly acceptable.')
      .field('priority', 'low')
      .field('category', 'other')
      .expect(302);
  });

  test('a file whose bytes contradict its name is refused, and no ticket is left behind', async () => {
    const agent = await signIn('raisebadfile@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);

    const response = await agent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', 'A uniquely named ticket carrying a disguised file')
      .field('description', 'The attached file claims to be a PNG but holds a script instead.')
      .field('priority', 'low')
      .field('category', 'other')
      .attach('files', Buffer.from('<script>alert(1)</script>'), {
        filename: 'sneaky.png',
        contentType: 'image/png',
      })
      .expect(400);

    // The form comes back with the error and what was typed, so the requester
    // can fix the file rather than start again.
    assert.match(response.text, /sneaky\.png/);
    assert.match(response.text, /A uniquely named ticket carrying a disguised file/);

    // And crucially the ticket was not created: verifying after the insert
    // would leave one behind on every rejected file.
    const orphan = await queryOne<{ c: number }>(
      'SELECT count(*) AS c FROM tickets WHERE title = ?',
      ['A uniquely named ticket carrying a disguised file'],
    );
    assert.equal(orphan?.c, 0, 'a rejected attachment must not leave a ticket behind');
  });

  test('a ticket that fails validation does not store its file either', async () => {
    const agent = await signIn('raiseshorttitle@example.com', 'user');
    const form = await agent.get('/tickets/new').expect(200);

    const response = await agent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('title', 'x')
      .field('description', 'The title is too short, so this submission must be refused.')
      .field('priority', 'low')
      .field('category', 'other')
      .attach('files', PNG, { filename: 'orphan.png', contentType: 'image/png' })
      .expect(400);

    assert.match(
      response.text,
      /choose it again/i,
      'the requester has to be told the file was not kept',
    );

    const stored = await queryOne<{ c: number }>(
      'SELECT count(*) AS c FROM ticket_attachments WHERE filename = ?',
      ['orphan.png'],
    );
    assert.equal(stored?.c, 0);
  });

  test('raising a ticket still requires a CSRF token', async () => {
    const agent = await signIn('raisenocsrf@example.com', 'user');
    await agent.get('/tickets/new').expect(200);
    await agent
      .post('/tickets')
      .field('title', 'Ticket submitted with no token at all')
      .field('description', 'This must be refused because it carries no CSRF token.')
      .field('priority', 'low')
      .field('category', 'other')
      .expect(403);
  });
});
