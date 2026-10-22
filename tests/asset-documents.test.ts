import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { zipFiles } from '../src/lib/xlsx.js';
import { unzip } from '../src/lib/unzip.js';
import { bracedInDocx, fillDocx, isDocx } from '../src/lib/docx.js';
import { docxToPdf } from '../src/lib/pdf-convert.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { seedNotifications } from '../src/services/mail/notifications.js';
import { setTransportFactory } from '../src/services/mail/transport.js';
import { queuedMail } from './support/outbox.js';
import { addNode, configureNode, connect, createAutomation, findAutomation, recentRuns, setAutomationEnabled } from '../src/services/automation.js';
import { createAsset, getAsset, updateAsset } from '../src/services/assets.js';
import { addDocumentTemplate, findAssetFile, listGeneratedFor, readAssetFile } from '../src/services/asset-documents.js';

/** Step 5 of assets: Word documents with variables, filled in and attached. */

let app: Express;
let admin: TestSession;

/** A minimal .docx: enough parts for Word, one paragraph per argument. */
function docx(...paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => '<w:p>' + p + '</w:p>').join('');
  return zipFiles([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ['word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>')],
  ]);
}
const run = (text: string, bold = false) => '<w:r>' + (bold ? '<w:rPr><w:b/></w:rPr>' : '') + '<w:t>' + text + '</w:t></w:r>';
const textOf = (bytes: Buffer) => {
  const xml = unzip(bytes).find(([n]) => n === 'word/document.xml')![1].toString('utf8');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
};

before(async () => {
  await bootstrapTestDatabase();
  await seedNotifications();
  app = createApp();
  setTransportFactory(() => ({ async send() {}, async fetch() { return []; }, async acknowledge() {} }));
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  admin = await signInAs('docs.admin@example.com', 'admin');
  await signInAs('docs.holder@example.com', 'user');
});

describe('filling a Word document', () => {
  test('a variable Word split across runs is filled, and values are escaped', () => {
    const filled = fillDocx(docx(run('Dear {{First') + run('Name', true) + run('}}, you bought {{Model}}.'), run('{{ Unknown }} stays')), { FirstName: 'Ana & <Co>', Model: 'Pixel 9' });
    assert.equal(textOf(filled), 'Dear Ana &amp; &lt;Co&gt;, you bought Pixel 9.{{ Unknown }} stays');
    assert.ok(isDocx(filled));
    assert.deepEqual(bracedInDocx(docx(run('{{Frist') + run(' name}} and {{Model}}'))).sort(), ['{{Frist name}}', '{{Model}}']);
  });

  test('without LibreOffice there is no PDF, and that is not an error', async () => {
    const before = process.env.SOFFICE_PATH;
    delete process.env.SOFFICE_PATH;
    assert.equal(await docxToPdf(docx(run('x'))), null);
    process.env.SOFFICE_PATH = 'C:\\nowhere\\soffice.exe';
    assert.equal(await docxToPdf(docx(run('x'))), null);
    if (before === undefined) delete process.env.SOFFICE_PATH;
    else process.env.SOFFICE_PATH = before;
  });
});

describe('Settings - Assets - Documents', () => {
  test('an upload is checked: the variables it uses, and what is not one', async () => {
    const res = await request(app)
      .post('/admin/settings/assets/documents')
      .set('Cookie', admin.cookie)
      .field('_csrf', admin.csrfToken)
      .attach('file', docx(run('Hello {{FirstName}}, {{Frist name}} {{SerialNumber}}')), 'Buyout letter.docx')
      .expect(200);
    assert.match(res.text, /Buyout letter/);
    assert.match(res.text, /\{\{FirstName\}\} \{\{SerialNumber\}\}/);
    assert.match(res.text, /\{\{Frist name\}\} is not a variable/);
    const bad = await request(app)
      .post('/admin/settings/assets/documents')
      .set('Cookie', admin.cookie)
      .field('_csrf', admin.csrfToken)
      .attach('file', Buffer.from('not a document'), 'letter.docx')
      .expect(400);
    assert.match(bad.text, /Upload a Word document/);
  });
});

describe('an email with a document', () => {
  test('the document is filled in for the asset, kept on it, and attached', async () => {
    const template = await addDocumentTemplate('Buyout.docx', docx(run('{{FullName}} buys {{Model}} ({{SerialNumber}}) on {{Today}}.')), null);
    const a = await createAutomation('Buyout letter', 'asset.status.changed', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
    await configureNode(a.id, trigger, { event: 'asset.status.changed', toStatus: 'bought-out' }, null);
    const mail = await addNode(a.id, 'asset_email', 300, 100, null);
    await configureNode(a.id, mail, { recipient: 'assignee', subject: 'Your buyout', body: 'Attached.', documentId: template.id }, null);
    await connect(a.id, trigger, 'next', mail, null);
    await setAutomationEnabled(a.id, true, null);

    const id = await createAsset({ statusId: 'assigned', assignee: 'docs.holder@example.com', values: { Model: 'XPS 13', SerialNumber: 'XPS-1' } }, null);
    const asset = (await getAsset(id))!;
    await updateAsset(id, { statusId: 'bought-out', assignee: 'docs.holder@example.com', values: asset.field_values }, null);

    const runs = await recentRuns(a.id);
    assert.equal(runs[0]!.outcome, 'success');
    assert.match(runs[0]!.steps, /as \.docx: no PDF converter is set up/);
    const kept = await listGeneratedFor(id);
    assert.equal(kept.length, 1);
    assert.match(kept[0]!.name, /^Buyout - XPS 13 \(XPS-1\)\.docx$/);
    assert.match(textOf(await readAssetFile(kept[0]!)), /^docs\.holder@example\.com buys XPS 13 \(XPS-1\) on \d{4}-\d{2}-\d{2}\.$/);

    const queued = (await queuedMail((m) => m.to_address === 'docs.holder@example.com' && m.subject === 'Your buyout'))[0]!;
    const ids = (queued as unknown as { asset_file_ids: string[] }).asset_file_ids;
    assert.deepEqual(ids, [kept[0]!.id]);
    assert.ok(await findAssetFile(ids[0]!));

    const page = await request(app).get('/inventory/' + id).set('Cookie', admin.cookie).expect(200);
    assert.match(page.text, /Documents sent/);
    const download = await request(app).get('/inventory/' + id + '/files/' + kept[0]!.id).set('Cookie', admin.cookie).expect(200);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
  });
});
