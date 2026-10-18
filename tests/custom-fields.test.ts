import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  addQuestion,
  answerProblems,
  createTemplate,
  ensureDefaultTemplate,
  findTemplate,
  placeField,
  templateLayout,
} from '../src/services/templates.js';

let app: Express;
let admin: TestSession;
let requester: TestSession;
let templateId = '';

const BASE = {
  summary: '', title: '', body: '', priority: 'normal' as const, category: 'other' as const,
  type: 'service_request' as const, groupId: null, categoryId: null, fields: [], isActive: true,
};

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string | string[]> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}
async function inputOf(label: string): Promise<string> {
  return templateLayout((await findTemplate(templateId))!).find((f) => f.shown === label)!.input;
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('cf.admin@example.com', 'admin');
  requester = await signInAs('cf.user@example.com', 'user');
  const t = await createTemplate({ ...BASE, name: 'New starter' }, null);
  templateId = t.id;
  await placeField((await findTemplate(t.id))!, 'title', null, null);
});

describe('custom fields', () => {
  test('are added with a type through the dialog; a choice needs options', async () => {
    const refused = await post(admin, '/admin/settings/templates/' + templateId + '/fields/add', { label: 'Office', fieldType: 'select', options: 'Prague' }).expect(400);
    assert.match(refused.text, /at least two options/);

    await post(admin, '/admin/settings/templates/' + templateId + '/fields/add', { label: 'Office', fieldType: 'select', options: 'Prague\nBrno\nBrno\n' }).expect(302);
    await post(admin, '/admin/settings/templates/' + templateId + '/fields/add', { label: 'Equipment', fieldType: 'multiselect', options: 'Laptop\nPhone\nBadge' }).expect(302);
    await post(admin, '/admin/settings/templates/' + templateId + '/fields/add', { label: 'Start date', fieldType: 'date' }).expect(302);
    await post(admin, '/admin/settings/templates/' + templateId + '/fields/add', { label: 'Notes', fieldType: 'textarea' }).expect(302);
    await post(admin, '/admin/settings/templates/' + templateId + '/fields/add', { label: 'Desk number', fieldType: 'number' }).expect(302);

    const layout = templateLayout((await findTemplate(templateId))!);
    const office = layout.find((f) => f.shown === 'Office')!;
    assert.equal(office.fieldType, 'select');
    assert.deepEqual(office.options, ['Prague', 'Brno'], 'duplicates dropped');
    assert.equal(layout.find((f) => f.shown === 'Notes')?.width, 'full');
    assert.equal(layout.find((f) => f.shown === 'Start date')?.typed, false, 'a date has no ghost text');
  });

  test('the ticket form draws each type', async () => {
    const page = await as(requester).get('/tickets/new?template=' + templateId).expect(200);
    const office = await inputOf('Office');
    assert.match(page.text, new RegExp('<select id="' + office + '" name="' + office + '"'));
    assert.match(page.text, new RegExp('type="checkbox" name="' + (await inputOf('Equipment')) + '" value="Phone"'));
    assert.match(page.text, new RegExp('name="' + (await inputOf('Start date')) + '" type="date"'));
    assert.match(page.text, new RegExp('<textarea id="' + (await inputOf('Notes')) + '"'));
  });

  test('answers are checked against their type, and written into the description', async () => {
    const t = (await findTemplate(templateId))!;
    const office = await inputOf('Office');
    const equipment = await inputOf('Equipment');
    const start = await inputOf('Start date');
    const desk = await inputOf('Desk number');
    assert.deepEqual(
      answerProblems(t, { [office]: 'London', [equipment]: 'Laptop, Jetpack', [start]: 'next week', [desk]: 'twelve' }),
      ['Office: choose one of the options', 'Equipment: choose from the options', 'Start date: enter a date', 'Desk number: enter a number'],
    );

    const forged = await post(requester, '/tickets', { templateId, title: 'Forged office', [office]: 'London' }).expect(400);
    assert.match(forged.text, /Office: choose one of the options/);

    await post(requester, '/tickets', {
      templateId,
      title: 'Jan starts',
      [office]: 'Brno',
      [equipment]: ['Laptop', 'Badge'],
      [start]: '2026-11-02',
      [desk]: '12',
    }).expect(302);
    const row = (await query<{ description: string }>("SELECT description FROM tickets WHERE title = 'Jan starts'"))[0]!;
    assert.match(row.description, /Office:\nBrno/);
    assert.match(row.description, /Equipment:\nLaptop, Badge/);
    assert.match(row.description, /Start date:\n2026-11-02/);
  });

  test('a question from before types existed is still plain text', async () => {
    const t = await createTemplate({ ...BASE, name: 'Old style' }, null);
    await addQuestion((await findTemplate(t.id))!, 'Which floor?', null);
    const field = templateLayout((await findTemplate(t.id))!).find((f) => f.shown === 'Which floor?')!;
    assert.equal(field.fieldType, undefined);
    assert.equal(field.typed, true);
  });

  test('the gear changes a field type and its options', async () => {
    const office = templateLayout((await findTemplate(templateId))!).find((f) => f.shown === 'Office')!;
    await post(admin, '/admin/settings/templates/' + templateId + '/fields/' + office.key + '/configure', {
      mode: 'mandatory', label: 'Office', fieldType: 'select', options: 'Prague\nBrno\nOstrava',
    }).expect(302);
    const after = templateLayout((await findTemplate(templateId))!).find((f) => f.key === office.key)!;
    assert.deepEqual(after.options, ['Prague', 'Brno', 'Ostrava']);
    assert.equal(after.mode, 'mandatory');
  });
});
