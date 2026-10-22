import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { textWithImages } from '../src/lib/inline-images.js';
import { placeInlineImages } from '../src/services/mail/inbound-attachments.js';
import { createMailbox, findMailbox } from '../src/services/mail/mailboxes.js';
import { setTransportFactory, type IncomingAttachment, type MailTransport } from '../src/services/mail/transport.js';
import { ingest } from '../src/services/mail/inbound.js';

// Pictures pasted into a ticket's text or into an email (22 Oct 2026).

const png = (bytes: number) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes, 7)]);
const inline = (filename: string, cid: string, bytes = 30 * 1024): IncomingAttachment => ({
  filename,
  contentType: 'image/png',
  content: png(bytes),
  cid,
  inline: true,
});

describe('textWithImages', () => {
  const files = [
    { id: 'a1', filename: 'shot.png', content_type: 'image/png' },
    { id: 'a2', filename: 'logo.svg', content_type: 'image/svg+xml' },
  ];

  test('a marker naming a picture becomes it; the rest is escaped text', () => {
    const html = textWithImages('Look <b>here</b>:\n[image: shot.png]\nthanks', 't1', files);
    assert.match(html, /^Look &lt;b&gt;here&lt;\/b&gt;:\n<a class="tk-inline-img" href="\/tickets\/t1\/attachments\/a1"/);
    assert.match(html, /<img src="\/tickets\/t1\/attachments\/a1\?embed" alt="shot.png" loading="lazy"><\/a>\nthanks$/);
  });

  test('a resized picture keeps its width, as an attribute, within limits', () => {
    assert.match(textWithImages('[image: shot.png | 480]', 't1', files), /alt="shot.png" width="480" loading/);
    assert.match(textWithImages('[image: shot.png | 5]', 't1', files), /width="40"/);
    assert.match(textWithImages('[image: shot.png|9999]', 't1', files), /width="4000"/);
    assert.doesNotMatch(textWithImages('[image: shot.png]', 't1', files), /width=/);
    assert.doesNotMatch(textWithImages('[image: shot.png | 480]', 't1', files), /style=/);
  });

  test('an unknown name, or a kind that is not drawn, stays as text', () => {
    assert.equal(textWithImages('[image: gone.png]', 't1', files), '[image: gone.png]');
    assert.equal(textWithImages('[image: logo.svg]', 't1', files), '[image: logo.svg]');
  });

  test('the entry\'s own file wins over an older one of the same name', () => {
    const html = textWithImages('[image: shot.png]', 't1', [{ id: 'new', filename: 'shot.png', content_type: 'image/png' }], files);
    assert.match(html, /attachments\/new/);
    assert.match(textWithImages('[image: shot.png]', 't1', [], files), /attachments\/a1/);
  });
});

describe('placeInlineImages', () => {
  test('the cid marker becomes an image marker where it was', () => {
    const text = 'Before\n[cid:image001.png@01DB]\nAfter';
    assert.equal(placeInlineImages(text, text, [inline('image001.png', 'image001.png@01DB')]), 'Before\n[image: image001.png]\nAfter');
  });

  test('a picture the text does not mark goes at the end', () => {
    assert.equal(placeInlineImages('Hello', 'Hello', [inline('shot.png', 'x1')]), 'Hello\n\n[image: shot.png]');
  });

  test('one from the quoted history that was cut is left out', () => {
    const original = 'Hello\n\nFrom: someone\n[cid:old@1]';
    assert.equal(placeInlineImages('Hello', original, [inline('old.png', 'old@1')]), 'Hello');
  });

  test('a signature logo loses its marker; an attached file is not touched', () => {
    const text = 'Hi\n[cid:logo@1]';
    const attached: IncomingAttachment = { ...inline('report.png', ''), inline: false };
    assert.equal(placeInlineImages(text, text, [inline('logo.png', 'logo@1', 2000), attached]), 'Hi');
  });

  test('two pictures called image.png get a name each', () => {
    const files = [inline('image.png', 'a'), inline('image.png', 'b'), inline('image.png', 'c')];
    const text = '[cid:a] and [cid:b] and [cid:c]';
    assert.equal(placeInlineImages(text, text, files), '[image: image.png] and [image: image-2.png] and [image: image-3.png]');
    assert.deepEqual(files.map((f) => f.filename), ['image.png', 'image-2.png', 'image-3.png']);
  });
});

describe('on the ticket page', () => {
  let app: Express;
  let agent: TestSession;
  let requester: TestSession;
  let mailboxId: string;

  const quiet: MailTransport = { send: async () => undefined, fetch: async () => [], acknowledge: async () => undefined };

  before(async () => {
    await bootstrapTestDatabase();
    setTransportFactory(() => quiet);
    app = createApp();
    agent = await signInAs('paste.agent@example.com', 'agent');
    requester = await signInAs('paste.requester@example.com', 'user');
    mailboxId = (
      await createMailbox(
        {
          name: 'Help', address: 'help@example.com', kind: 'graph', groupId: null, tenantId: 'tenant-1',
          clientId: 'client-1', clientSecret: 'super-secret', graphUserId: 'help@example.com', imapHost: '',
          imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '',
          receiveEnabled: true, isActive: true,
        },
        null,
      )
    ).id;
  });

  const page = (s: TestSession, id: string) => request.agent(app).set('Cookie', s.cookie).get('/tickets/' + id).expect(200);

  test('a picture pasted into a reply is a file and is drawn in the text', async () => {
    const created = await request
      .agent(app)
      .set('Cookie', requester.cookie)
      .post('/tickets')
      .type('form')
      .send({ _csrf: requester.csrfToken, title: 'Pasted picture', description: 'The screen shows an error, see below.' });
    const id = /\/tickets\/([0-9a-f-]{36})/.exec(created.headers.location ?? '')?.[1];
    assert.ok(id, 'ticket created');
    await request
      .agent(app)
      .set('Cookie', requester.cookie)
      .post('/tickets/' + id + '/comments')
      .field('_csrf', requester.csrfToken)
      .field('body', 'Here it is:\n[image: pasted-image-20261022-120000-1.png]')
      .attach('files', png(4096), { filename: 'pasted-image-20261022-120000-1.png', contentType: 'image/png' })
      .expect(302);
    const [file] = await query<{ id: string }>('SELECT id FROM ticket_attachments WHERE ticket_id = ?', [id]);
    assert.ok(file, 'stored as an attachment');
    const html = (await page(agent, id!)).text;
    assert.match(html, new RegExp('<img src="/tickets/' + id + '/attachments/' + file!.id + '\\?embed"'));
    assert.match(html, /data-paste-images/);

    // Drawn in the page, it is not an audit line per view; downloaded, it is.
    const embed = '/tickets/' + id + '/attachments/' + file!.id;
    await request.agent(app).set('Cookie', agent.cookie).get(embed + '?embed').expect(200);
    const count = async () =>
      (await query<{ id: string }>("SELECT id FROM audit_log WHERE action = 'ticket.attachment.downloaded' AND target_id = ?", [id])).length;
    assert.equal(await count(), 0);
    await request.agent(app).set('Cookie', agent.cookie).get(embed).expect(200);
    assert.equal(await count(), 1);
  });

  test('a picture pasted into an email is an attachment, drawn where it was', async () => {
    const mailbox = await findMailbox(mailboxId);
    assert.ok(mailbox);
    const result = await ingest(mailbox, {
      messageId: '<paste-1@x>',
      from: 'paste.requester@example.com',
      fromName: 'Requester',
      subject: 'Error on screen',
      body: 'It says this:\n[cid:image001.png@01DB]\nThanks',
      inReplyTo: '',
      references: [],
      receivedAt: new Date().toISOString(),
      attachments: [inline('image001.png', 'image001.png@01DB')],
    });
    assert.equal(result.outcome, 'ticket.created');
    const [ticket] = await query<{ description: string }>('SELECT description FROM tickets WHERE id = ?', [result.ticketId]);
    assert.equal(ticket?.description, 'It says this:\n[image: image001.png]\nThanks');
    const [file] = await query<{ id: string }>('SELECT id FROM ticket_attachments WHERE ticket_id = ?', [result.ticketId]);
    assert.ok(file);
    assert.match((await page(agent, result.ticketId!)).text, new RegExp('attachments/' + file!.id + '\\?embed'));
  });
});
