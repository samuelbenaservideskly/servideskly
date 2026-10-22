import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { createMailbox } from '../src/services/mail/mailboxes.js';
import { seedNotifications } from '../src/services/mail/notifications.js';
import { setTransportFactory } from '../src/services/mail/transport.js';
import { queuedMail } from './support/outbox.js';
import { addNode, configureNode, connect, createAutomation, findAutomation, graphProblems, recentRuns, setAutomationEnabled } from '../src/services/automation.js';
import { createAsset, getAsset, listAssetComments, updateAsset } from '../src/services/assets.js';
import { setManager } from '../src/services/teams.js';

/** Step 4 of assets: automations started by an asset, acting on it. */

let app: Express;
let admin: TestSession;
let holder: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  await seedNotifications();
  app = createApp();
  setTransportFactory(() => ({ async send() {}, async fetch() { return []; }, async acknowledge() {} }));
  await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  admin = await signInAs('aa.admin@example.com', 'admin');
  holder = await signInAs('aa.holder@example.com', 'user');
  const boss = await signInAs('aa.boss@example.com', 'user');
  await setManager(holder.user.id, boss.user.id, null);
});

async function triggerOf(id: string) {
  return (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
}

const setStatus = async (id: string, statusId: string) => {
  const a = (await getAsset(id))!;
  await updateAsset(id, { statusId, assignee: a.assignee_email ?? '', values: a.field_values }, null);
};

describe('asset automations', () => {
  test('a new email step goes to whoever has the asset, as its popup shows, without asking', async () => {
    const a = await createAutomation('Default recipient', 'asset.assigned', admin.user.id);
    const trigger = await triggerOf(a.id);
    const mail = await addNode(a.id, 'asset_email', 300, 100, null);
    await configureNode(a.id, mail, { subject: 'Your {{asset.Model}}', body: 'Hello' }, null);
    await connect(a.id, trigger, 'next', mail, null);
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), []);
  });

  test('status changes to Bought out: a comment on the asset, and an email to the manager with its variables', async () => {
    const a = await createAutomation('Buyout', 'asset.status.changed', admin.user.id);
    const trigger = await triggerOf(a.id);
    await configureNode(a.id, trigger, { event: 'asset.status.changed', toStatus: 'bought-out' }, null);
    const note = await addNode(a.id, 'asset_comment', 300, 100, null);
    await configureNode(a.id, note, { body: 'Bought out by {{asset.FullName}}.' }, null);
    const mail = await addNode(a.id, 'asset_email', 550, 100, null);
    await configureNode(a.id, mail, { recipient: 'manager', subject: 'Buyout: {{asset.Model}}', body: 'Hello,\n\n{{asset.FirstName}} bought out {{asset.Model}} ({{asset.SerialNumber}}).' }, null);
    await connect(a.id, trigger, 'next', note, null);
    await connect(a.id, note, 'next', mail, null);
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), []);
    await setAutomationEnabled(a.id, true, null);

    const id = await createAsset({ statusId: 'assigned', assignee: 'aa.holder@example.com', values: { Model: 'Galaxy S24', SerialNumber: 'GS-24' } }, null);
    await setStatus(id, 'in-repair');
    assert.equal((await listAssetComments(id)).length, 0, 'another status: nothing');

    await setStatus(id, 'bought-out');
    const comments = await listAssetComments(id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.body, 'Bought out by aa.holder@example.com.');
    const mails = await queuedMail((m) => m.to_address === 'aa.boss@example.com');
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.subject, 'Buyout: Galaxy S24');
    assert.match(mails[0]!.body_html, /bought out Galaxy S24 \(GS-24\)\.<\/p>/);
    assert.match(mails[0]!.body_html, /<p style="margin:0 0 12px">Hello,<\/p>/, 'paragraphs kept');
    const runs = await recentRuns(a.id);
    assert.equal(runs[0]!.outcome, 'success');
  });

  test("assigned: the asset's status is set, and that change starts nothing more", async () => {
    const a = await createAutomation('Assigned means Assigned', 'asset.assigned', admin.user.id);
    const trigger = await triggerOf(a.id);
    const step = await addNode(a.id, 'asset_status', 300, 100, null);
    await configureNode(a.id, step, { statusId: 'assigned' }, null);
    await connect(a.id, trigger, 'next', step, null);
    await setAutomationEnabled(a.id, true, null);

    const id = await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'iPad Air' } }, null);
    const a2 = (await getAsset(id))!;
    await updateAsset(id, { statusId: 'in-stock', assignee: 'aa.holder@example.com', values: a2.field_values }, null);
    assert.equal((await getAsset(id))!.status_id, 'assigned');
    assert.equal((await recentRuns(a.id)).length, 1, 'run once');
  });

  test('a ticket step in an asset run stops it, saying why', async () => {
    const a = await createAutomation('Wrong kind', 'asset.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const step = await addNode(a.id, 'add_comment', 300, 100, null);
    await configureNode(a.id, step, { body: 'Hello' }, null);
    await connect(a.id, trigger, 'next', step, null);
    await setAutomationEnabled(a.id, true, null);
    await createAsset({ statusId: 'in-stock', assignee: '', values: { Model: 'Kindle' } }, null);
    const run = (await recentRuns(a.id))[0]!;
    assert.equal(run.outcome, 'failure');
    assert.match(run.steps, /needs a ticket/);
  });

  test('the editor offers an asset trigger the asset steps, and a ticket trigger not', async () => {
    const assetOne = await createAutomation('Editor asset', 'asset.created', admin.user.id);
    await addNode(assetOne.id, 'asset_comment', 300, 100, null);
    const ticketOne = await createAutomation('Editor ticket', 'ticket.created', admin.user.id);
    const page = (id: string) => request(app).get('/admin/settings/advanced/automation/' + id).set('Cookie', admin.cookie).expect(200);
    const forAsset = (await page(assetOne.id)).text;
    assert.match(forAsset, /value="asset_email"/);
    assert.doesNotMatch(forAsset, /value="set_priority"/);
    assert.match(forAsset, /\{\{asset\.SerialNumber\}\}/);
    const forTicket = (await page(ticketOne.id)).text;
    assert.match(forTicket, /value="set_priority"/);
    assert.doesNotMatch(forTicket, /value="asset_email"/);
  });
});
