import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { signInAs, type TestSession } from './support/session.js';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import {
  createTemplate,
  defaultTemplate,
  ensureDefaultTemplate,
  ensureTypeDefaults,
  setDefaultTemplate,
  type TemplateRow,
} from '../src/services/templates.js';
import { addTile, setCatalogueEnabled, setCatalogueGrid } from '../src/services/service-catalogue.js';
import { settings } from '../src/settings/index.js';

/**
 * A default template per ticket type, and the catalogue's filter buttons
 * that raise it.
 */

let app: Express;
let requester: TestSession;
let incident: TemplateRow;
let change: TemplateRow;
let service: TemplateRow;

function as(session: TestSession) {
  const agent = request.agent(app);
  agent.set('Cookie', session.cookie);
  return agent;
}

const FORM = [
  { key: 'title', kind: 'builtin' as const, label: '', mode: 'mandatory' as const, value: '', placeholder: '', placed: true },
];

function base(name: string, type: 'service_request' | 'incident' | 'change_request') {
  return {
    name,
    summary: '',
    title: '',
    body: '',
    priority: 'normal' as const,
    category: 'other' as const,
    type,
    groupId: null,
    categoryId: null,
    fields: FORM,
    isActive: true,
  };
}

before(async () => {
  await bootstrapTestDatabase();
  await ensureDefaultTemplate();
  app = createApp();
  requester = await signInAs('cat.user@example.com', 'user');

  service = await createTemplate(base('Ask for something', 'service_request'), null);
  incident = await createTemplate(base('Something is broken', 'incident'), null);
  change = await createTemplate(base('Change a system', 'change_request'), null);
  await ensureTypeDefaults();
});

describe('a default per ticket type', () => {
  test('every type that has a template has a default, and they do not fight', async () => {
    // The seeded Default request is an incident and was there first, so it
    // keeps that type's default: ensureTypeDefaults only ever adds.
    const forIncident = await defaultTemplate('incident');
    assert.ok(forIncident);
    assert.notEqual(forIncident.id, incident.id, 'the one that was already there');

    assert.equal((await defaultTemplate('change_request'))?.id, change.id, 'adopted');
    assert.equal((await defaultTemplate('service_request'))?.id, service.id, 'adopted');

    // Without a type, the service request is the front door.
    assert.equal((await defaultTemplate())?.id, service.id);
  });

  test('making one default moves the flag within its own type only', async () => {
    await setDefaultTemplate(incident.id, null);

    assert.equal((await defaultTemplate('incident'))?.id, incident.id, 'moved');
    assert.equal((await defaultTemplate('change_request'))?.id, change.id, 'untouched');
    assert.equal((await defaultTemplate('service_request'))?.id, service.id, 'untouched');
  });
});

describe('the catalogue filter buttons', () => {
  test('off by default, and on they offer only the kinds the tiles have', async () => {
    await setCatalogueEnabled(true, null);
    await addTile({ templateId: incident.id }, null);
    await setCatalogueGrid(3, 3, false, null);

    const plain = await as(requester).get('/tickets/new').expect(200);
    assert.doesNotMatch(plain.text, /catalogue-filters/, 'off by default');

    await setCatalogueGrid(3, 3, true, null);
    const filtered = await as(requester).get('/tickets/new').expect(200);
    assert.match(filtered.text, /catalogue-filters/);
    assert.match(filtered.text, /kind=incident/);
    // Nothing offers a change request, so no button would empty the page.
    assert.doesNotMatch(filtered.text, /kind=change_request/);
  });

  test('a kind narrows the tiles, and New ticket raises that kind default', async () => {
    await addTile({ templateId: change.id }, null);
    await setCatalogueGrid(3, 3, true, null);

    const page = await as(requester).get('/tickets/new?kind=change_request').expect(200);
    assert.match(page.text, /Change a system/);
    assert.doesNotMatch(page.text, /Something is broken/, 'the other kind is filtered out');
    // The button raises that kind's default, not the service desk's.
    assert.match(page.text, new RegExp('/tickets/new\\?template=' + change.id));

    // A kind nobody offers is ignored rather than refused: the address is
    // something somebody can type.
    const nonsense = await as(requester).get('/tickets/new?kind=nonsense').expect(200);
    assert.match(nonsense.text, /Change a system/);
    assert.match(nonsense.text, /Something is broken/);
  });

  test('the switch is stored with the rest of the grid', async () => {
    await setCatalogueGrid(4, 2, true, null);
    assert.equal(settings().tickets.catalogue.filters, true);
    assert.equal(settings().tickets.catalogue.columns, 4);
    await setCatalogueGrid(4, 2, false, null);
    assert.equal(settings().tickets.catalogue.filters, false);
  });
});

describe('tiles have a place of their own', () => {
  test('a tile can sit anywhere, and a gap left on purpose stays a gap', async () => {
    const { placedTiles, placeTileAt, removeTile, serviceCatalogueFor } = await import(
      '../src/services/service-catalogue.js'
    );

    // Start from one tile, then put a second four cells along - the middle
    // of a row, with nothing beside it.
    for (const tile of placedTiles()) await removeTile(tile.id, null);
    const first = await addTile({ templateId: service.id }, null, 0);
    const second = await addTile({ templateId: change.id }, null, 4);

    const cells = placedTiles().map((t) => t.cell);
    assert.deepEqual(cells, [0, 4], 'placed where they were put');

    // A requester sees both, in those cells: the gap is the layout.
    const seen = await serviceCatalogueFor([]);
    assert.deepEqual(
      seen.map((entry) => entry.cell),
      [0, 4],
    );

    // Dropping one onto the other swaps them rather than refusing.
    await placeTileAt(first.id, 4, null);
    const swapped = Object.fromEntries(placedTiles().map((t) => [t.id, t.cell]));
    assert.equal(swapped[first.id], 4);
    assert.equal(swapped[second.id], 0, 'the occupant changed places with it');
  });

  test('a tile somebody may not raise closes its gap, rather than leaving a hole', async () => {
    const { placedTiles, removeTile, serviceCatalogueFor } = await import(
      '../src/services/service-catalogue.js'
    );
    const { setTemplateAudience } = await import('../src/services/templates.js');
    const { createUserGroup } = await import('../src/services/user-groups.js');

    // A template of its own, because the default of a type cannot be
    // restricted to a group - anybody outside it would have no form.
    const restricted = await createTemplate(base('For one team only', 'service_request'), null);
    const group = await createUserGroup({ name: 'Only them', description: '', isActive: true }, null);
    await setTemplateAudience(restricted, [group.id], null);

    for (const tile of placedTiles()) await removeTile(tile.id, null);
    await addTile({ templateId: service.id }, null, 0);
    await addTile({ templateId: restricted.id }, null, 1);
    await addTile({ templateId: incident.id }, null, 2);

    const seen = await serviceCatalogueFor([]);
    assert.deepEqual(
      seen.map((entry) => entry.template.id),
      [service.id, incident.id],
      'the one they may not raise is left out',
    );
    assert.deepEqual(
      seen.map((entry) => entry.cell),
      [0, 1],
      'and the one after it moves up, so there is no hole',
    );

    // Somebody in that group sees all three, in the cells they were put in.
    const member = await serviceCatalogueFor([group.id]);
    assert.deepEqual(
      member.map((entry) => entry.cell),
      [0, 1, 2],
    );
  });
});
