import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { queryOne } from '../src/db/index.js';
import { createTemplate, findTemplate, placeField, templateLayout } from '../src/services/templates.js';

const LIBRARY = '/admin/settings/templates/custom-fields';
let app: Express;
let admin: TestSession;
let one = '';
let two = '';

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}
async function template(name: string): Promise<string> {
  const t = await createTemplate(
    { summary: '', title: '', body: '', priority: 'normal', category: 'other', type: 'service_request', groupId: null, categoryId: null, fields: [], isActive: true, name },
    null,
  );
  await placeField((await findTemplate(t.id))!, 'title', null, null);
  return t.id;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();
  admin = await signInAs('cf.admin@example.com', 'admin');
  one = await template('Laptop request');
  two = await template('Desk move');
});

describe('the custom-field library', () => {
  test('a field is written once and placed on two templates; a choice needs two options', async () => {
    const refused = await post(admin, LIBRARY, { label: 'Office', fieldType: 'select', options: 'Prague' }).expect(400);
    assert.match(refused.text, /at least two options/);
    assert.match(refused.text, /class="dialog dialog--open" id="new-field"/);

    await post(admin, LIBRARY, { label: 'Office', fieldType: 'select', options: 'Prague\nBrno' }).expect(302);
    const field = (await queryOne<{ id: string }>("SELECT id FROM custom_fields WHERE label = 'Office'"))!;

    const builder = await as(admin).get('/admin/settings/templates/' + one).expect(200);
    assert.match(builder.text, /From the library/);

    for (const id of [one, two]) {
      await post(admin, '/admin/settings/templates/' + id + '/fields/library', { libraryId: field.id }).expect(302);
    }
    const copy = templateLayout((await findTemplate(one))!).find((f) => f.libraryId === field.id)!;
    assert.equal(copy.label, 'Office');
    assert.deepEqual(copy.options, ['Prague', 'Brno']);

    // Twice on one form is refused, beside the builder rather than as an error page.
    await post(admin, '/admin/settings/templates/' + one + '/fields/library', { libraryId: field.id }).expect(302);
    assert.equal(templateLayout((await findTemplate(one))!).filter((f) => f.libraryId === field.id).length, 1);

    const list = await as(admin).get(LIBRARY).expect(200);
    assert.match(list.text, /Desk move, Laptop request|Laptop request, Desk move/);
  });

  test('an edit rewrites every copy, keeping what each template made of it', async () => {
    const field = (await queryOne<{ id: string }>("SELECT id FROM custom_fields WHERE label = 'Office'"))!;
    const t = (await findTemplate(one))!;
    const key = templateLayout(t).find((f) => f.libraryId === field.id)!.key;
    // Laptop request makes it mandatory; the library edit must not undo that.
    const { configureField } = await import('../src/services/templates.js');
    await configureField(t, key, { mode: 'mandatory' }, null);

    await post(admin, LIBRARY + '/' + field.id, { label: 'Which office?', fieldType: 'select', options: 'Prague\nBrno\nOstrava' }).expect(302);
    const a = templateLayout((await findTemplate(one))!).find((f) => f.libraryId === field.id)!;
    const b = templateLayout((await findTemplate(two))!).find((f) => f.libraryId === field.id)!;
    assert.equal(a.label, 'Which office?');
    assert.deepEqual(b.options, ['Prague', 'Brno', 'Ostrava']);
    assert.equal(a.mode, 'mandatory', 'kept');
  });

  test('"Also save to the library" from the builder; deleting detaches the copies', async () => {
    await post(admin, '/admin/settings/templates/' + one + '/fields/add', { label: 'Asset tag', fieldType: 'text', saveToLibrary: 'on' }).expect(302);
    const entry = (await queryOne<{ id: string }>("SELECT id FROM custom_fields WHERE label = 'Asset tag'"))!;
    assert.ok(templateLayout((await findTemplate(one))!).some((f) => f.libraryId === entry.id));

    // The same label again is refused in the dialog.
    const again = await post(admin, '/admin/settings/templates/' + two + '/fields/add', { label: 'Asset tag', fieldType: 'text', saveToLibrary: 'on' }).expect(400);
    assert.match(again.text, /already has a field with that label/);

    await post(admin, LIBRARY + '/' + entry.id + '/delete').expect(302);
    const kept = templateLayout((await findTemplate(one))!).find((f) => f.label === 'Asset tag');
    assert.ok(kept, 'still on the form');
    assert.equal(kept!.libraryId, undefined, 'as a field of its own');
  });
});
