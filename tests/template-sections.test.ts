import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  addQuestion,
  addSection,
  configureField,
  createTemplate,
  ensureDefaultTemplate,
  findTemplate,
  formSections,
  isUsable,
  moveField,
  placeField,
  renameSection,
  setDefaultTemplate,
  templateLayout,
  unplaceField,
  type TemplateRow,
} from '../src/services/templates.js';
import { query } from '../src/db/index.js';

let app: Express;
let admin: TestSession;
let requester: TestSession;

const BASE = {
  summary: '',
  title: '',
  body: '',
  priority: 'normal' as const,
  category: 'other' as const,
  type: 'incident' as const,
  groupId: null,
  categoryId: null,
  fields: [],
  isActive: true,
};

function as(s: TestSession) {
  const a = request.agent(app);
  a.set('Cookie', s.cookie);
  return a;
}
function post(s: TestSession, url: string, form: Record<string, string> = {}) {
  return as(s).post(url).type('form').send({ _csrf: s.csrfToken, ...form });
}

async function fresh(id: string): Promise<TemplateRow> {
  return (await findTemplate(id))!;
}

/** title, priority | Requester details: category, description */
async function sectioned(name: string): Promise<{ id: string; section: string }> {
  const t = await createTemplate({ ...BASE, name }, null);
  await placeField(await fresh(t.id), 'title', null, null);
  await placeField(await fresh(t.id), 'priority', null, null);
  await addSection(await fresh(t.id), 'Requester details', null);
  await placeField(await fresh(t.id), 'category', null, null);
  await placeField(await fresh(t.id), 'description', null, null);
  const section = formSections(await fresh(t.id)).find((s) => s.key)!.key;
  return { id: t.id, section };
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  admin = await signInAs('sections.admin@example.com', 'admin');
  requester = await signInAs('sections.user@example.com', 'user');
});

describe('sections in the field list', () => {
  test('group the fields that follow them, and never reach templateLayout', async () => {
    const { id } = await sectioned('Grouped');
    const t = await fresh(id);
    const sections = formSections(t);
    assert.deepEqual(sections.map((s) => s.title), ['', 'Requester details']);
    assert.deepEqual(sections.map((s) => s.fields.map((f) => f.key)), [['title', 'priority'], ['category', 'description']]);
    assert.deepEqual(templateLayout(t).map((f) => f.key), ['title', 'priority', 'category', 'description']);
    assert.equal(isUsable(t), true);
  });

  test('a field is half a row unless it reads better across it, and the gear can change that', async () => {
    const { id } = await sectioned('Widths');
    const widths = Object.fromEntries(templateLayout(await fresh(id)).map((f) => [f.key, f.width]));
    assert.deepEqual(widths, { title: 'half', priority: 'half', category: 'half', description: 'full' });
    await configureField(await fresh(id), 'title', { mode: 'mandatory', width: 'full' }, null);
    assert.equal(templateLayout(await fresh(id)).find((f) => f.key === 'title')?.width, 'full');
  });

  test('a section moves with its fields, and not above the untitled ones', async () => {
    const { id, section } = await sectioned('Moving');
    await addSection(await fresh(id), 'Second', null);
    const second = formSections(await fresh(id), { keepEmpty: true }).find((s) => s.title === 'Second')!.key;
    await placeField(await fresh(id), 'item', null, null);

    await moveField(await fresh(id), second, 'up', null);
    assert.deepEqual(
      formSections(await fresh(id)).map((s) => [s.title, s.fields.map((f) => f.key)]),
      [['', ['title', 'priority']], ['Second', ['item']], ['Requester details', ['category', 'description']]],
    );
    // Already the first section: stays put rather than swallowing the top.
    await moveField(await fresh(id), second, 'up', null);
    assert.equal(formSections(await fresh(id))[1]!.title, 'Second');

    // A field moved up past a heading joins the section above.
    await moveField(await fresh(id), 'category', 'up', null);
    assert.deepEqual(formSections(await fresh(id))[1]!.fields.map((f) => f.key), ['item', 'category']);
    assert.ok(section);
  });

  test('removing a section keeps its fields, in the section above', async () => {
    const { id, section } = await sectioned('Removing');
    await renameSection(await fresh(id), section, 'Renamed', null);
    assert.equal(formSections(await fresh(id))[1]!.title, 'Renamed');
    await unplaceField(await fresh(id), section, null);
    const after = formSections(await fresh(id));
    assert.equal(after.length, 1);
    assert.deepEqual(after[0]!.fields.map((f) => f.key), ['title', 'priority', 'category', 'description']);
  });

  test('an empty section is kept for the builder and left off the ticket form', async () => {
    const t = await createTemplate({ ...BASE, name: 'Empty section' }, null);
    await placeField(await fresh(t.id), 'title', null, null);
    await addSection(await fresh(t.id), 'Nothing yet', null);
    assert.equal(formSections(await fresh(t.id)).length, 1);
    assert.equal(formSections(await fresh(t.id), { keepEmpty: true }).length, 2);
  });
});

describe('the builder and the ticket form', () => {
  test('sections are added and renamed through dialogs, and drawn on the canvas', async () => {
    const t = await createTemplate({ ...BASE, name: 'Builder sections' }, null);
    await placeField(await fresh(t.id), 'title', null, null);
    await post(admin, '/admin/settings/templates/' + t.id + '/sections', { title: 'Where you are' }).expect(302);
    const key = formSections(await fresh(t.id), { keepEmpty: true })[1]!.key;
    await post(admin, '/admin/settings/templates/' + t.id + '/sections/' + key, { title: 'Location' }).expect(302);

    const page = await as(admin).get('/admin/settings/templates/' + t.id).expect(200);
    assert.match(page.text, /class="canvas-section__title">Location</);
    assert.match(page.text, /id="add-section"/);
    assert.match(page.text, /data-section-drop=/, 'an empty section has somewhere to drop');
    assert.match(page.text, /name="width" value="full"/);

    await post(admin, '/admin/settings/templates/' + t.id + '/fields/title/configure', { mode: 'mandatory', width: 'full' }).expect(302);
    assert.equal(templateLayout(await fresh(t.id))[0]?.width, 'full');
  });

  test('the ticket form draws each section as a two-column card, and still files the ticket', async () => {
    const { id } = await sectioned('Ticket form sections');
    await setDefaultTemplate(id, null);
    const page = await as(requester).get('/tickets/new').expect(200);
    assert.match(page.text, /<h2 class="form-section__title">Requester details<\/h2>/);
    assert.match(page.text, /form-cell form-cell--half">\s*<div class="field">\s*<label for="title">/);
    assert.match(page.text, /form-cell form-cell--full">\s*<div class="field">\s*<label for="description">/);

    await post(requester, '/tickets', { title: 'Sections work', description: 'Filed from a form with sections.', priority: 'high' }).expect(302);
    const rows = await query<{ priority: string }>("SELECT priority FROM tickets WHERE title = 'Sections work'");
    assert.equal(rows[0]?.priority, 'high');
  });
});

describe('section layout options', () => {
  test('labels beside and folding are kept, and drawn on the ticket form', async () => {
    const { id, section } = await sectioned('Options');
    await renameSection(await fresh(id), section, 'Requester details', null, { labels: 'beside', collapse: 'closed' });
    // With a mandatory field it does not fold.
    await configureField(await fresh(id), 'description', { mode: 'mandatory' }, null);
    const withMandatory = formSections(await fresh(id))[1]!;
    assert.equal(withMandatory.labels, 'beside');
    assert.equal(withMandatory.collapse, 'none');

    await configureField(await fresh(id), 'description', { mode: 'optional' }, null);
    assert.equal(formSections(await fresh(id))[1]!.collapse, 'closed');

    await setDefaultTemplate(id, null);
    const page = await as(requester).get('/tickets/new').expect(200);
    assert.match(page.text, /<details class="form-section form-section--beside form-section--foldable" data-section="s:[^"]+">\s*<summary class="form-section__title">Requester details<\/summary>/);
  });

  test('the section dialog posts the options', async () => {
    const { id, section } = await sectioned('Options through the page');
    await post(admin, '/admin/settings/templates/' + id + '/sections/' + section, { title: 'Details', labels: 'beside', collapse: 'open' }).expect(302);
    const s = formSections(await fresh(id), { keepEmpty: true })[1]!;
    assert.deepEqual([s.title, s.labels], ['Details', 'beside']);
    const page = await as(admin).get('/admin/settings/templates/' + id).expect(200);
    assert.match(page.text, /Labels beside/);
  });
});

describe('a section shown only for some answers', () => {
  async function conditional(name: string) {
    const t = await createTemplate({ ...BASE, name }, null);
    await placeField(await fresh(t.id), 'title', null, null);
    await addQuestion(await fresh(t.id), 'Office', null, { fieldType: 'select', options: ['Prague', 'Brno'] });
    await addSection(await fresh(t.id), 'Brno details', null);
    await addQuestion(await fresh(t.id), 'Floor in Brno', null);
    const office = templateLayout(await fresh(t.id)).find((f) => f.shown === 'Office')!;
    const floor = templateLayout(await fresh(t.id)).find((f) => f.shown === 'Floor in Brno')!;
    await configureField(await fresh(t.id), floor.key, { mode: 'mandatory' }, null);
    const section = formSections(await fresh(t.id), { keepEmpty: true })[1]!.key;
    return { id: t.id, office, floor, section };
  }

  test('the gear saves the answers that show it; only another section\'s choice fields are offered', async () => {
    const c = await conditional('Conditional gear');
    const page = await as(admin).get('/admin/settings/templates/' + c.id).expect(200);
    assert.match(page.text, new RegExp('name="showWhen" value="' + c.office.key + '\|Brno"'));

    await post(admin, '/admin/settings/templates/' + c.id + '/sections/' + c.section, {
      title: 'Brno details', showWhenPresent: '1', showWhen: c.office.key + '|Brno',
    }).expect(302);
    assert.deepEqual(formSections(await fresh(c.id))[1]!.showWhen, [{ field: c.office.key, value: 'Brno' }]);

    // A value that is not an option is dropped, not stored.
    await post(admin, '/admin/settings/templates/' + c.id + '/sections/' + c.section, {
      title: 'Brno details', showWhenPresent: '1', showWhen: c.office.key + '|London',
    }).expect(302);
    assert.deepEqual(formSections(await fresh(c.id))[1]!.showWhen, []);
  });

  test('the form links a stylesheet that shows it once Brno is picked, and nothing in it is required in the browser', async () => {
    const c = await conditional('Conditional form');
    await renameSection(await fresh(c.id), c.section, 'Brno details', null, { showWhen: [{ field: c.office.key, value: 'Brno' }] });
    await setDefaultTemplate(c.id, null);
    const page = await as(requester).get('/tickets/new').expect(200);
    const href = /<link rel="stylesheet" href="(\/tickets\/form\/[^"]+\/sections\.css\?v=[^"]+)">/.exec(page.text)?.[1];
    assert.ok(href, 'the stylesheet is linked');
    assert.doesNotMatch(page.text, new RegExp('name="' + c.floor.input + '"[^>]*required'));

    const css = await as(requester).get(href!.replace(/&amp;/g, '&')).expect(200);
    assert.match(String(css.headers['content-type']), /text\/css/);
    assert.match(css.text, /@supports selector\(:has\(\*\)\)/);
    assert.ok(css.text.includes('select[name="' + c.office.input + '"] option[value="Brno"]:checked'), css.text);
  });

  test('the server: hidden, its mandatory field is not asked and its answer is dropped; shown, it is required', async () => {
    const c = await conditional('Conditional submit');
    await renameSection(await fresh(c.id), c.section, 'Brno details', null, { showWhen: [{ field: c.office.key, value: 'Brno' }] });

    await post(requester, '/tickets', { templateId: c.id, title: 'Prague office', [c.office.input]: 'Prague', [c.floor.input]: 'sneaky' }).expect(302);
    const prague = (await query<{ description: string }>("SELECT description FROM tickets WHERE title = 'Prague office'"))[0]!;
    assert.doesNotMatch(prague.description, /sneaky/, 'an answer in a hidden section is dropped');

    const refused = await post(requester, '/tickets', { templateId: c.id, title: 'Brno office', [c.office.input]: 'Brno' }).expect(400);
    assert.match(refused.text, /Please complete: Floor in Brno/);
    await post(requester, '/tickets', { templateId: c.id, title: 'Brno office', [c.office.input]: 'Brno', [c.floor.input]: '3' }).expect(302);
  });
});
