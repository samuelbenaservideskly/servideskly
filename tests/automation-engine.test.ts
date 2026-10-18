import './env.js';
import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import {
  addNode,
  configureNode,
  connect,
  createAutomation,
  findAutomation,
  graphProblems,
  MAX_STEPS,
  recentRuns,
  setAutomationEnabled,
} from '../src/services/automation.js';
import { createTicket, getTicketById, updateTicket } from '../src/services/tickets.js';

let admin: TestSession;
let requester: TestSession;

before(async () => {
  await bootstrapTestDatabase();
  createApp(); // installs the listener
  admin = await signInAs('auto.admin@example.com', 'admin');
  requester = await signInAs('auto.requester@example.com', 'user');
});

function raise(title: string, priority: 'low' | 'normal' | 'high' | 'urgent') {
  return createTicket({ title, description: 'Raised by the automation tests.', priority, category: 'other', requesterId: requester.user.id });
}

async function triggerOf(id: string) {
  return (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
}

describe('the automation engine', () => {
  test('when created, if urgent then comment, else set status', async () => {
    const a = await createAutomation('Urgent triage', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const cond = await addNode(a.id, 'if', 300, 100, null);
    await configureNode(a.id, cond, { field: 'priority', op: 'equals', value: 'urgent' }, null);
    const note = await addNode(a.id, 'add_comment', 600, 40, null);
    await configureNode(a.id, note, { body: 'Paging the duty engineer.', internal: 'on' }, null);
    const pending = await addNode(a.id, 'set_status', 600, 200, null);
    await configureNode(a.id, pending, { status: 'in_progress' }, null);
    await connect(a.id, trigger, 'next', cond, null);
    await connect(a.id, cond, 'true', note, null);
    await connect(a.id, cond, 'false', pending, null);
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), []);
    await setAutomationEnabled(a.id, true, null);

    const urgent = await raise('Payments down', 'urgent');
    const comments = await query<{ body: string; is_internal: number }>('SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ?', [urgent.id]);
    assert.equal(comments[0]?.body, 'Paging the duty engineer.');
    assert.equal((await getTicketById(urgent.id))?.status, 'open');

    const normal = await raise('Mouse squeaks', 'normal');
    assert.equal((await getTicketById(normal.id))?.status, 'in_progress');
    assert.equal((await query('SELECT id FROM ticket_comments WHERE ticket_id = ?', [normal.id])).length, 0);

    const runs = await recentRuns(a.id);
    assert.equal(runs.length, 2);
    assert.ok(runs.every((r) => r.outcome === 'success'));
    await setAutomationEnabled(a.id, false, null);
  });

  test('an incomplete graph cannot be switched on', async () => {
    const a = await createAutomation('Half built', 'ticket.created', admin.user.id);
    await assert.rejects(() => setAutomationEnabled(a.id, true, null), /Connect the trigger/);
  });

  test('a loop stops at the step limit', async () => {
    const a = await createAutomation('Ping pong', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const one = await addNode(a.id, 'set_priority', 300, 100, null);
    const two = await addNode(a.id, 'set_priority', 500, 100, null);
    await configureNode(a.id, one, { priority: 'high' }, null);
    await configureNode(a.id, two, { priority: 'low' }, null);
    await connect(a.id, trigger, 'next', one, null);
    await connect(a.id, one, 'next', two, null);
    await connect(a.id, two, 'next', one, null);
    await setAutomationEnabled(a.id, true, null);
    await raise('Loop me', 'normal');
    const [run] = await recentRuns(a.id);
    assert.equal(run?.outcome, 'stopped');
    assert.equal(JSON.parse(run!.steps).length, MAX_STEPS + 1);
    await setAutomationEnabled(a.id, false, null);
  });

  test('what an automation changes does not set automations off again', async () => {
    const a = await createAutomation('On status, set status', 'status.changed', admin.user.id);
    const trigger = await triggerOf(a.id);
    const node = await addNode(a.id, 'set_priority', 300, 100, null);
    await configureNode(a.id, node, { priority: 'urgent' }, null);
    await connect(a.id, trigger, 'next', node, null);
    await setAutomationEnabled(a.id, true, null);

    const t = await raise('Status once', 'low');
    await updateTicket(t.id, admin.user.id, { status: 'in_progress' });
    assert.equal((await getTicketById(t.id))?.priority, 'urgent');
    assert.equal((await recentRuns(a.id)).length, 1, 'its own change did not run it again');
    await setAutomationEnabled(a.id, false, null);
  });

  test('a failing step is recorded, and the ticket change still stands', async () => {
    const a = await createAutomation('Broken route', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const node = await addNode(a.id, 'route_group', 300, 100, null);
    await configureNode(a.id, node, { groupId: 'no-such-group' }, null);
    await connect(a.id, trigger, 'next', node, null);
    await setAutomationEnabled(a.id, true, null);
    const t = await raise('Still raised', 'normal');
    assert.ok(await getTicketById(t.id));
    const [run] = await recentRuns(a.id);
    assert.equal(run?.outcome, 'failure');
    await setAutomationEnabled(a.id, false, null);
  });

  test('the trigger cannot be removed or wired into', async () => {
    const a = await createAutomation('Guarded', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const node = await addNode(a.id, 'set_status', 300, 100, null);
    await assert.rejects(() => connect(a.id, node, 'next', trigger, null), /Nothing can lead into the trigger/);
    const { deleteNode } = await import('../src/services/automation.js');
    await assert.rejects(() => deleteNode(a.id, trigger, null), /trigger cannot be removed/);
  });
});

describe('several actions on one trigger', () => {
  test('all of them run, each branch to its end before the next', async () => {
    const a = await createAutomation('Fan out run', 'ticket.created', admin.user.id);
    const trigger = (await findAutomation(a.id))!.graph.nodes[0]!.id;
    const first = await addNode(a.id, 'add_comment', 300, 40, null);
    await configureNode(a.id, first, { body: 'First action.', internal: 'on' }, null);
    const then = await addNode(a.id, 'add_comment', 500, 40, null);
    await configureNode(a.id, then, { body: 'After the first.', internal: 'on' }, null);
    const second = await addNode(a.id, 'set_priority', 300, 160, null);
    await configureNode(a.id, second, { priority: 'high' }, null);
    await connect(a.id, trigger, 'next', first, null);
    await connect(a.id, trigger, 'next', second, null);
    await connect(a.id, first, 'next', then, null);
    await setAutomationEnabled(a.id, true, null);

    const t = await raise('Fan out', 'normal');
    const comments = await query<{ body: string }>('SELECT body FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at', [t.id]);
    assert.deepEqual(comments.map((c) => c.body), ['First action.', 'After the first.']);
    assert.equal((await getTicketById(t.id))?.priority, 'high');
    const run = (await recentRuns(a.id))[0]!;
    assert.equal(run.outcome, 'success');
    await setAutomationEnabled(a.id, false, null);
  });
});

describe('the worked examples', () => {
  test('are created once, switched off, and are complete apart from choosing an API key', async () => {
    const { ensureExampleAutomations, listAutomations } = await import('../src/services/automation.js');
    const { ensureDefaultTemplate } = await import('../src/services/templates.js');
    const made = await ensureExampleAutomations((await ensureDefaultTemplate()).id);
    assert.equal(made, 6);
    assert.equal(await ensureExampleAutomations(null), 0, 'once ever');
    const examples = (await listAutomations()).filter((a) => a.name.startsWith('Example: '));
    assert.equal(examples.length, 6);
    assert.ok(examples.every((a) => !a.is_enabled));
    for (const a of examples) {
      const problems = graphProblems(a.graph);
      const http = a.graph.nodes.some((n) => n.type === 'trigger' && n.config.event === 'http.received');
      assert.deepEqual(problems, http ? ['Trigger: choose the API key it accepts.'] : [], a.name);
    }
  });
});
