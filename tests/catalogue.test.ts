import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import {
  buildTree,
  catalogueTree,
  createCategory,
  deleteCategory,
  flatten,
  listAll,
  routingGroupFor,
  selectableCategories,
  updateCategory,
  usageCount,
} from '../src/services/catalogue.js';
import { createTicket, listTickets } from '../src/services/tickets.js';
import { findUserById } from '../src/services/users.js';
import { createGroup } from '../src/services/groups.js';

let app: Express;
let admin: TestSession;
let adminAgent: request.Agent;
let userAgent: request.Agent;
let requesterId: string;

const BASE = { description: '', isActive: true, sortOrder: 100, groupId: null };

function csrfFrom(html: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page should carry a CSRF token');
  return match[1] as string;
}

before(async () => {
  await bootstrapTestDatabase();
  app = createApp();

  admin = await signInAs('catalogue.admin@example.com', 'admin');
  adminAgent = request.agent(app);
  adminAgent.set('Cookie', admin.cookie);

  const plain = await signInAs('catalogue.user@example.com', 'user');
  userAgent = request.agent(app);
  userAgent.set('Cookie', plain.cookie);
  requesterId = plain.user.id;
});

describe('nothing is created for you', () => {
  test('the catalogue starts completely empty', async () => {
    assert.deepEqual(await listAll(), [], 'no category may be seeded');
    assert.deepEqual(await selectableCategories(), []);
  });

  test('and the page says so rather than showing an invented tree', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    assert.match(page.text, /Nothing here yet/);
  });
});

describe('three levels in one tree', () => {
  let hardware: string;
  let notWorking: string;
  let mouse: string;

  test('a branch can be built one level at a time', async () => {
    const h = await createCategory({ ...BASE, name: 'Hardware', parentId: null }, null);
    assert.equal(h.level, 1, 'no parent means a top-level category');
    hardware = h.id;

    const n = await createCategory({ ...BASE, name: 'Not working', parentId: hardware }, null);
    assert.equal(n.level, 2, 'the level comes from the parent, not the form');
    notWorking = n.id;

    const m = await createCategory({ ...BASE, name: 'Mouse', parentId: notWorking }, null);
    assert.equal(m.level, 3);
    mouse = m.id;
  });

  test('each node carries its full path', async () => {
    const nodes = flatten(await catalogueTree());
    const item = nodes.find((n) => n.id === mouse);
    assert.equal(item?.path, 'Hardware › Not working › Mouse');
    assert.deepEqual(
      item?.trail.map((t) => t.name),
      ['Hardware', 'Not working', 'Mouse'],
    );
  });

  test('an item is the deepest level', async () => {
    await assert.rejects(
      () => createCategory({ ...BASE, name: 'Too deep', parentId: mouse }, null),
      /deepest level/,
    );
  });

  test('names are unique among siblings, not globally', async () => {
    await assert.rejects(
      () => createCategory({ ...BASE, name: 'hardware', parentId: null }, null),
      /already sits at this level/,
      'case-insensitively, among siblings',
    );

    // The same name under a different parent is the whole point.
    const software = await createCategory({ ...BASE, name: 'Software', parentId: null }, null);
    const sibling = await createCategory(
      { ...BASE, name: 'Not working', parentId: software.id },
      null,
    );
    assert.equal(sibling.level, 2);
  });

  test('retiring a node takes it and its children out of the pickers', async () => {
    await updateCategory(hardware, { ...BASE, name: 'Hardware', isActive: false }, null);

    const offered = await selectableCategories();
    assert.ok(!offered.some((n) => n.id === hardware), 'the retired node is not offered');
    assert.ok(
      !offered.some((n) => n.id === mouse),
      'and neither is anything beneath it, which would be unreachable',
    );

    // Still visible to an administrator, so it can be brought back.
    assert.ok((await listAll()).some((n) => n.id === hardware));
    await updateCategory(hardware, { ...BASE, name: 'Hardware', isActive: true }, null);
  });

  test('the tree sorts by order then name', () => {
    const rows = [
      { id: 'b', parent_id: null, level: 1, name: 'Beta', sort_order: 10 },
      { id: 'a', parent_id: null, level: 1, name: 'Alpha', sort_order: 10 },
      { id: 'c', parent_id: null, level: 1, name: 'Gamma', sort_order: 1 },
    ] as unknown as Parameters<typeof buildTree>[0];
    assert.deepEqual(
      buildTree(rows).map((n) => n.name),
      ['Gamma', 'Alpha', 'Beta'],
    );
  });
});

describe('a classification is a record, not a setting', () => {
  test('a node in use cannot be removed, only retired', async () => {
    const category = await createCategory({ ...BASE, name: 'In Use', parentId: null }, null);
    const sub = await createCategory({ ...BASE, name: 'Leaf', parentId: category.id }, null);

    await createTicket({
      title: 'A ticket filed under the leaf',
      description: 'Its classification must survive any tidying of the catalogue.',
      priority: 'normal',
      category: 'other',
      requesterId,
      categoryId: sub.id,
    });

    assert.equal(await usageCount(sub.id), 1);
    assert.equal(
      await usageCount(category.id),
      1,
      'usage counts what is filed beneath a node as well as against it',
    );

    await assert.rejects(() => deleteCategory(category.id, null), /Retire it instead/);
    await assert.rejects(() => deleteCategory(sub.id, null), /Retire it instead/);
  });

  test('an unused node can be removed, and takes its children with it', async () => {
    const category = await createCategory({ ...BASE, name: 'Unused', parentId: null }, null);
    const sub = await createCategory({ ...BASE, name: 'Also unused', parentId: category.id }, null);

    await deleteCategory(category.id, null);
    const remaining = await listAll();
    assert.ok(!remaining.some((n) => n.id === category.id));
    assert.ok(!remaining.some((n) => n.id === sub.id), 'children cascade away');
  });
});

describe('filing and filtering', () => {
  test('a parent category matches everything beneath it', async () => {
    const top = await createCategory({ ...BASE, name: 'Filterable', parentId: null }, null);
    const mid = await createCategory({ ...BASE, name: 'Middle', parentId: top.id }, null);
    const leaf = await createCategory({ ...BASE, name: 'Leaf node', parentId: mid.id }, null);

    const deep = await createTicket({
      title: 'Filed right at the bottom',
      description: 'Filed against the item, so a filter on the category must still find it.',
      priority: 'normal',
      category: 'other',
      requesterId,
      categoryId: leaf.id,
    });

    const viewer = await findUserById(admin.user.id);
    assert.ok(viewer);

    const byLeaf = await listTickets(viewer, {
      scope: 'all',
      status: 'any',
      categoryIds: [leaf.id],
      page: 1,
      perPage: 50,
    });
    assert.ok(byLeaf.items.some((t) => t.id === deep.id));

    // The route expands a parent to its descendants; this is that set.
    const byBranch = await listTickets(viewer, {
      scope: 'all',
      status: 'any',
      categoryIds: [top.id, mid.id, leaf.id],
      page: 1,
      perPage: 50,
    });
    assert.ok(byBranch.items.some((t) => t.id === deep.id));

    const byOther = await listTickets(viewer, {
      scope: 'all',
      status: 'any',
      categoryIds: [mid.id],
      page: 1,
      perPage: 50,
    });
    assert.ok(!byOther.items.some((t) => t.id === deep.id), 'a sibling level must not match');
  });

  test('a ticket can be filed at any depth, so the top level is useful alone', async () => {
    const top = await createCategory({ ...BASE, name: 'Shallow', parentId: null }, null);
    const ticket = await createTicket({
      title: 'Filed against a top-level category only',
      description: 'The tree is built up over time; it must work before it is deep.',
      priority: 'normal',
      category: 'other',
      requesterId,
      categoryId: top.id,
    });
    assert.equal(ticket.category_id, top.id);
  });
});

describe('the administration page', () => {
  test('is closed to anyone but an administrator', async () => {
    await userAgent.get('/admin/settings/templates/categories').expect(403);
  });

  test('is a tab under Templates rather than a section of its own', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    assert.match(page.text, /subtabs/);
    assert.match(page.text, /href="\/admin\/settings\/templates"/);

    const sidebar = await adminAgent.get('/admin/settings/templates').expect(200);
    assert.doesNotMatch(
      sidebar.text,
      /settings-nav__item[^>]*href="\/admin\/settings\/categories"/,
      'it must not add a section to the sidebar',
    );
  });

  test('a node can be added through the form', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    await adminAgent
      .post('/admin/settings/templates/categories')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), parentId: '', name: 'Through The UI', sortOrder: '5' })
      .expect(302);

    assert.ok((await listAll()).some((n) => n.name === 'Through The UI'));
  });

  test('a node without a name is refused rather than erroring', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    await adminAgent
      .post('/admin/settings/templates/categories')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), parentId: '', name: '' })
      .expect(400);
  });

  test('only a category or subcategory is offered as a parent', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    const nodes = flatten(await catalogueTree());
    const item = nodes.find((n) => n.level === 3);
    assert.ok(item, 'the fixture should have built an item');
    assert.doesNotMatch(
      page.text,
      new RegExp('<option value="' + item.id + '">'),
      'an item cannot take a child, so it must not be offered',
    );
  });

  test('each level is added through its own dialog', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);

    for (const dialog of ['new-category', 'new-subcategory', 'new-item', 'tree-view']) {
      assert.match(page.text, new RegExp('id="' + dialog + '"'), dialog + ' should be on the page');
      assert.match(page.text, new RegExp('href="#' + dialog + '"'), dialog + ' should have a button');
    }

    // The dialogs are :target anchors, not scripted modals. The only script a
    // page here may carry is the dropdown search, added for a long list.
    const scripts = page.text.match(/<script[^>]*>/gi) ?? [];
    assert.ok(scripts.every((s) => s.includes('/assets/js/select-search.js') || s.includes('/assets/js/sidebar.js')), 'no other script: ' + scripts.join(', '));
  });

  test('a validation error reopens the dialog it came from', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/templates/categories')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), from: 'subcategory', categoryId: '', name: '' })
      .expect(400);

    // Without this the error would render behind a closed dialog: there is no
    // fragment in the address bar after a POST, so the server has to say so.
    assert.match(refused.text, /dialog--open/);
    assert.match(refused.text, /Give it a name\./);
  });

  test('"Save and add sub category" carries straight on with the parent chosen', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    const created = await adminAgent
      .post('/admin/settings/templates/categories')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), from: 'category', name: 'Chained', next: 'subcategory' })
      .expect(302);

    const parent = (await listAll()).find((n) => n.name === 'Chained');
    assert.ok(parent);
    assert.equal(
      created.headers.location,
      '/admin/settings/templates/categories?add=subcategory&parent=' + parent.id,
    );

    const next = await adminAgent.get(created.headers.location as string).expect(200);
    assert.match(next.text, /dialog--open/, 'the subcategory dialog should already be open');
    assert.match(
      next.text,
      new RegExp('<option value="' + parent.id + '" selected>'),
      'with the category just created already selected',
    );
  });

  test('a duplicate name reopens the dialog rather than becoming a 409 page', async () => {
    await createCategory({ ...BASE, name: 'Twice Over', parentId: null }, null);

    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    const refused = await adminAgent
      .post('/admin/settings/templates/categories')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), from: 'category', name: 'twice over' })
      .expect(400);

    // Names are only unique among siblings, so "already exists" only means
    // something next to the parent that was chosen - which is in the dialog.
    assert.match(refused.text, /dialog--open/);
    assert.match(refused.text, /already sits at this level/);
    assert.doesNotMatch(refused.text, /Conflict/, 'the standalone error page must not render');
  });

  test('the same name under a different parent is still accepted', async () => {
    const other = await createCategory({ ...BASE, name: 'Elsewhere', parentId: null }, null);
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    await adminAgent
      .post('/admin/settings/templates/categories')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        from: 'subcategory',
        name: 'Twice Over',
        categoryId: other.id,
      })
      .expect(302);
  });

  test('an item is filed under a subcategory chosen by its full path', async () => {
    const page = await adminAgent.get('/admin/settings/templates/categories').expect(200);
    const sub = flatten(await catalogueTree()).find((n) => n.level === 2);
    assert.ok(sub, 'the fixture should have built a subcategory');
    assert.match(
      page.text,
      new RegExp('<option value="' + sub.id + '"[^>]*>' + sub.path),
      'the item dialog lists subcategories by path, so one list covers every branch',
    );
  });
});

describe('routing work from the catalogue', () => {
  test('a ticket goes to the nearest group named above it', async () => {
    const group = await createGroup(
      { name: 'Desktop Support', description: '', isActive: true },
      null,
    );
    const category = await createCategory(
      { ...BASE, name: 'Routed Hardware', parentId: null, groupId: group.id },
      null,
    );
    const sub = await createCategory(
      { ...BASE, name: 'Routed Not working', parentId: category.id },
      null,
    );
    const item = await createCategory({ ...BASE, name: 'Routed Mouse', parentId: sub.id }, null);

    // Inherited downwards, so a whole branch is routed with one setting.
    assert.equal(await routingGroupFor(item.id), group.id);
    assert.equal(await routingGroupFor(sub.id), group.id);
    assert.equal(await routingGroupFor(category.id), group.id);
  });

  test('a deeper setting overrides the one above it', async () => {
    const specialists = await createGroup(
      { name: 'Specialists', description: '', isActive: true },
      null,
    );
    const category = flatten(await catalogueTree()).find((n) => n.name === 'Routed Hardware');
    assert.ok(category);
    const override = await createCategory(
      { ...BASE, name: 'Routed Exception', parentId: category.id, groupId: specialists.id },
      null,
    );

    assert.equal(await routingGroupFor(override.id), specialists.id);
    assert.notEqual(
      await routingGroupFor(category.id),
      specialists.id,
      'and it must not leak back up to its parent',
    );
  });

  test('nothing is routed when no level names a group', async () => {
    const orphan = await createCategory({ ...BASE, name: 'Unrouted', parentId: null }, null);
    assert.equal(await routingGroupFor(orphan.id), null);
    assert.equal(await routingGroupFor(null), null);
  });

  test('a ticket raised against a routed category lands with that group', async () => {
    const node = flatten(await catalogueTree()).find((n) => n.name === 'Routed Mouse');
    assert.ok(node);
    const expected = await routingGroupFor(node.id);

    const form = await adminAgent.get('/tickets/new').expect(200);
    await adminAgent
      .post('/tickets')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'Mouse stopped working',
        description: 'Filed against a category that names a technician group.',
        priority: 'normal',
        categoryId: node.id,
      })
      .expect(302);

    const filed = (await listTickets(await requireViewer(), {
      scope: 'all',
      status: 'any',
      page: 1,
      perPage: 50,
    })).items.find((t) => t.title === 'Mouse stopped working');
    assert.ok(filed, 'the ticket should have been raised');
    assert.equal(
      filed.group_id,
      expected,
      'otherwise the group on a category would be decorative',
    );
  });
});

/** The admin as a viewer, for the list calls above. */
async function requireViewer() {
  const viewer = await findUserById(admin.user.id);
  assert.ok(viewer);
  return viewer;
}
