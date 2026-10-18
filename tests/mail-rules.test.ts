import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { createMailbox, type MailboxRow } from '../src/services/mail/mailboxes.js';
import { ingest } from '../src/services/mail/inbound.js';
import { setTransportFactory, type IncomingMessage } from '../src/services/mail/transport.js';
import { createMailRule, listMailRules, mailRuleProblems, ruleAlternatives, ruleMatches, updateMailRule, type RuleOperator } from '../src/services/mail/rules.js';
import { addTaskTemplate, createTemplate, ensureDefaultTemplate, findTemplate, placeField } from '../src/services/templates.js';

let app: Express;
let admin: TestSession;
let mailbox: MailboxRow;
let templateId = '';
let n = 0;

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

function mail(subject: string, from = 'jan@example.com', extra: Partial<IncomingMessage> = {}): IncomingMessage {
  n += 1;
  return {
    messageId: '<m' + n + '@example.com>',
    from,
    fromName: 'Jan',
    subject,
    body: 'The printer on the third floor is jammed again.',
    inReplyTo: '',
    references: [],
    receivedAt: new Date().toISOString(),
    ...extra,
  };
}

async function ticketsTitled(title: string) {
  return query<{ id: string; template_id: string | null; type: string; priority: string; external_email: string }>(
    'SELECT id, template_id, type, priority, external_email FROM tickets WHERE title = ? AND parent_id IS NULL',
    [title],
  );
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  setTransportFactory(() => ({ async send() {}, async fetch() { return []; }, async acknowledge() {} }));
  admin = await signInAs('rules.admin@example.com', 'admin');
  mailbox = await createMailbox(
    { name: 'Desk', address: 'desk@example.com', kind: 'graph', groupId: null, tenantId: 't', clientId: 'c', clientSecret: 's', graphUserId: 'desk@example.com', imapHost: '', imapPort: 993, imapTls: true, smtpHost: '', smtpPort: 587, smtpTls: false, username: '', password: '', receiveEnabled: false, isActive: true },
    null,
  );
  const t = await createTemplate(
    { summary: '', title: '', body: '', priority: 'high', category: 'other', type: 'incident', groupId: null, categoryId: null, fields: [], isActive: true, name: 'Incident by mail' },
    null,
  );
  await placeField((await findTemplate(t.id))!, 'title', null, null);
  await addTaskTemplate(t.id, { summary: '', title: 'Check the printer', body: '', priority: 'normal', category: 'other', type: 'task', groupId: null, categoryId: null, fields: [], isActive: true, name: 'Incident by mail - check' }, null);
  templateId = t.id;
  await createMailRule({ name: 'Incidents', field: 'subject', operator: 'contains', value: 'INC', templateId, dedupeHours: 24, isEnabled: true }, null);
});

describe('a semicolon separates alternatives', () => {
  // "print; printer; printing" as one rule, asked for 16 Oct 2026. Three
  // rules for one idea is three rules to keep in step.
  const of = (operator: RuleOperator, value: string) =>
    ({ field: 'subject' as const, operator, value });

  test('any one of them meets the rule', () => {
    const rule = of('contains', 'print; printer; printing');
    assert.deepEqual(ruleAlternatives(rule), ['print', 'printer', 'printing']);
    for (const subject of ['The printer is jammed', 'Cannot print', 'PRINTING is slow']) {
      assert.ok(ruleMatches(rule, mail(subject)), subject + ' should match');
    }
    assert.equal(ruleMatches(rule, mail('The scanner is offline')), false);
  });

  test('it applies to is, starts with and ends with as well', () => {
    assert.ok(ruleMatches(of('equals', 'printer ; scanner'), mail('Scanner')));
    assert.ok(ruleMatches(of('starts_with', 'INC; SR'), mail('SR-000012 new laptop')));
    assert.ok(ruleMatches(of('ends_with', 'urgent; now'), mail('Please fix NOW')));
    assert.equal(ruleMatches(of('starts_with', 'INC; SR'), mail('Re: INC-000012')), false);
  });

  test('an expression is never split: a semicolon is a character there', () => {
    // Splitting one would quietly change what it matches.
    const rule = of('matches', '^(inc|sr)[-;]\\d+');
    assert.deepEqual(ruleAlternatives(rule), ['^(inc|sr)[-;]\\d+']);
    assert.ok(ruleMatches(rule, mail('INC;000012 printer')));
  });

  test('nothing but semicolons is refused where it was typed', async () => {
    const problems = await mailRuleProblems({
      name: 'Empty', field: 'subject', operator: 'contains', value: ' ; ; ',
      templateId, dedupeHours: 24, isEnabled: true,
    });
    assert.match(problems.value ?? '', /semicolon separates alternatives/);
  });
});

describe('a mail that meets a rule', () => {
  test('raises its ticket from the mapped template, with its tasks', async () => {
    const { outcome, ticketId } = await ingest(mailbox, mail('INC printer jammed'));
    assert.equal(outcome, 'ticket.created');
    const [t] = await ticketsTitled('INC printer jammed');
    assert.equal(t?.id, ticketId);
    assert.equal(t?.template_id, templateId);
    assert.deepEqual([t?.type, t?.priority], ['incident', 'high']);
    const tasks = await query('SELECT id FROM tickets WHERE parent_id = ?', [ticketId]);
    assert.equal(tasks.length, 1);
  });

  test('the same request again from the same sender joins the open ticket', async () => {
    const again = await ingest(mailbox, mail('INC printer jammed'));
    assert.equal(again.outcome, 'comment.added');
    assert.equal((await ticketsTitled('INC printer jammed')).length, 1, 'no second ticket');
    const comments = await query('SELECT id FROM ticket_comments WHERE ticket_id = ?', [again.ticketId]);
    assert.equal(comments.length, 1);
  });

  test('the same subject from somebody else is their own ticket', async () => {
    const other = await ingest(mailbox, mail('INC printer jammed', 'eva@example.com'));
    assert.equal(other.outcome, 'ticket.created');
    assert.equal((await ticketsTitled('INC printer jammed')).length, 2);
  });

  test('a message already read, or a reply to a ticket, never raises another', async () => {
    const message = mail('INC scanner offline');
    const first = await ingest(mailbox, message);
    assert.equal((await ingest(mailbox, message)).outcome, 'ignored.duplicate');

    const ref = (await query<{ ref_prefix: string; ref_seq: number }>('SELECT ref_prefix, ref_seq FROM tickets WHERE id = ?', [first.ticketId]))[0]!;
    const reference = ref.ref_prefix + '-' + String(ref.ref_seq).padStart(6, '0');
    const reply = await ingest(mailbox, mail('Re: [' + reference + '] INC scanner offline', 'someone.else@example.com'));
    assert.equal(reply.outcome, 'comment.added');
    assert.equal(reply.ticketId, first.ticketId);
  });

  test('with the check off, every mail is a new ticket; a rule that is off is skipped', async () => {
    const rule = (await listMailRules())[0]!;
    await updateMailRule(rule.id, { name: rule.name, field: 'subject', operator: 'contains', value: 'INC', templateId, dedupeHours: 0, isEnabled: true }, null);
    await ingest(mailbox, mail('INC fax'));
    await ingest(mailbox, mail('INC fax'));
    assert.equal((await ticketsTitled('INC fax')).length, 2);

    await updateMailRule(rule.id, { name: rule.name, field: 'subject', operator: 'contains', value: 'INC', templateId, dedupeHours: 24, isEnabled: false }, null);
    await ingest(mailbox, mail('INC phone'));
    assert.equal((await ticketsTitled('INC phone'))[0]?.template_id, null, 'a plain ticket');
  });
});

describe('the pages', () => {
  test('Advanced settings holds signature stripping, and the old address follows it', async () => {
    await as(admin).get('/admin/settings/mail/advanced').expect(302).expect('location', '/admin/settings/mail/advanced/signatures');
    const page = await as(admin).get('/admin/settings/mail/advanced/signatures').expect(200);
    assert.match(page.text, /Signature stripping/);
    assert.match(page.text, /action="\/admin\/settings\/mail\/advanced\/signatures\/phrases"/);
    const other = await as(admin).get('/admin/settings/mail/automation').expect(200);
    assert.doesNotMatch(other.text, /Add a phrase/);
    await post(admin, '/admin/settings/mail/automation/phrases', { phrase: 'Kind regards' }).expect(308);
    await post(admin, '/admin/settings/mail/advanced/signatures/phrases', { phrase: 'Kind regards' }).expect(302);
  });

  test('a rule is made in its dialog, refused without a template, and can be tried', async () => {
    const refused = await post(admin, '/admin/settings/mail/advanced/rules', { name: 'Changes', field: 'subject', operator: 'starts_with', value: 'CHG', templateId: '', dedupeHours: '24', isEnabled: 'on' }).expect(400);
    assert.match(refused.text, /class="dialog dialog--open" id="new-rule"/);
    assert.match(refused.text, /Choose the template/);

    await post(admin, '/admin/settings/mail/advanced/rules', { name: 'Changes', field: 'subject', operator: 'starts_with', value: 'CHG', templateId, dedupeHours: '24', isEnabled: 'on' }).expect(302);
    const tried = await as(admin).get('/admin/settings/mail/advanced/rules?trySubject=' + encodeURIComponent('CHG-42 new switch')).expect(200);
    assert.match(tried.text, /Rule &#34;Changes&#34; - raised from Incident by mail/);

    const bad = await post(admin, '/admin/settings/mail/advanced/rules', { name: 'Broken', field: 'subject', operator: 'matches', value: '(', templateId, dedupeHours: '24' }).expect(400);
    assert.match(bad.text, /not a valid expression/);
  });

  test('a new rule starts on the default template, picked from a list rather than a prompt', async () => {
    const page = await as(admin).get('/admin/settings/mail/advanced/rules').expect(200);
    const dialog = page.text.slice(page.text.indexOf('id="new-rule"'));
    assert.doesNotMatch(dialog, /Choose a template/);
    // The first option in the new-rule dialog is the default, and it is chosen.
    const first = /<input type="radio" name="templateId" value="[^"]+" required( checked)?>\s*<span class="pick-option__name">([^<]+)<\/span>\s*<span class="small muted">([^<]+)<\/span>/.exec(dialog);
    assert.ok(first, 'a radio list');
    assert.equal(first![1], ' checked');
    assert.match(first![3]!, /default/);
    // A refused save closes again: Cancel goes to #top, which hides a reopened dialog.
    assert.match(dialog, /<a class="btn btn--quiet" href="#top">Cancel<\/a>/);
  });
});
