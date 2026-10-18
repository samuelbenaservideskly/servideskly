import './env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { before, describe } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs } from './support/session.js';
import { execute, queryOne } from '../src/db/index.js';
import { isSealedFile, openText, sealFile, sealText, TEXT_PREFIX } from '../src/lib/field-crypto.js';
import { auditAndWait } from '../src/lib/audit.js';
import { findUserById, setProfileAttributes } from '../src/services/users.js';
import { matches, type RuleRow } from '../src/services/user-groups.js';
import { queueMail } from '../src/services/mail/outbox.js';
import { createTicket } from '../src/services/tickets.js';
import { attachmentPath, readAttachment, storeAttachment } from '../src/services/attachments.js';
import { sealPlaintext } from '../src/services/data-sealing.js';

/**
 * A column as it is stored, not as the database layer hands it back: the
 * layer opens anything that starts with the prefix, so the value is read
 * behind a '#' and the '#' taken off here.
 */
async function stored(table: string, column: string, id: string): Promise<string | null> {
  const row = await queryOne<{ raw: string | null }>(`SELECT '#' || ${column} AS raw FROM ${table} WHERE id = ?`, [id]);
  return row?.raw == null ? null : row.raw.slice(1);
}

let userId = '';
before(async () => {
  await bootstrapTestDatabase();
  userId = (await signInAs('crypt.person@example.com', 'user')).user.id;
});

describe('encryption at rest', () => {
  test('a value is sealed with a prefix, opened again, and the empty string stays empty', () => {
    const sealed = sealText('Finance');
    assert.ok(sealed.startsWith(TEXT_PREFIX));
    assert.notEqual(sealText('Finance'), sealed, 'a fresh IV every time');
    assert.equal(openText(sealed), 'Finance');
    assert.equal(sealText(''), '');
    assert.equal(sealText(null), null);
    assert.equal(sealText(sealed), sealed, 'never sealed twice');
    assert.equal(openText('plain, from before'), 'plain, from before');
    assert.equal(openText(TEXT_PREFIX + 'not-ours'), '', 'a value that cannot be opened reads as empty');
  });

  test("a person's details are stored sealed, read in clear, and rules still match them", async () => {
    await setProfileAttributes(userId, { department: 'Finance', jobTitle: 'Controller', office: 'Brno', phone: '+420 777 000 111', extension1: 'E1', extension2: '', extension3: '' }, null);
    for (const column of ['department', 'job_title', 'office', 'phone', 'extension_attribute_1']) {
      assert.ok((await stored('users', column, userId))!.startsWith(TEXT_PREFIX), column + ' is ciphertext in the database');
    }
    assert.equal(await stored('users', 'extension_attribute_2', userId), '', 'empty stays empty');
    assert.doesNotMatch((await stored('users', 'department', userId))!, /Finance/);

    const user = (await findUserById(userId))!;
    assert.deepEqual([user.department, user.job_title, user.office, user.phone], ['Finance', 'Controller', 'Brno', '+420 777 000 111']);
    const rule = { attribute: 'department', operator: 'equals', value: 'finance' } as unknown as RuleRow;
    assert.equal(matches(user, rule), true, 'dynamic groups read the decrypted value');
  });

  test('the audit trail keeps who, from where and the detail sealed; the action stays readable', async () => {
    await auditAndWait({ action: 'crypt.test', actorEmail: 'crypt.person@example.com', ip: '203.0.113.9', userAgent: 'TestAgent', detail: { reason: 'Moved to Brno' } });
    const row = await queryOne<{ id: string; action: string; actor_email: string; ip: string; detail: { reason: string } }>("SELECT * FROM audit_log WHERE action = 'crypt.test'");
    assert.equal(row!.actor_email, 'crypt.person@example.com');
    assert.equal(row!.ip, '203.0.113.9');
    assert.deepEqual(row!.detail, { reason: 'Moved to Brno' }, 'decrypted, then parsed as JSON');
    for (const column of ['actor_email', 'ip', 'user_agent', 'detail']) {
      assert.ok((await stored('audit_log', column, row!.id))!.startsWith(TEXT_PREFIX), column);
    }
    // Read under an alias, as the "last changed" line does.
    const aliased = await queryOne<{ by: string }>("SELECT actor_email AS by FROM audit_log WHERE action = 'crypt.test'");
    assert.equal(aliased!.by, 'crypt.person@example.com');
  });

  test('queued mail is sealed: recipient, subject and body', async () => {
    const row = await queueMail({ mailboxId: null, ticketId: null, to: 'someone@example.com', subject: 'Your invoice', bodyHtml: '<p>Private words</p>' });
    assert.equal(row.to_address, 'someone@example.com');
    for (const column of ['to_address', 'subject', 'body_html']) {
      assert.ok((await stored('mail_outbox', column, row.id))!.startsWith(TEXT_PREFIX), column);
    }
  });

  test('an attachment is encrypted on disk and read back as it was uploaded', async () => {
    const ticket = await createTicket({ title: 'Crypt', description: 'An attachment to keep private.', priority: 'normal', category: 'other', requesterId: userId });
    const bytes = Buffer.from('a private note: the door code is 4711\n');
    const row = await storeAttachment({ ticketId: ticket.id, uploadedBy: userId, filename: 'note.txt', contentType: 'text/plain', bytes, isInternal: false });
    const onDisk = fs.readFileSync(attachmentPath(row));
    assert.ok(isSealedFile(onDisk));
    assert.ok(!onDisk.includes(Buffer.from('door code')), 'no plain text on disk');
    assert.deepEqual(await readAttachment(row), bytes);
    assert.equal(Number(row.byte_size), bytes.length, 'the size is the file as uploaded');
  });

  test('the sealing pass encrypts what is still plain - existing rows and files - and is safe to run again', async () => {
    // As data from before encryption, and a write that missed sealText().
    await execute("UPDATE users SET office = 'Plain office' WHERE id = ?", [userId]);
    const ticket = await createTicket({ title: 'Old', description: 'From before encryption at rest.', priority: 'normal', category: 'other', requesterId: userId });
    const row = await storeAttachment({ ticketId: ticket.id, uploadedBy: userId, filename: 'old.txt', contentType: 'text/plain', bytes: Buffer.from('old plain file'), isInternal: false });
    fs.writeFileSync(attachmentPath(row), 'old plain file');
    await execute("DELETE FROM seed_markers WHERE key = 'attachments_sealed_v1'");
    assert.deepEqual(await readAttachment(row), Buffer.from('old plain file'), 'a plain file is still served');

    const first = await sealPlaintext();
    assert.ok(first.values >= 1 && first.files >= 1);
    assert.ok((await stored('users', 'office', userId))!.startsWith(TEXT_PREFIX));
    assert.equal((await findUserById(userId))!.office, 'Plain office');
    assert.ok(isSealedFile(fs.readFileSync(attachmentPath(row))));
    assert.deepEqual(await readAttachment(row), Buffer.from('old plain file'));

    assert.deepEqual(await sealPlaintext(), { values: 0, files: 0 }, 'nothing left the second time');
    assert.deepEqual(sealFile(sealFile(Buffer.from('x'))).length, sealFile(Buffer.from('x')).length, 'a sealed file is not sealed again');
  });
});
