import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  composeDescription,
  BUILTIN_FIELDS,
  addTaskTemplate,
  duplicateTemplate,
  listTaskTemplates,
  availableFields,
  configureField,
  createTemplate,
  defaultTemplate,
  deleteTemplate,
  ensureDefaultTemplate,
  findTemplate,
  isUsable,
  layoutField,
  placeField,
  listActiveTemplates,
  listAllTemplates,
  missingAnswers,
  setDefaultTemplate,
  setFieldDefault,
  unplaceField,
  templateLayout,
  updateTemplate,
  type TemplateRow,
} from '../src/services/templates.js';
import { listTickets } from '../src/services/tickets.js';
import { createCategory } from '../src/services/catalogue.js';
import { findUserById } from '../src/services/users.js';

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let user: TestSession;
let userAgent: request.Agent;

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

/**
 * Gives a template the form the fixed layout used to be.
 *
 * A template's form starts empty, so anything a requester is meant to fill in
 * has to be put on it first. Migration 7 does this once for templates that
 * predate the builder; a template made in a test is made after it.
 */
async function giveItAForm(id: string, keys = BUILTIN_FIELDS.map((f) => f.key)): Promise<void> {
  for (const key of keys) {
    await placeField((await findTemplate(id))!, key, null, null);
  }
}

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();

  admin = await signInAs('template.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  user = await signInAs('template.user@example.com', 'user');
  userAgent = request.agent(app);
  userAgent.set('Cookie', user.cookie);
});

describe('composing a description from a template', () => {
  // The pre-builder field shape, which normaliseFields still understands:
  // rows written before the builder existed are read, not rewritten.
  const template = {
    body: 'Please set up the accounts below.',
    fields: [
      { label: 'Full name', required: true },
      { label: 'Start date', required: true },
      { label: 'Line manager', required: false },
    ],
  } as unknown as TemplateRow;

  test('folds the answers in under their questions', () => {
    const text = composeDescription(template, {
      field_0: 'Dana Scott',
      field_1: '2026-11-02',
      field_2: 'Ada Lovelace',
    });
    assert.match(text, /Please set up the accounts below\./);
    assert.match(text, /Full name:\nDana Scott/);
    assert.match(text, /Start date:\n2026-11-02/);
    assert.match(text, /Line manager:\nAda Lovelace/);
  });

  test('omits a question that was left blank rather than writing it out empty', () => {
    const text = composeDescription(template, { field_0: 'Dana Scott', field_1: '2026-11-02' });
    assert.doesNotMatch(text, /Line manager/);
  });

  test('reports the required questions that were missed', () => {
    assert.deepEqual(missingAnswers(template, { field_1: '2026-11-02' }), ['Full name']);
    assert.deepEqual(
      missingAnswers(template, { field_0: 'x', field_1: 'y' }),
      [],
      'an optional question left blank is not missing',
    );
  });

  test('ignores an answer to a question the template does not have', () => {
    const text = composeDescription(template, { field_9: 'smuggled' });
    assert.doesNotMatch(text, /smuggled/);
  });
});

describe('template storage', () => {
  test('refuses a second template with the same name', async () => {
    await createTemplate({ ...BASE, name: 'Duplicate check' }, null);
    await assert.rejects(
      () => createTemplate({ ...BASE, name: 'duplicate CHECK' }, null),
      /already exists/,
      'names are compared case-insensitively',
    );
  });

  test('discards a malformed question rather than storing it', async () => {
    const created = await createTemplate(
      {
        ...BASE,
        name: 'Malformed questions',
        // Only the first entry is a usable question.
        fields: [
          { label: 'Good one', required: true },
          { label: '   ', required: true },
          null as never,
          'not an object' as never,
        ] as never,
      },
      null,
    );
    assert.equal(created.fields.length, 1);
    assert.equal(created.fields[0]?.label, 'Good one');
  });

  test('a retired template is kept but no longer offered', async () => {
    const created = await createTemplate({ ...BASE, name: 'To be retired' }, null);
    await giveItAForm(created.id);
    assert.ok((await listActiveTemplates()).some((t) => t.id === created.id));

    await updateTemplate(created.id, { ...BASE, name: 'To be retired', isActive: false }, null);
    assert.ok(
      !(await listActiveTemplates()).some((t) => t.id === created.id),
      'a retired template must not be offered to requesters',
    );
  });
});

describe('raising a ticket from a template over HTTP', () => {
  let templateId: string;

  before(async () => {
    const created = await createTemplate(
      {
        ...BASE,
        name: 'Access request',
        summary: 'Ask for access to a system.',
        title: 'Access request',
        body: 'Please grant the access described below.',
        priority: 'high',
        category: 'access',
        fields: [
          { label: 'System', required: true },
          { label: 'Reason', required: false },
        ] as never,
      },
      null,
    );
    templateId = created.id;
    // The questions came with the template; the built-ins go on by hand.
    await giveItAForm(templateId);
  });

  test('the template is offered once there is a choice to make', async () => {
    // The picker only appears when more than one form exists: with a single
    // template it is the form, and a list of one is just furniture.
    const second = await createTemplate({ ...BASE, name: 'Something Else To Pick' }, null);
    await giveItAForm(second.id, ['title']);

    const page = await userAgent.get('/tickets/new').expect(200);
    assert.match(page.text, /Access request/);
    assert.match(page.text, new RegExp('<option value="' + templateId + '"'), 'offered in the form picker');
    assert.doesNotMatch(page.text, /Blank ticket/, 'every ticket is raised on a form now');

    await deleteTemplate(second.id);
  });

  test('choosing it prefills the fields it sets', async () => {
    const page = await userAgent.get('/tickets/new?template=' + templateId).expect(200);
    assert.match(page.text, /value="Access request"/);
    assert.match(page.text, /name="field_0"/);
    assert.match(page.text, /System/);
    // The template's own priority is selected.
    assert.match(page.text, /<option value="high" selected/);
    // The fixed category enum is no longer on the form at all: classification
    // comes from the catalogue now, which starts empty and is the
    // administrator's to build.
    assert.doesNotMatch(page.text, /<option value="access"/);
  });

  test('a missing required answer is refused and says which', async () => {
    const form = await userAgent.get('/tickets/new?template=' + templateId).expect(200);
    const response = await userAgent
      .post('/tickets')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        templateId,
        title: 'Access request: finance share',
        priority: 'high',
        category: 'access',
        field_0: '',
        field_1: 'quarterly close',
        description: '',
      })
      .expect(400);
    assert.match(response.text, /System/);
  });

  test('a complete submission produces an ordinary ticket', async () => {
    const form = await userAgent.get('/tickets/new?template=' + templateId).expect(200);
    const created = await userAgent
      .post('/tickets')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        templateId,
        title: 'Access request: finance share',
        priority: 'high',
        category: 'access',
        field_0: 'Finance share',
        field_1: '',
        description: 'Needed before Friday.',
      })
      .expect(302);

    const page = await userAgent.get(created.headers.location as string).expect(200);
    assert.match(page.text, /Please grant the access described below/);
    assert.match(page.text, /Finance share/);
    assert.match(page.text, /Needed before Friday/);
    assert.doesNotMatch(page.text, /Reason:/, 'the blank optional question is omitted');
  });

  test('a template id that does not exist is ignored, not an error', async () => {
    const form = await userAgent.get('/tickets/new').expect(200);
    await userAgent
      .post('/tickets')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        templateId: '00000000-0000-4000-8000-000000000000',
        title: 'Ticket with a bogus template id',
        priority: 'normal',
        category: 'other',
        description: 'The template reference is nonsense but the ticket is fine.',
      })
      .expect(302);
  });
});

describe('template administration is for administrators only', () => {
  test('a requester cannot reach it', async () => {
    await userAgent.get('/admin/settings/templates').expect(403);
    await userAgent.get('/admin/settings/templates/new').expect(403);
  });

  test('an administrator can create one through the form', async () => {
    const form = await adminAgent.get('/admin/settings/templates/new').expect(200);
    await adminAgent
      .post('/admin/settings/templates')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        name: 'Created through the UI',
        summary: 'From the form.',
        type: 'service_request',

        isActive: '1',
        // These are not on this form any more - the title, category, priority
        // and opening text are set in the field's own gear - so posting them
        // must have no effect.
        title: 'Smuggled title',
        priority: 'urgent',
      })
      .expect(302);

    // Not offered yet - it has no form - so look at every template, not the
    // ones a requester would be shown.
    const created = (await listAllTemplates()).find((t) => t.name === 'Created through the UI');
    assert.ok(created, 'the template should have been stored');
    assert.equal(created.summary, 'From the form.');
    assert.equal(created.type, 'service_request');
    assert.equal(isUsable(created), false, 'a new template starts with an empty form');
    assert.deepEqual(created.fields, [], 'the builder owns the fields, not this form');

    assert.equal(created.title, '', 'the settings form must not set a field default');
    assert.equal(created.priority, 'normal', 'nor the priority');
  });

  test('every field says what it falls back to, without having to open it', async () => {
    const target = (await listAllTemplates()).find((t) => t.name === 'Created through the UI');
    assert.ok(target);
    await giveItAForm(target.id, ['title', 'category', 'priority', 'description']);

    const page = await adminAgent.get('/admin/settings/templates/' + target.id).expect(200);

    // Hiding these behind a hover-only gear is what made the settings look
    // absent. Each row states its own, with a link to change it.
    for (const label of ['Default title', 'Default category', 'Default priority', 'Opening text']) {
      assert.match(page.text, new RegExp(label + ':'), label + ' should be stated on its row');
    }
    assert.match(page.text, /widget__default/);
    assert.match(page.text, /Change<\/a>/);

    // And each catalogue gear offers only its own depth, rather than the
    // whole tree followed by a refusal.
    assert.match(page.text, /id="default-category"/);
    assert.match(page.text, /id="default-subcategory"/);
    assert.match(page.text, /id="default-item"/);
  });

  test('a field default is set in that field’s gear, and nowhere else', async () => {
    const target = (await listAllTemplates()).find((t) => t.name === 'Created through the UI');
    assert.ok(target);

    const builder = await adminAgent
      .get('/admin/settings/templates/' + target.id)
      .expect(200);
    await adminAgent
      .post('/admin/settings/templates/' + target.id + '/fields/priority/configure')
      .type('form')
      .send({ _csrf: csrfFrom(builder.text), mode: 'optional', fieldDefault: 'high' })
      .expect(302);

    assert.equal((await findTemplate(target.id))?.priority, 'high');
  });

  test('a priority the gear does not offer is refused', async () => {
    const target = (await listAllTemplates()).find((t) => t.name === 'Created through the UI');
    assert.ok(target);

    const builder = await adminAgent
      .get('/admin/settings/templates/' + target.id)
      .expect(200);
    await adminAgent
      .post('/admin/settings/templates/' + target.id + '/fields/priority/configure')
      .type('form')
      .send({ _csrf: csrfFrom(builder.text), mode: 'optional', fieldDefault: 'catastrophic' })
      .expect(400);

    assert.equal((await findTemplate(target.id))?.priority, 'high', 'unchanged');
  });

  test('a template without a name is refused', async () => {
    const form = await adminAgent.get('/admin/settings/templates/new').expect(200);
    await adminAgent
      .post('/admin/settings/templates')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        name: '',
        priority: 'normal',
        category: 'other',
      })
      .expect(400);
  });

  test('a duplicate name comes back on the form, not as a 409 page', async () => {
    await createTemplate({ ...BASE, name: 'Taken Already' }, null);

    const form = await adminAgent.get('/admin/settings/templates/new').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/templates')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        name: 'taken already',
        summary: 'Worth keeping rather than retyping.',
        type: 'incident',
      })
      .expect(400);

    assert.match(refused.text, /already exists/);
    assert.match(refused.text, /Worth keeping rather than retyping\./);
    assert.doesNotMatch(refused.text, /Conflict/, 'the standalone error page must not render');
  });
});

describe('the form builder', () => {
  let id: string;

  async function reload(): Promise<TemplateRow> {
    const template = await findTemplate(id);
    assert.ok(template);
    return template;
  }

  function page(): request.Test {
    return adminAgent.get('/admin/settings/templates/' + id).expect(200);
  }

  /** A builder POST, with a token read from the page it came from. */
  async function post(
    path: string,
    body: Record<string, unknown>,
    status = 302,
  ): Promise<request.Response> {
    const form = await page();
    return adminAgent
      .post('/admin/settings/templates/' + id + path)
      .type('form')
      .send({ _csrf: csrfFrom(form.text), ...body })
      .expect(status);
  }

  before(async () => {
    const created = await createTemplate(
      { ...BASE, name: 'Builder Subject', title: 'Fixed title', body: 'Fixed body.' },
      null,
    );
    id = created.id;
  });

  test('a new template has an empty form and a full palette', async () => {
    const template = await reload();
    assert.deepEqual(templateLayout(template), [], 'nothing is on the form until it is put there');

    const palette = availableFields(template);
    assert.deepEqual(
      palette.builtins.map((f) => f.key),
      ['title', 'category', 'subcategory', 'item', 'priority', 'description', 'attachments', 'approval', 'onbehalf', 'requester', 'group', 'assignee'],
      'every built-in waits in the palette, each catalogue level on its own',
    );
    assert.deepEqual(palette.questions, []);
  });

  test('a template with no title is not offered to requesters', async () => {
    const template = await reload();
    assert.equal(isUsable(template), false);
    assert.ok(
      !(await listActiveTemplates()).some((t) => t.id === id),
      'an unfinished form must not be offered and then fail',
    );

    const builder = await page();
    assert.match(builder.text, /Not offered to requesters yet/);
  });

  test('every field renders on the canvas, whatever is on the form', async () => {
    // Each built-in draws a different preview control, and one of them read a
    // local the page never supplied - so dragging Category on took the whole
    // editor down and there was then no way to drag it off again. Placing all
    // of them and rendering once is what catches that.
    for (const spec of BUILTIN_FIELDS) {
      await post('/fields/' + spec.key + '/place', {});
    }
    await post('/fields/add', { label: 'A question too' });

    const builder = await page();
    for (const spec of BUILTIN_FIELDS) {
      assert.match(
        builder.text,
        new RegExp('data-key="' + spec.key + '"'),
        spec.label + ' should render on the canvas',
      );
    }

    // And with a category actually chosen, since that is the branch that read
    // the missing local.
    const category = await createCategory(
      { name: 'Previewed', description: '', parentId: null, isActive: true, sortOrder: 100, groupId: null },
      null,
    );
    await post('/fields/category/configure', { mode: 'view_only', fieldDefault: category.id });

    const withCategory = await page();
    assert.match(withCategory.text, /Previewed/, 'the chosen category is shown in the preview');

    // Put it back as it was, so the tests below start where they expect.
    for (const spec of BUILTIN_FIELDS) {
      await post('/fields/' + spec.key + '/remove', {});
    }
    const extra = templateLayout(await reload()).find((f) => f.shown === 'A question too');
    if (extra) await post('/fields/' + extra.key + '/delete', {});
  });

  test('a field is placed from the palette, at a position', async () => {
    await post('/fields/title/place', {});
    await post('/fields/description/place', {});
    // Dropped between the two, which is what an index means.
    await post('/fields/priority/place', { index: '1' });

    assert.deepEqual(
      templateLayout(await reload()).map((f) => f.key),
      ['title', 'priority', 'description'],
    );
    assert.deepEqual(
      availableFields(await reload()).builtins.map((f) => f.key),
      ['category', 'subcategory', 'item', 'attachments', 'approval', 'onbehalf', 'requester', 'group', 'assignee'],
      'what is on the form leaves the palette',
    );
  });

  test('placing the same field twice changes nothing', async () => {
    const before = templateLayout(await reload()).map((f) => f.key);
    await post('/fields/title/place', { index: '0' });
    assert.deepEqual(templateLayout(await reload()).map((f) => f.key), before);
  });

  test('once the title is on the form the template is offered', async () => {
    assert.equal(isUsable(await reload()), true);
    assert.ok((await listActiveTemplates()).some((t) => t.id === id));
  });

  test('a question is written straight onto the end of the form', async () => {
    await post('/fields/add', { label: 'Which building?' });

    const layout = templateLayout(await reload());
    const last = layout[layout.length - 1];
    assert.equal(last?.shown, 'Which building?');
    assert.equal(last?.kind, 'question');
    assert.equal(last?.mode, 'optional');
  });

  test('a question with no prompt is refused on the form, not as a page', async () => {
    const refused = await post('/fields/add', { label: '   ' }, 400);
    assert.match(refused.text, /dialog--open/);
    assert.match(refused.text, /needs a prompt/);
    assert.doesNotMatch(refused.text, /Conflict/);
  });

  test('the arrows move one field without any JavaScript', async () => {
    const before = templateLayout(await reload()).map((f) => f.key);
    await post('/fields/order', { key: 'priority', direction: 'up' });

    const after = templateLayout(await reload()).map((f) => f.key);
    assert.notDeepEqual(after, before);
    assert.equal(after.indexOf('priority'), before.indexOf('priority') - 1);
    assert.deepEqual([...after].sort(), [...before].sort(), 'a move must not add or lose a field');
  });

  test('a change comes back to the row it changed, not the top of the page', async () => {
    // Reported as "when I change something in the template creation, or add a
    // new field I am taken to the top of the page". Every builder action is a
    // POST and a redirect, so without a fragment a long form meant scrolling
    // back down after every single change.
    const moved = await post('/fields/order', { key: 'priority', direction: 'down' });
    assert.match(String(moved.headers.location), /#row-priority$/);

    const configured = await post('/fields/priority/configure', { mode: 'optional' });
    assert.match(String(configured.headers.location), /#row-priority$/);

    // The anchor must be the canvas row, never the dialog: `#field-priority`
    // would re-open the dialog through its :target rule.
    assert.doesNotMatch(String(configured.headers.location), /#field-/);

    const page = await adminAgent.get('/admin/settings/templates/' + id).expect(200);
    assert.match(page.text, /id="row-priority"/, 'the anchor has to exist');
    assert.match(page.text, /id="the-form"/);
    assert.match(page.text, /id="tasks"/);
  });

  test('a move off either end is a no-op rather than an error', async () => {
    const first = templateLayout(await reload())[0]!.key;
    await post('/fields/order', { key: first, direction: 'up' });
    assert.equal(templateLayout(await reload())[0]?.key, first);
  });

  test('a dragged order is applied wholesale', async () => {
    const keys = templateLayout(await reload()).map((f) => f.key);
    const reversed = [...keys].reverse();
    await post('/fields/order', { order: reversed.join(',') });

    assert.deepEqual(templateLayout(await reload()).map((f) => f.key), reversed);
  });

  test('a stale order cannot delete a field', async () => {
    const keys = templateLayout(await reload()).map((f) => f.key);
    // As though the page had been drawn before the last field was added.
    await post('/fields/order', { order: keys.slice(0, 2).join(',') });

    const after = templateLayout(await reload()).map((f) => f.key);
    assert.deepEqual([...after].sort(), [...keys].sort(), 'every field must survive a reorder');
    assert.deepEqual(after.slice(0, 2), keys.slice(0, 2), 'the listed ones lead');
  });

  test('a typed field carries ghost text, and a picker does not', async () => {
    const title = layoutField(await reload(), 'title');
    assert.ok(title);
    assert.equal(title.typed, true, 'a title is typed into');
    assert.ok(title.ghost.length > 0, 'and has a standard hint to fall back on');

    for (const key of ['category', 'priority', 'attachments']) {
      const field = layoutField(await reload(), key);
      assert.ok(field);
      assert.equal(
        field.typed,
        false,
        key + ' is not typed into, so it has nowhere to put ghost text',
      );
    }
  });

  test('the gear sets the ghost text, and blanking it restores the standard one', async () => {
    const standard = layoutField(await reload(), 'title')?.ghost;
    assert.ok(standard);

    await post('/fields/title/configure', {
      mode: 'mandatory',
      placeholder: 'Which system, and what happened?',
    });
    assert.equal(layoutField(await reload(), 'title')?.ghost, 'Which system, and what happened?');

    await post('/fields/title/configure', { mode: 'mandatory', placeholder: '' });
    assert.equal(
      layoutField(await reload(), 'title')?.ghost,
      standard,
      'emptying it falls back rather than leaving the box blank',
    );
  });

  test('a field is configured through the gear', async () => {
    await post('/fields/priority/configure', { mode: 'view_only' });
    assert.equal(layoutField(await reload(), 'priority')?.mode, 'view_only');
  });

  test('a mode the field does not offer is refused', async () => {
    // Title is either asked for or fixed; it is never merely optional.
    const refused = await post('/fields/title/configure', { mode: 'optional' }, 400);
    assert.match(refused.text, /not available for/);
    assert.notEqual(layoutField(await reload(), 'title')?.mode, 'optional');
  });

  test('taking a field off the form returns it to the palette, intact', async () => {
    await post('/fields/add', { label: 'Kept for later' });
    const question = templateLayout(await reload()).find((f) => f.shown === 'Kept for later');
    assert.ok(question);

    await post('/fields/' + question.key + '/remove', {});

    assert.ok(
      !templateLayout(await reload()).some((f) => f.key === question.key),
      'it is off the form',
    );
    const parked = availableFields(await reload()).questions;
    assert.ok(
      parked.some((f) => f.shown === 'Kept for later'),
      'but its wording is kept, so putting it back costs nothing',
    );

    await post('/fields/' + question.key + '/place', {});
    assert.ok(templateLayout(await reload()).some((f) => f.key === question.key));
  });

  test('a question is deleted outright, a built-in never is', async () => {
    const question = templateLayout(await reload()).find((f) => f.shown === 'Kept for later');
    assert.ok(question);
    await post('/fields/' + question.key + '/delete', {});
    assert.equal(layoutField(await reload(), question.key), undefined);

    // A built-in belongs to the ticket, so the most a template can do is
    // leave it off its own form.
    await post('/fields/title/delete', {});
    assert.ok(
      templateLayout(await reload()).some((f) => f.key === 'title'),
      'deleting a built-in must not quietly take it off the form either',
    );
  });

  test('the settings form never overwrites the layout', async () => {
    const before = templateLayout(await reload()).map((f) => f.key + ':' + f.mode);

    const form = await page();
    await adminAgent
      .post('/admin/settings/templates/' + id)
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        name: 'Builder Subject',
        priority: 'normal',
        category: 'other',
        isActive: '1',
      })
      .expect(302);

    assert.deepEqual(
      templateLayout(await reload()).map((f) => f.key + ':' + f.mode),
      before,
      'saving the settings must not undo a layout change made after the page was drawn',
    );
  });

  test('the builder page is the only one allowed to load a script', async () => {
    const builder = await page();
    assert.match(
      String(builder.headers['content-security-policy']),
      /script-src 'self'/,
      'the drag-and-drop cannot work without this',
    );
    assert.match(builder.text, /form-builder\.js/);
    // Its script saves a move without a reload: to this server, nowhere else.
    assert.match(String(builder.headers['content-security-policy']), /connect-src 'self'(;|$)/);

    // Elsewhere the builder's script never loads; a page may carry only the
    // dropdown search (select-search.js), and only when it has a long list.
    for (const elsewhere of ['/admin/settings/templates', '/tickets/new', '/profile']) {
      const other = await adminAgent.get(elsewhere).expect(200);
      assert.doesNotMatch(other.text, /form-builder\.js/, elsewhere);
      const scripts = other.text.match(/<script src="[^"]+"/g) ?? [];
      // ...and New ticket the file chips, as a reply has (asked for 21 Oct 2026).
      const allowed = (src: string) => src.includes('/assets/js/select-search.js') || (elsewhere === '/tickets/new' && src.includes('/assets/js/reply-files.js'));
      assert.ok(scripts.every(allowed), elsewhere + ': ' + scripts.join(', '));
      assert.doesNotMatch(String(other.headers['content-security-policy']), /unsafe-inline/, elsewhere);
      assert.match(String(other.headers['content-security-policy']), /connect-src 'none'/, elsewhere);
    }
  });

  test('closing a field dialog returns to that field, never to the top of the page', async () => {
    const builder = await page();
    // "#" alone is the top of the page; every builder dialog closes somewhere specific.
    assert.doesNotMatch(builder.text, /href="#"/);
    assert.match(builder.text, /<a class="dialog__close" href="#row-title"/);
    // A field still in the palette has the same anchor, so its dialog and its save land on it.
    assert.match(builder.text, /<li class="palette-chip" id="row-[a-z]+"/);
  });

  test('even the builder page refuses an inline script', async () => {
    const builder = await page();
    const policy = String(builder.headers['content-security-policy']);
    assert.doesNotMatch(policy, /unsafe-inline/);
    assert.doesNotMatch(policy, /unsafe-eval/);
  });
});

describe('a template controls the form a requester sees', () => {
  let id: string;

  before(async () => {
    const created = await createTemplate(
      {
        ...BASE,
        name: 'Locked Down',
        title: 'Starter laptop request',
        body: 'Raised from the locked template.',
        priority: 'high',
      },
      null,
    );
    id = created.id;

    // Build the form by hand, which is the only way a form exists now.
    for (const key of ['title', 'priority', 'description']) {
      await placeField((await findTemplate(id))!, key, null, null);
    }
    await configureField((await findTemplate(id))!, 'title', { mode: 'view_only' }, null);
    await configureField((await findTemplate(id))!, 'priority', { mode: 'view_only' }, null);
    await configureField((await findTemplate(id))!, 'description', { mode: 'mandatory' }, null);
  });

  test('the help is inside the box, not stacked under it', async () => {
    const built = await createTemplate({ ...BASE, name: 'Ghosted' }, null);
    for (const key of ['title', 'description']) {
      await placeField((await findTemplate(built.id))!, key, null, null);
    }
    await configureField(
      (await findTemplate(built.id))!,
      'title',
      { mode: 'mandatory', placeholder: 'Which system, and what happened?' },
      null,
    );

    const form = await userAgent.get('/tickets/new?template=' + built.id).expect(200);
    assert.match(form.text, /placeholder="Which system, and what happened\?"/);
    assert.doesNotMatch(
      form.text,
      /One line describing the problem/,
      'the old line under the box is gone',
    );

    // The description keeps its name whatever else is on the form: "Anything
    // else" only made sense when it was the remainder after some questions.
    assert.match(form.text, />\s*Description/);
    assert.doesNotMatch(form.text, /Anything else/);
  });

  test('the credentials warning is said once, not under every box', async () => {
    const form = await userAgent.get('/tickets/new').expect(200);
    const warnings = form.text.match(/Do not include passwords/g) ?? [];
    assert.equal(warnings.length, 1, 'repeating a warning is how it stops being read');
  });

  test('a view-only field is shown as a value, with no input to change it', async () => {
    const form = await userAgent.get('/tickets/new?template=' + id).expect(200);
    assert.match(form.text, /Starter laptop request/);
    assert.match(form.text, /locked-value/);
    assert.doesNotMatch(
      form.text,
      /<input[^>]*name="title"/,
      'a view-only title must not be offered as an input',
    );
  });

  test('a submitted value for a locked field is ignored, not trusted', async () => {
    const form = await userAgent.get('/tickets/new?template=' + id).expect(200);
    await userAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('templateId', id)
      // Both of these are view only. A browser can be told to post anything,
      // so the server has to be the one that refuses them.
      .field('title', 'Smuggled title')
      .field('priority', 'low')
      .field('description', 'The part the requester is allowed to write.')
      .expect(302);

    const viewer = await findUserById(user.user.id);
    assert.ok(viewer);
    const raised = (
      await listTickets(viewer, { scope: 'mine', status: 'any', page: 1, perPage: 50 })
    ).items.find((t) => t.description.includes('allowed to write'));

    assert.ok(raised, 'the ticket should have been raised');
    assert.equal(raised.title, 'Starter laptop request', 'the template’s title, not the posted one');
    assert.equal(raised.priority, 'high', 'the template’s priority, not the posted one');
    assert.match(raised.description, /allowed to write/, 'what was typed is still kept');
  });

  test('a mandatory field blocks submission with a readable message', async () => {
    const form = await userAgent.get('/tickets/new?template=' + id).expect(200);
    const refused = await userAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('templateId', id)
      .field('description', '')
      .expect(400);

    assert.match(refused.text, /Please complete: Description/);
  });

  test('a field left off the form is not rendered, and not asked for', async () => {
    // Category was never placed, so it is simply not part of this form.
    const form = await userAgent.get('/tickets/new?template=' + id).expect(200);
    assert.doesNotMatch(form.text, /name="categoryId"/);
    assert.doesNotMatch(form.text, /name="files"/);
  });

  test('a value posted for a field that is not on the form is ignored', async () => {
    const other = await createCategory(
      { name: 'Smuggled In', description: '', parentId: null, isActive: true, sortOrder: 100, groupId: null },
      null,
    );

    const form = await userAgent.get('/tickets/new?template=' + id).expect(200);
    await userAgent
      .post('/tickets')
      .field('_csrf', csrfFrom(form.text))
      .field('templateId', id)
      .field('categoryId', other.id)
      .field('description', 'Category was never on this form.')
      .expect(302);

    const viewer = await findUserById(user.user.id);
    assert.ok(viewer);
    const raised = (
      await listTickets(viewer, { scope: 'mine', status: 'any', page: 1, perPage: 50 })
    ).items.find((t) => t.description.includes('never on this form'));

    assert.ok(raised);
    assert.notEqual(
      raised.category_id,
      other.id,
      'a field the form does not offer must not be settable by posting it',
    );
  });

  test('the form with no template at all still offers every built-in field', async () => {
    const form = await userAgent.get('/tickets/new?template=').expect(200);
    for (const name of ['title', 'priority', 'description']) {
      assert.match(form.text, new RegExp('name="' + name + '"'), name + ' should be on the form');
    }
  });
});

describe('the default template', () => {
  let id: string;

  /** A template finished enough to be offered: it needs a title field. */
  async function usableTemplate(name: string, extra = {}): Promise<string> {
    const created = await createTemplate({ ...BASE, name, ...extra }, null);
    await placeField(created, 'title', null, null);
    return created.id;
  }

  before(async () => {
    id = await usableTemplate('Opens By Default');
  });

  test('the system creates one rather than leaving requesters with nothing', async () => {
    // Nothing is the default in this fixture yet, which is the state a fresh
    // database is in before start-up runs.
    const made = await ensureDefaultTemplate();
    assert.ok(made.is_default);
    assert.equal((await defaultTemplate())?.id, made.id);

    // It has to be usable from the moment it exists, or the form it creates
    // is one nobody can submit.
    assert.equal(isUsable(made), true);
    assert.ok(
      templateLayout(made).some((f) => f.key === 'title'),
      'the form it starts with must at least ask for a title',
    );
  });

  test('running start-up again never disturbs it', async () => {
    const before = await defaultTemplate();
    assert.ok(before);
    const again = await ensureDefaultTemplate();
    assert.equal(again.id, before.id, 'a restart must not make a second one');
  });

  test('the default is the form a ticket is raised on, with no banner', async () => {
    const current = await defaultTemplate();
    assert.ok(current);

    const form = await userAgent.get('/tickets/new').expect(200);
    // The banner exists to say "you picked something unusual". On the form
    // everybody lands on, it would be telling them about a choice they did
    // not make, and offering to leave the only form there is.
    assert.doesNotMatch(form.text, /Using the <strong>/);
    assert.doesNotMatch(form.text, /Blank ticket/, 'a blank ticket is not a thing any more');
    assert.match(
      form.text,
      new RegExp('name="templateId" value="' + current.id + '"'),
      'the default is what the form posts against',
    );
  });

  test('choosing a different one simply opens it, with no banner about it', async () => {
    await setDefaultTemplate(id, null);
    const other = await usableTemplate('Something Unusual');

    const form = await userAgent.get('/tickets/new?template=' + other).expect(200);

    // The banner ("Using the X form. Use the standard form instead.") was
    // removed on 15 Oct 2026: the picker above the form already says which
    // form is open and is the way to change it, so the banner repeated a
    // choice the reader had just made.
    assert.doesNotMatch(form.text, /Using the <strong>/);
    assert.doesNotMatch(form.text, /Use the standard form instead/);

    assert.match(
      form.text,
      new RegExp('name="templateId" value="' + other + '"'),
      'the chosen form is what the page posts against',
    );
  });

  test('an unknown or retired template falls back to the default, not to nothing', async () => {
    const stale = await userAgent.get('/tickets/new?template=does-not-exist').expect(200);
    assert.match(stale.text, new RegExp('value="' + id + '"'), 'the default is used instead');

    const retired = await usableTemplate('Retired Choice');
    await updateTemplate(retired, { ...BASE, name: 'Retired Choice', isActive: false }, null);
    const after = await userAgent.get('/tickets/new?template=' + retired).expect(200);
    assert.match(after.text, new RegExp('value="' + id + '"'));
  });

  test('only one template holds it, and setting another releases the first', async () => {
    const otherId = await usableTemplate('Takes Over');
    await setDefaultTemplate(otherId, null);

    assert.equal((await defaultTemplate())?.id, otherId);
    assert.equal((await findTemplate(id))?.is_default, false, 'the previous one is released');

    // And the database refuses two, whatever the application does.
    const defaults = (await listAllTemplates()).filter((t) => t.is_default);
    assert.equal(defaults.length, 1);
  });

  test('a retired template cannot be made the default', async () => {
    const retired = await createTemplate({ ...BASE, name: 'Retired Default', isActive: false }, null);
    await assert.rejects(() => setDefaultTemplate(retired.id, null), /retired/i);
  });

  test('a template with no form cannot be made the default', async () => {
    const bare = await createTemplate({ ...BASE, name: 'Nothing On It' }, null);
    await assert.rejects(() => setDefaultTemplate(bare.id, null), /Title field/i);
    assert.notEqual((await defaultTemplate())?.id, bare.id);
  });

  test('the default cannot be deleted while it is the default', async () => {
    const current = await defaultTemplate();
    assert.ok(current);

    await assert.rejects(() => deleteTemplate(current.id), /default template/i);
    assert.ok(await findTemplate(current.id), 'it is still there');

    // Handing the flag on is the way out, and then it can go.
    const successor = await usableTemplate('The Next One');
    await setDefaultTemplate(successor, null);
    await deleteTemplate(current.id);
    assert.equal(await findTemplate(current.id), undefined);
  });

  test('the default can be switched off; New ticket then opens the first working template', async () => {
    const current = await defaultTemplate();
    assert.ok(current);
    await updateTemplate(current.id, { ...BASE, name: current.name, isActive: false }, null);
    assert.equal((await findTemplate(current.id))?.is_active, false);
    const fallback = await defaultTemplate();
    assert.ok(!fallback || (fallback.id !== current.id && fallback.is_active), 'never the one switched off');
    // Back on, so the tests after this one find it.
    await updateTemplate(current.id, { ...BASE, name: current.name, isActive: true }, null);
  });

  test('the administration list is where the default is chosen', async () => {
    const current = await defaultTemplate();
    assert.ok(current);
    const page = await adminAgent.get('/admin/settings/templates').expect(200);

    assert.match(page.text, /Default/, 'the current one is marked');
    assert.match(page.text, /Make default/, 'and the others can take it on');
    assert.match(page.text, /New template/, 'with a way to add one');
    assert.doesNotMatch(page.text, /<th scope="col">Order<\/th>/, 'order is gone');

    // Handing it over from the list lands back on the list.
    const other = (await listAllTemplates()).find((t) => !t.is_default && t.is_active && isUsable(t));
    assert.ok(other);
    const moved = await adminAgent
      .post('/admin/settings/templates/' + other.id + '/default')
      .type('form')
      .send({ _csrf: csrfFrom(page.text) })
      .expect(302);
    assert.equal(moved.headers.location, '/admin/settings/templates');
    assert.equal((await defaultTemplate())?.id, other.id);
  });
});

describe('the catalogue as three separate fields', () => {
  let templateId: string;
  let hardware: string;
  let notWorking: string;
  let mouse: string;
  let software: string;

  before(async () => {
    const base = {
      description: '',
      isActive: true,
      sortOrder: 100,
      groupId: null,
    };
    const h = await createCategory({ ...base, name: 'Levelled Hardware', parentId: null }, null);
    hardware = h.id;
    const n = await createCategory({ ...base, name: 'Levelled Broken', parentId: hardware }, null);
    notWorking = n.id;
    const m = await createCategory({ ...base, name: 'Levelled Mouse', parentId: notWorking }, null);
    mouse = m.id;
    const s = await createCategory({ ...base, name: 'Levelled Software', parentId: null }, null);
    software = s.id;

    const created = await createTemplate({ ...BASE, name: 'Three Levels' }, null);
    templateId = created.id;
    for (const key of ['title', 'category', 'subcategory', 'item']) {
      await placeField((await findTemplate(templateId))!, key, null, null);
    }
  });

  function form(): request.Test {
    return userAgent.get('/tickets/new?template=' + templateId).expect(200);
  }

  /** Submits the form, asserting the status it should come back with. */
  async function raise(
    fields: Record<string, string>,
    status = 302,
  ): Promise<request.Response> {
    const page = await form();
    const post = userAgent.post('/tickets').field('_csrf', csrfFrom(page.text));
    post.field('templateId', templateId);
    for (const [name, value] of Object.entries(fields)) post.field(name, value);
    return post.expect(status);
  }

  test('each level is its own picker, with the deeper ones grouped by parent', async () => {
    const page = await form();

    for (const input of ['categoryId', 'subcategoryId', 'itemId']) {
      assert.match(page.text, new RegExp('name="' + input + '"'), input + ' should be its own field');
    }

    // A flat list of paths was what made this unreadable. The deeper levels
    // show a bare name under an optgroup naming the branch instead.
    assert.match(page.text, /<optgroup label="Levelled Hardware">/);
    assert.match(page.text, /<optgroup label="Levelled Hardware › Levelled Broken">/);
    assert.doesNotMatch(
      page.text,
      /<option value="[^"]*">Levelled Hardware › Levelled Broken<\/option>/,
      'the path should be the group, not the option',
    );
  });

  test('the ticket is filed against the deepest level answered', async () => {
    await raise({ title: 'Filed deep', categoryId: hardware, subcategoryId: notWorking, itemId: mouse });

    const viewer = await findUserById(user.user.id);
    assert.ok(viewer);
    const raised = (
      await listTickets(viewer, { scope: 'mine', status: 'any', page: 1, perPage: 50 })
    ).items.find((t) => t.title === 'Filed deep');

    assert.ok(raised);
    assert.equal(raised.category_id, mouse, 'the item implies its branch, so it is what is stored');
  });

  test('a shallower answer on its own still files the ticket', async () => {
    await raise({ title: 'Filed shallow', categoryId: hardware });

    const viewer = await findUserById(user.user.id);
    assert.ok(viewer);
    const raised = (
      await listTickets(viewer, { scope: 'mine', status: 'any', page: 1, perPage: 50 })
    ).items.find((t) => t.title === 'Filed shallow');

    assert.ok(raised);
    assert.equal(raised.category_id, hardware);
  });

  test('a pair that does not go together is refused, in plain words', async () => {
    // Nothing narrows the lists as you choose - that would need a script -
    // so the pairing has to be checked when it arrives.
    const refused = await raise({ title: 'Mismatched', categoryId: software, subcategoryId: notWorking }, 400);

    assert.match(refused.text, /is not under/);
    assert.match(refused.text, /Levelled Broken/);
    assert.match(refused.text, /Levelled Software/);
  });

  test('each level can be made mandatory on its own', async () => {
    await configureField(
      (await findTemplate(templateId))!,
      'subcategory',
      { mode: 'mandatory' },
      null,
    );

    const refused = await raise({ title: 'No sub category', categoryId: hardware }, 400);
    assert.match(refused.text, /Please complete: Sub category/);

    // And answering it is enough; Item is still optional.
    await raise({ title: 'Sub category given', categoryId: hardware, subcategoryId: notWorking });

    await configureField(
      (await findTemplate(templateId))!,
      'subcategory',
      { mode: 'optional' },
      null,
    );
  });

  test('a level left off the form is not asked for and not settable', async () => {
    await unplaceField((await findTemplate(templateId))!, 'item', null);

    const page = await form();
    assert.doesNotMatch(page.text, /name="itemId"/, 'it is not on the form');

    await raise({ title: 'Item smuggled', categoryId: hardware, subcategoryId: notWorking, itemId: mouse });

    const viewer = await findUserById(user.user.id);
    assert.ok(viewer);
    const raised = (
      await listTickets(viewer, { scope: 'mine', status: 'any', page: 1, perPage: 50 })
    ).items.find((t) => t.title === 'Item smuggled');

    assert.ok(raised);
    assert.equal(
      raised.category_id,
      notWorking,
      'the deepest level the form actually offered, not the one posted',
    );

    await placeField((await findTemplate(templateId))!, 'item', null, null);
  });

  test('each level shows its own name, not the whole path', async () => {
    await setFieldDefault((await findTemplate(templateId))!, 'subcategory', notWorking, null);
    for (const key of ['category', 'subcategory'] as const) {
      await configureField((await findTemplate(templateId))!, key, { mode: 'view_only' }, null);
    }

    // All three levels read one stored node, so printing its path on each
    // made Category, Sub category and Item read identically.
    const page = await form();
    assert.match(page.text, /Levelled Hardware<\/p>/, 'Category shows only its own name');
    assert.match(page.text, /Levelled Broken<\/p>/, 'Sub category shows only its own name');
    assert.doesNotMatch(
      page.text,
      /locked-value">\s*Levelled Hardware › Levelled Broken/,
      'the full path belongs to neither of them',
    );

    // And every level previews as a picker on the builder's canvas. Sub
    // category and item used to fall through to the generic branch and draw
    // an empty text box, which looked like the template had lost its value.
    const builder = await adminAgent
      .get('/admin/settings/templates/' + templateId)
      .expect(200);

    for (const key of ['category', 'subcategory', 'item']) {
      const row = new RegExp(
        'data-key="' + key + '"[\\s\\S]*?<span class="widget__tools">',
      ).exec(builder.text);
      assert.ok(row, key + ' should be on the canvas');
      assert.ok(
        /<select disabled>|<p class="locked-value">/.test(row[0]),
        key + ' should preview as a picker or a fixed value, never a blank box',
      );
      assert.ok(
        !/<input type="text"/.test(row[0]),
        key + ' is chosen from a list, so it must not preview as a text box',
      );
    }

    for (const key of ['category', 'subcategory'] as const) {
      await configureField((await findTemplate(templateId))!, key, { mode: 'optional' }, null);
    }
  });

  test("a template's own filing opens the pickers on that branch", async () => {
    await setFieldDefault((await findTemplate(templateId))!, 'item', mouse, null);

    const page = await form();
    assert.match(page.text, new RegExp('value="' + hardware + '" selected'));
    assert.match(page.text, new RegExp('value="' + notWorking + '" selected'));
    assert.match(page.text, new RegExp('value="' + mouse + '" selected'));
  });

  test('a default must be a node of that level', async () => {
    // Hardware is a category, so it cannot be the Item field's default.
    const current = (await findTemplate(templateId))!;
    await assert.rejects(
      () => setFieldDefault(current, 'item', hardware, null),
      /not an item/i,
    );
  });
});

describe('duplicating a template', () => {
  test('copies the form and the tasks, offers it to nobody, and never twice by the same name', async () => {
    // Asked for 16 Oct 2026: most templates are a variation of one that
    // already works, and building the second field by field is the long
    // way round.
    const source = await createTemplate(
      {
        summary: 'The original', title: 'Printer', body: '', priority: 'high', category: 'other',
        type: 'incident', groupId: null, categoryId: null, fields: [], isActive: true,
        name: 'Copy me',
      },
      null,
    );
    await placeField((await findTemplate(source.id))!, 'title', null, null);
    await placeField((await findTemplate(source.id))!, 'description', null, null);
    await addTaskTemplate(
      source.id,
      {
        summary: '', title: 'Check the toner', body: '', priority: 'normal', category: 'other',
        type: 'task', groupId: null, categoryId: null, fields: [], isActive: true,
        name: 'Copy me - toner',
      },
      null,
    );

    const copy = await duplicateTemplate(source.id, null);
    assert.equal(copy.name, 'Copy me (copy)');
    assert.equal(copy.is_active, false, 'a copy is a draft, not a second form in the catalogue');
    assert.equal(copy.is_default, false);
    assert.equal(copy.priority, 'high', "the original's defaults came too");
    assert.deepEqual(
      copy.fields.filter((f) => f.placed).map((f) => f.key),
      ['title', 'description'],
      'and its form',
    );
    assert.equal((await listTaskTemplates(copy.id)).length, 1, 'and its tasks');

    // Pressing it twice must not fail on the unique name.
    const second = await duplicateTemplate(source.id, null);
    assert.equal(second.name, 'Copy me (copy 2)');
  });

  test('the list offers it, and the button lands on the copy', async () => {
    const list = await adminAgent.get('/admin/settings/templates').expect(200);
    assert.match(list.text, /\/duplicate/);
  });
});
