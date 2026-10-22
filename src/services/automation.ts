import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { newId, nowIso } from '../lib/util.js';
import { execute, query, queryOne } from '../db/index.js';
import { asAutomatic, onTicketEvent, withoutEvents, type TicketEvent } from './events.js';
import { sendNotification, type AutomationRecipient } from './mail/outbox.js';
import {
  addComment,
  getTicketById,
  PRIORITY_LABELS,
  STATUS_LABELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  updateTicket,
  type TicketListItem,
} from './tickets.js';
import { userGroupIdsFor } from './user-groups.js';
import { fillVariables, httpStepProblem, runHttpStep, unknownVariables, variableValue, type RunContext, type StepOutput } from './automation-http.js';
import { actionLabel, findApiKey, forbiddenSteps } from './api-keys.js';
import { createTemplateFrom, findTemplate, findTemplateByName, isUsable } from './templates.js';
import { createCustomNotification, findNotificationByName } from './mail/notifications.js';
import { TICKET_TYPES, TYPE_LABELS } from './tickets.js';
import { raiseFromRule } from './mail/rules.js';
import { systemRequesterId } from './mail/inbound.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { addAssetComment, getAsset, listStatuses as listAssetStatuses, onAssetChange, setAssetStatus, type AssetChange } from './assets.js';
import { assetVariables } from './asset-variables.js';
import { mailOne } from './mail/outbox.js';
import { findUserById } from './users.js';
import { skippedNote, storeIncomingAttachments } from './mail/inbound-attachments.js';
import type { IncomingAttachment } from './mail/transport.js';
import { findUserByEmail } from './users.js';

const log = logger.child({ module: 'automation' });

/**
 * Automations: Settings - Advanced - Automation.
 *
 * An automation is a small graph, drawn like Unreal Blueprints or Power
 * Automate: one **trigger** node, and nodes after it joined by wires. A wire
 * leaves a node's out-pin ("next", or "true"/"false" on a condition) and
 * enters another node. When the trigger's event happens to a ticket, the
 * engine walks the wires from it, deciding at each condition and acting at
 * each action.
 *
 * Kept deliberately small (v1): exec wires only - a node's settings are
 * fields on the node, not data wires from other nodes. One graph per
 * automation, stored as JSON beside it.
 *
 * Three rules the engine keeps:
 *
 * - **Bounded.** At most MAX_STEPS nodes per run, so a wire looping back can
 *   never spin.
 * - **No chain reactions.** What an automation does is done inside
 *   withoutEvents(), so its own changes set off no automation - including
 *   itself.
 * - **Never in the way.** A run that fails is logged and audited; the ticket
 *   change that set it off has already been saved and stays saved.
 */

export const MAX_STEPS = 50;

// ---------------------------------------------------------------------------
// The node catalogue
// ---------------------------------------------------------------------------

export const TRIGGERS = [
  { key: 'ticket.created', label: 'Ticket is created' },
  { key: 'status.changed', label: 'Status changes' },
  { key: 'priority.changed', label: 'Priority changes' },
  { key: 'assignee.changed', label: 'Ticket is assigned' },
  { key: 'group.changed', label: 'Ticket is routed to a group' },
  { key: 'comment.added', label: 'A comment is added' },
  // Started by another system with an API key (POST /hooks/automations/:id),
  // never by a ticket event.
  { key: 'http.received', label: 'An HTTP request is received' },
  // From the SLA sweep (every 15 minutes), once per ticket and clock.
  { key: 'sla.breached', label: 'SLA is breached' },
  // Assets (services/assets.ts, step 4): the run acts on the asset, not a ticket.
  { key: 'asset.created', label: 'Asset is created' },
  { key: 'asset.status.changed', label: 'Asset status changes' },
  { key: 'asset.assigned', label: 'Asset is assigned' },
] as const;

/** Whether a trigger starts a run about an asset rather than a ticket. */
export const isAssetTrigger = (event: string | undefined): boolean => (event ?? '').startsWith('asset.');

/** Which SLA clock an "SLA is breached" trigger waits for; empty is either. */
export const SLA_CLOCKS = [
  { key: '', label: 'Either clock' },
  { key: 'response', label: 'First response' },
  { key: 'resolution', label: 'Resolution' },
] as const;
export type TriggerKey = (typeof TRIGGERS)[number]['key'];

export const CONDITION_FIELDS = [
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'type', label: 'Type' },
  { key: 'group', label: 'Technician group' },
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
  { key: 'requester_email', label: 'Requester email' },
  { key: 'requester_group', label: 'Requester is in user group' },
  { key: 'template', label: 'Template it was raised from' },
  // A value an earlier step produced, such as {{lookup.status}}.
  { key: 'variable', label: 'A value from an earlier step' },
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number]['key'];

export const OPERATORS = [
  { key: 'equals', label: 'is' },
  { key: 'not_equals', label: 'is not' },
  { key: 'contains', label: 'contains' },
] as const;
export type Operator = (typeof OPERATORS)[number]['key'];

export const NODE_TYPES = [
  { key: 'trigger', label: 'Trigger', kind: 'trigger', pins: ['next'] },
  { key: 'if', label: 'If', kind: 'condition', pins: ['true', 'false'] },
  { key: 'send_notification', label: 'Send notification', kind: 'action', pins: ['next'] },
  { key: 'set_status', label: 'Set status', kind: 'action', pins: ['next'] },
  { key: 'set_priority', label: 'Set priority', kind: 'action', pins: ['next'] },
  { key: 'route_group', label: 'Route to group', kind: 'action', pins: ['next'] },
  { key: 'assign', label: 'Assign to technician', kind: 'action', pins: ['next'] },
  { key: 'add_comment', label: 'Add a comment', kind: 'action', pins: ['next'] },
  { key: 'create_ticket', label: 'Create a ticket', kind: 'action', pins: ['next'] },
  { key: 'attach_files', label: 'Attach the files from the request', kind: 'action', pins: ['next'] },
  { key: 'create_template', label: 'Create a ticket template', kind: 'action', pins: ['next'] },
  { key: 'create_notification', label: 'Create a notification', kind: 'action', pins: ['next'] },
  { key: 'http_request', label: 'Send HTTP request', kind: 'action', pins: ['next'] },
  { key: 'http_request_auth', label: 'Send authenticated HTTP request', kind: 'action', pins: ['next'] },
  { key: 'asset_email', label: 'Email about the asset', kind: 'action', pins: ['next'] },
  { key: 'asset_comment', label: 'Add a comment to the asset', kind: 'action', pins: ['next'] },
  { key: 'asset_status', label: "Set the asset's status", kind: 'action', pins: ['next'] },
] as const;

/** The steps that act on an asset; every other action acts on a ticket. */
export const ASSET_STEPS: readonly string[] = ['asset_email', 'asset_comment', 'asset_status'];
/** Steps any run may use, whatever it is about. */
export const SHARED_STEPS: readonly string[] = ['if', 'http_request', 'http_request_auth'];
export type NodeType = (typeof NODE_TYPES)[number]['key'];
export type Pin = 'next' | 'true' | 'false';

export function nodeSpec(type: string) {
  return NODE_TYPES.find((t) => t.key === type);
}

export interface GraphNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  config: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  pin: Pin;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AutomationRow {
  id: string;
  name: string;
  is_enabled: boolean;
  graph: Graph;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function normalise(row: AutomationRow | undefined): AutomationRow | undefined {
  if (!row) return undefined;
  const graph = row.graph && typeof row.graph === 'object' ? row.graph : { nodes: [], edges: [] };
  return {
    ...row,
    graph: { nodes: Array.isArray(graph.nodes) ? graph.nodes : [], edges: Array.isArray(graph.edges) ? graph.edges : [] },
  };
}

export async function listAutomations(): Promise<AutomationRow[]> {
  const rows = await query<AutomationRow>('SELECT * FROM automations ORDER BY lower(name)');
  return rows.map((r) => normalise(r)!);
}

export async function findAutomation(id: string): Promise<AutomationRow | undefined> {
  return normalise(await queryOne<AutomationRow>('SELECT * FROM automations WHERE id = ?', [id]));
}

async function saveGraph(id: string, graph: Graph): Promise<void> {
  await execute('UPDATE automations SET graph = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(graph),
    nowIso(),
    id,
  ]);
}

/** A new automation starts with its trigger already placed. */
export async function createAutomation(name: string, trigger: TriggerKey, actorId: string | null): Promise<AutomationRow> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM automations WHERE lower(name) = lower(?)', [name]);
  if (clash) throw conflict('An automation with that name already exists.', 'automation_name_taken');
  const id = newId();
  const now = nowIso();
  const graph: Graph = {
    nodes: [{ id: newId(), type: 'trigger', x: 80, y: 120, config: { event: trigger } }],
    edges: [],
  };
  await execute(
    `INSERT INTO automations (id, name, is_enabled, graph, created_by, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
    [id, name, JSON.stringify(graph), actorId, now, now],
  );
  audit({ action: 'automation.created', actorId, targetType: 'automation', targetId: id, detail: { name, trigger } });
  return (await findAutomation(id))!;
}

export async function setAutomationEnabled(id: string, enabled: boolean, actorId: string | null): Promise<void> {
  const row = await findAutomation(id);
  if (!row) throw notFound('That automation no longer exists.');
  if (enabled) {
    const problems = graphProblems(row.graph);
    if (problems.length > 0) throw conflict(problems[0]!, 'automation_incomplete');
    const refused = await keyProblem(row.graph);
    if (refused) throw conflict(refused, 'automation_key');
  }
  await execute('UPDATE automations SET is_enabled = ?, updated_at = ? WHERE id = ?', [enabled, nowIso(), id]);
  audit({ action: 'automation.' + (enabled ? 'enabled' : 'disabled'), actorId, targetType: 'automation', targetId: id });
}

export async function renameAutomation(id: string, name: string, actorId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM automations WHERE lower(name) = lower(?) AND id <> ?', [name, id]);
  if (clash) throw conflict('An automation with that name already exists.', 'automation_name_taken');
  await execute('UPDATE automations SET name = ?, updated_at = ? WHERE id = ?', [name, nowIso(), id]);
  audit({ action: 'automation.renamed', actorId, targetType: 'automation', targetId: id, detail: { name } });
}

export async function deleteAutomation(id: string, actorId: string | null): Promise<void> {
  const row = await findAutomation(id);
  if (!row) throw notFound('That automation no longer exists.');
  await execute('DELETE FROM automations WHERE id = ?', [id]);
  audit({ action: 'automation.deleted', actorId, targetType: 'automation', targetId: id, detail: { name: row.name } });
}

// ---------------------------------------------------------------------------
// Editing the graph - one change per call, each a form post
// ---------------------------------------------------------------------------

async function editGraph(
  id: string,
  actorId: string | null,
  what: string,
  change: (graph: Graph) => void,
): Promise<Graph> {
  const row = await findAutomation(id);
  if (!row) throw notFound('That automation no longer exists.');
  const graph = structuredClone(row.graph);
  change(graph);
  await saveGraph(id, graph);
  audit({ action: 'automation.updated', actorId, targetType: 'automation', targetId: id, detail: { change: what } });
  return graph;
}

function clampPosition(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(0, Math.min(5000, v)) : 0;
}

export async function addNode(id: string, type: NodeType, x: number, y: number, actorId: string | null): Promise<string> {
  const spec = nodeSpec(type);
  if (!spec || spec.kind === 'trigger') throw conflict('That is not a node you can add.', 'bad_node');
  const nodeId = newId();
  await editGraph(id, actorId, 'add ' + type, (g) => {
    g.nodes.push({ id: nodeId, type, x: clampPosition(x), y: clampPosition(y), config: {} });
  });
  return nodeId;
}

export async function moveNode(id: string, nodeId: string, x: number, y: number, actorId: string | null): Promise<void> {
  await editGraph(id, actorId, 'move', (g) => {
    const node = g.nodes.find((n) => n.id === nodeId);
    if (!node) throw notFound('That node no longer exists.');
    node.x = clampPosition(x);
    node.y = clampPosition(y);
  });
}

/** Saves every node's position in one change: "Arrange", or the first drag. */
export async function setPositions(id: string, positions: Record<string, { x: number; y: number }>, actorId: string | null): Promise<void> {
  await editGraph(id, actorId, 'arrange', (g) => {
    for (const node of g.nodes) {
      const p = positions[node.id];
      if (p) {
        node.x = clampPosition(p.x);
        node.y = clampPosition(p.y);
      }
    }
  });
}

export async function configureNode(
  id: string,
  nodeId: string,
  config: Record<string, string>,
  actorId: string | null,
): Promise<void> {
  await editGraph(id, actorId, 'configure', (g) => {
    const node = g.nodes.find((n) => n.id === nodeId);
    if (!node) throw notFound('That node no longer exists.');
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(config)) {
      if (/^[a-zA-Z]{1,32}$/.test(k)) clean[k] = String(v).slice(0, 4000);
    }
    node.config = clean;
  });
}

export async function deleteNode(id: string, nodeId: string, actorId: string | null): Promise<void> {
  await editGraph(id, actorId, 'delete node', (g) => {
    const node = g.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.type === 'trigger') throw conflict('The trigger cannot be removed - every automation starts with one.', 'trigger_required');
    g.nodes = g.nodes.filter((n) => n.id !== nodeId);
    g.edges = g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  });
}

/** Refuses a wire that cannot exist. */
function checkWire(g: Graph, from: string, pin: Pin, to: string): void {
  const source = g.nodes.find((n) => n.id === from);
  if (!source) throw notFound('That node no longer exists.');
  const spec = nodeSpec(source.type);
  if (!spec || !(spec.pins as readonly string[]).includes(pin)) throw conflict('That node has no such output.', 'bad_pin');
  const target = g.nodes.find((n) => n.id === to);
  if (!target) throw notFound('That node no longer exists.');
  if (target.type === 'trigger') throw conflict('Nothing can lead into the trigger.', 'into_trigger');
  if (to === from) throw conflict('A node cannot lead to itself.', 'self_loop');
}

/**
 * Adds a wire from an out-pin to a node. An out-pin may lead to several
 * nodes - a trigger with three actions runs all three, in the order they
 * were wired - so this adds rather than replaces. `to` empty disconnects
 * the pin from everything.
 */
export async function connect(id: string, from: string, pin: Pin, to: string, actorId: string | null): Promise<void> {
  await editGraph(id, actorId, 'connect', (g) => {
    if (!to) {
      const source = g.nodes.find((n) => n.id === from);
      if (!source) throw notFound('That node no longer exists.');
      g.edges = g.edges.filter((e) => !(e.from === from && e.pin === pin));
      return;
    }
    checkWire(g, from, pin, to);
    if (!g.edges.some((e) => e.from === from && e.pin === pin && e.to === to)) g.edges.push({ from, pin, to });
  });
}

/** Removes one wire, leaving the pin's other wires as they are. */
export async function disconnect(id: string, from: string, pin: Pin, to: string, actorId: string | null): Promise<void> {
  await editGraph(id, actorId, 'disconnect', (g) => {
    const before = g.edges.length;
    g.edges = g.edges.filter((e) => !(e.from === from && e.pin === pin && e.to === to));
    if (g.edges.length === before) throw notFound('That connection no longer exists.');
  });
}

/** Makes an out-pin lead to exactly these nodes, keeping the order of the ones it already had. */
export async function setTargets(id: string, from: string, pin: Pin, to: readonly string[], actorId: string | null): Promise<void> {
  await editGraph(id, actorId, 'connect', (g) => {
    const wanted = Array.from(new Set(to.filter(Boolean)));
    for (const target of wanted) checkWire(g, from, pin, target);
    const kept = g.edges.filter((e) => e.from === from && e.pin === pin && wanted.includes(e.to));
    const added = wanted.filter((t) => !kept.some((e) => e.to === t)).map((t) => ({ from, pin, to: t }));
    g.edges = [...g.edges.filter((e) => !(e.from === from && e.pin === pin)), ...kept, ...added];
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Why this graph cannot be switched on, in words; empty when it can. */
export function graphProblems(graph: Graph): string[] {
  const problems: string[] = [];
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) problems.push('There is no trigger.');
  else if (!graph.edges.some((e) => e.from === trigger.id)) problems.push('Connect the trigger to the first step.');
  const outputs = outputNames(graph);
  for (const node of graph.nodes) {
    const missing = missingSettings(node, outputs);
    if (missing) problems.push(nodeSpec(node.type)?.label + ': ' + missing);
  }
  return problems;
}

/** The output names HTTP steps in this graph give their answers. */
export function outputNames(graph: Graph): Set<string> {
  const names = new Set(graph.nodes.map((n) => n.config.output ?? '').filter((o) => o !== ''));
  // Started by a request: what was sent reads as {{request.json.x}}.
  if (isHttpTriggered(graph)) names.add('request');
  return names;
}

export function isHttpTriggered(graph: Graph): boolean {
  return graph.nodes.some((n) => n.type === 'trigger' && n.config.event === 'http.received');
}

/**
 * Why the API key on an HTTP trigger cannot start this graph, or ''. Needs
 * the database, so it is apart from graphProblems().
 */
export async function keyProblem(graph: Graph): Promise<string> {
  if (!isHttpTriggered(graph)) return '';
  const trigger = graph.nodes.find((n) => n.type === 'trigger')!;
  const key = trigger.config.apiKeyId ? await findApiKey(trigger.config.apiKeyId) : undefined;
  if (!key) return 'Trigger: choose the API key it accepts.';
  const refused = forbiddenSteps(key, graph.nodes.map((n) => n.type));
  return refused.length > 0
    ? 'The API key "' + key.name + '" may not run: ' + refused.map(actionLabel).join(', ') + '. Tick them on the key, or remove the steps.'
    : '';
}

/** "A value from an earlier step" named on a Set status / Set priority: '' when usable. */
function variableProblem(name: string | undefined, outputs: ReadonlySet<string>): string {
  const v = (name ?? '').trim();
  if (!v) return 'name the value to use, such as request.json.status.';
  return unknownVariables('{{' + v + '}}', outputs).length > 0 ? 'unknown value ' + v + '.' : '';
}

/**
 * A status or priority read from an earlier step: the stored value
 * (in_progress) or its label (In progress), any case. Anything else stops
 * the run rather than guessing.
 */
function chosenValue(
  wanted: string,
  allowed: readonly string[],
  labels: Record<string, string>,
  what: string,
): string {
  const v = wanted.trim().toLowerCase();
  const hit = allowed.find((k) => k === v || k.replace(/_/g, ' ') === v || (labels[k] ?? '').toLowerCase() === v);
  if (!hit) throw new Error('"' + wanted.slice(0, 40) + '" is not a ' + what);
  return hit;
}

/** What a node still needs before it can run, or ''. */
export function missingSettings(node: GraphNode, outputs: ReadonlySet<string> = new Set()): string {
  const c = node.config;
  switch (node.type) {
    case 'trigger':
      if (!TRIGGERS.some((t) => t.key === c.event)) return 'choose what starts it.';
      return c.event === 'http.received' && !c.apiKeyId ? 'choose the API key it accepts.' : '';
    case 'if':
      if (!CONDITION_FIELDS.some((f) => f.key === c.field)) return 'choose a field.';
      if (!OPERATORS.some((o) => o.key === c.op)) return 'choose a comparison.';
      if (c.field === 'variable') {
        const name = (c.variable ?? '').trim();
        if (!name) return 'name the value to compare, such as lookup.status.';
        const bad = unknownVariables('{{' + name + '}}', outputs);
        if (bad.length > 0) return 'unknown value ' + name + '.';
      }
      return '';
    case 'send_notification':
      if (!c.notificationId) return 'choose a notification.';
      if (!c.recipient) return 'choose who it goes to.';
      if (c.recipient === 'email' && !/^[^@\s]+@[^@\s]+$/.test(c.email ?? '')) return 'enter an email address.';
      return '';
    case 'set_status': {
      if (c.addNote === 'on') {
        if (!(c.note ?? '').trim()) return 'write the note, or untick "Add a note".';
        const bad = unknownVariables(c.note ?? '', outputs);
        if (bad.length > 0) return 'unknown variable ' + bad[0] + '.';
      }
      if (c.status === 'variable') return variableProblem(c.variable, outputs);
      return (TICKET_STATUSES as readonly string[]).includes(c.status ?? '') ? '' : 'choose a status.';
    }
    case 'set_priority':
      if (c.priority === 'variable') return variableProblem(c.variable, outputs);
      return (TICKET_PRIORITIES as readonly string[]).includes(c.priority ?? '') ? '' : 'choose a priority.';
    case 'create_ticket': {
      if (!c.templateId) return 'choose the template it is raised from.';
      if (!(c.title ?? '').trim()) return 'write the title.';
      const bad = unknownVariables((c.title ?? '') + ' ' + (c.description ?? '') + ' ' + (c.requesterEmail ?? ''), outputs);
      return bad.length > 0 ? 'unknown variable ' + bad[0] + '.' : '';
    }
    case 'route_group':
      return c.groupId ? '' : 'choose a group.';
    case 'assign':
      return c.userId ? '' : 'choose a technician.';
    case 'attach_files':
      return '';
    case 'create_template': {
      if (!(c.name ?? '').trim()) return 'write the name.';
      if (c.type === 'variable') {
        const v = variableProblem(c.variable, outputs);
        if (v) return v;
      } else if (!TEMPLATE_TYPES.includes(c.type ?? '')) return 'choose what kind of ticket it raises.';
      const bad = unknownVariables((c.name ?? '') + ' ' + (c.summary ?? ''), outputs);
      return bad.length > 0 ? 'unknown variable ' + bad[0] + '.' : '';
    }
    case 'create_notification': {
      if (!(c.name ?? '').trim()) return 'write the name.';
      // {{reference}}, {{title}}... are the notification's own placeholders,
      // filled when it is sent; only dotted ones are the automation's.
      const bad = unknownVariables((c.name ?? '') + ' ' + (c.subject ?? '') + ' ' + (c.body ?? ''), outputs)
        .filter((v) => v.includes('.'));
      return bad.length > 0 ? 'unknown variable ' + bad[0] + '.' : '';
    }
    case 'add_comment': {
      if (!(c.body ?? '').trim()) return 'write the comment.';
      const bad = unknownVariables(c.body ?? '', outputs);
      return bad.length > 0 ? 'unknown variable ' + bad[0] + '.' : '';
    }
    case 'http_request':
      return httpStepProblem(c, false, outputs);
    case 'http_request_auth':
      return httpStepProblem(c, true, outputs);
    case 'asset_email': {
      if (!['assignee', 'manager', 'email'].includes(c.recipient ?? '')) return 'choose who it goes to.';
      if (c.recipient === 'email' && !/^[^@\s]+@[^@\s]+$/.test(c.email ?? '') && !/\{\{/.test(c.email ?? '')) return 'enter an email address.';
      if (!(c.subject ?? '').trim()) return 'write the subject.';
      if (!(c.body ?? '').trim()) return 'write the message.';
      const bad = unknownVariables((c.subject ?? '') + ' ' + (c.body ?? ''), outputs);
      return bad.length > 0 ? 'unknown variable ' + bad[0] + '.' : '';
    }
    case 'asset_comment': {
      if (!(c.body ?? '').trim()) return 'write the comment.';
      const bad = unknownVariables(c.body ?? '', outputs);
      return bad.length > 0 ? 'unknown variable ' + bad[0] + '.' : '';
    }
    case 'asset_status':
      return c.statusId ? '' : 'choose a status.';
    default:
      return 'unknown node.';
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** Whether an event is what this trigger waits for. */
export function triggerMatches(config: Record<string, string>, event: TicketEvent): boolean {
  switch (config.event) {
    case 'ticket.created':
      return event.kind === 'ticket.created';
    case 'comment.added':
      return event.kind === 'comment.added';
    case 'sla.breached':
      return event.kind === 'sla.breached' && (!config.clock || config.clock === event.clock);
    case 'status.changed':
    case 'priority.changed':
    case 'assignee.changed':
    case 'group.changed': {
      if (event.kind !== 'ticket.updated') return false;
      const field = config.event.split('.')[0];
      return event.changes.some((c) => c.field === field);
    }
    default:
      return false;
  }
}

async function conditionHolds(config: Record<string, string>, ticket: TicketListItem, run: RunContext): Promise<boolean> {
  const wanted = (config.value ?? '').trim().toLowerCase();
  let actual: string;
  switch (config.field) {
    case 'variable':
      actual = variableValue((config.variable ?? '').trim(), { ...run, ticket });
      break;
    case 'requester_group': {
      const groups = await userGroupIdsFor(ticket.requester_id);
      const inGroup = groups.includes(config.value ?? '');
      return config.op === 'not_equals' ? !inGroup : inGroup;
    }
    case 'group':
      actual = ticket.group_id ?? '';
      break;
    case 'requester_email':
      actual = ticket.requester_email ?? '';
      break;
    case 'template':
      actual = (ticket as unknown as { template_id?: string | null }).template_id ?? '';
      break;
    default:
      actual = String((ticket as unknown as Record<string, unknown>)[config.field ?? ''] ?? '');
  }
  actual = actual.trim().toLowerCase();
  switch (config.op) {
    case 'equals':
      return actual === wanted;
    case 'not_equals':
      return actual !== wanted;
    case 'contains':
      return wanted !== '' && actual.includes(wanted);
    default:
      return false;
  }
}

/** Who an action is done as: the automation's author, else nobody in particular. */
async function actorFor(automation: AutomationRow): Promise<string | null> {
  if (automation.created_by) return automation.created_by;
  const admin = await queryOne<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1");
  return admin?.id ?? null;
}

/** The kinds a template made by an automation may raise. A task template needs a parent. */
const TEMPLATE_TYPES: readonly string[] = TICKET_TYPES.filter((t) => t !== 'task');

/**
 * Fills the automation's variables only - {{ticket.x}} and an earlier step's
 * {{name.x}} - and leaves a notification's own {{reference}} alone.
 */
function fillOwnVariables(text: string, run: RunContext): string {
  return text.replace(/\{\{\s*([a-z][a-z0-9_]*)((?:\.[A-Za-z0-9_-]+)+)\s*\}\}/g, (whole, head: string, rest: string) =>
    head === 'ticket' || run.outputs.has(head) ? fillVariables('{{' + head + rest + '}}', run, 'raw') : whole,
  );
}

/** "Create a ticket template". A name already taken: leave that one, or stop. */
async function templateFromStep(c: Record<string, string>, run: RunContext, actorId: string | null): Promise<string> {
  const name = fillVariables(c.name ?? '', run, 'raw').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('the template name came out empty');
  const existing = await findTemplateByName(name);
  if (existing) {
    if (c.ifExists === 'stop') throw new Error('a template named "' + name + '" already exists');
    return 'a template named "' + name + '" already exists, left as it is';
  }
  const type = c.type === 'variable'
    ? chosenValue(variableValue((c.variable ?? '').trim(), run), TEMPLATE_TYPES, TYPE_LABELS, 'ticket type')
    : (c.type ?? '');
  if (!TEMPLATE_TYPES.includes(type)) throw new Error('choose what kind of ticket it raises');
  const made = await createTemplateFrom(
    {
      name,
      summary: fillVariables(c.summary ?? '', run, 'raw').trim().slice(0, 300),
      type: type as never,
      basedOnId: c.basedOnId || null,
      isActive: c.offer === 'on',
    },
    actorId,
  );
  return '"' + made.name + '"' + (made.is_active ? ', offered to requesters' : ', not offered yet');
}

/** "Create a notification": a custom one, for Send notification steps to use. */
async function notificationFromStep(c: Record<string, string>, run: RunContext, actorId: string | null): Promise<string> {
  const name = fillVariables(c.name ?? '', run, 'raw').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) throw new Error('the notification name came out empty');
  if (await findNotificationByName(name)) {
    if (c.ifExists === 'stop') throw new Error('a notification named "' + name + '" already exists');
    return 'a notification named "' + name + '" already exists, left as it is';
  }
  const made = await createCustomNotification(name, actorId, {
    subject: fillOwnVariables(c.subject ?? '', run),
    bodyHtml: fillOwnVariables(c.body ?? '', run),
  });
  return '"' + made.name + '"';
}

/** "Create a ticket": raised from its template like a mail rule's ticket, with the template's tasks. */
async function createFromStep(
  c: Record<string, string>,
  run: RunContext,
  templates: readonly string[] | undefined,
): Promise<{ id: string; reference: string }> {
  const template = await findTemplate(c.templateId ?? '');
  if (!template || !template.is_active || !isUsable(template) || template.type === 'task') {
    throw new Error('the template is retired, unfinished or gone');
  }
  if (templates && templates.length > 0 && !templates.includes(template.id)) {
    throw new Error('the API key may not create tickets from "' + template.name + '"');
  }
  // The requester: an address given (it may come from the request), else
  // the ticket the run is about, else nobody in particular.
  const email = fillVariables(c.requesterEmail ?? '', run, 'raw').trim().toLowerCase();
  let requesterId: string;
  let externalEmail = '';
  if (email) {
    const person = await findUserByEmail(email);
    if (person && person.status === 'active') requesterId = person.id;
    else {
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('"' + email.slice(0, 60) + '" is not an email address');
      requesterId = await systemRequesterId();
      externalEmail = email;
    }
  } else if (run.ticket) {
    requesterId = run.ticket.requester_id;
  } else {
    requesterId = await systemRequesterId();
  }
  const title = fillVariables(c.title ?? '', run, 'raw').trim().slice(0, 200) || template.name;
  const description = fillVariables(c.description ?? '', run, 'raw').trim() || title;
  const ticket = await raiseFromRule(template, { title, description, requesterId, externalEmail, fallbackGroupId: null });
  return { id: ticket.id, reference: ticket.reference };
}

async function act(node: GraphNode, ticketId: string, actorId: string | null, run: RunContext): Promise<string> {
  const c = node.config;
  switch (node.type) {
    case 'http_request':
      return runHttpStep(c, run, false);
    case 'http_request_auth':
      return runHttpStep(c, run, true);
    case 'send_notification': {
      const recipient: AutomationRecipient =
        c.recipient === 'email' ? { email: c.email ?? '' } : (c.recipient as Exclude<AutomationRecipient, object>);
      const sent = await sendNotification(c.notificationId ?? '', ticketId, recipient);
      return 'notification queued for ' + sent;
    }
    case 'set_status': {
      const status = c.status === 'variable'
        ? chosenValue(variableValue((c.variable ?? '').trim(), run), TICKET_STATUSES, STATUS_LABELS, 'status')
        : (c.status ?? '');
      const before = (await getTicketById(ticketId))?.status;
      await updateTicket(ticketId, actorId ?? '', { status: status as never });
      // A note with it, when the step says so - the automation decides, even
      // where Settings requires one for cancelling by hand.
      const text = fillVariables(c.note ?? '', run, 'raw').trim();
      if (c.addNote === 'on' && text && actorId && before !== status) {
        const prefix =
          status === 'cancelled' ? 'Cancelled: ' : status === 'resolved' ? 'Resolved: ' : status === 'pending' ? 'On hold: ' : '';
        await addComment({ ticketId, authorId: actorId, body: prefix + text, isInternal: c.noteInternal === 'on' });
        return 'status ' + status + ', with a note';
      }
      return 'status ' + status;
    }
    case 'set_priority': {
      const priority = c.priority === 'variable'
        ? chosenValue(variableValue((c.variable ?? '').trim(), run), TICKET_PRIORITIES, PRIORITY_LABELS, 'priority')
        : (c.priority ?? '');
      await updateTicket(ticketId, actorId ?? '', { priority: priority as never });
      return 'priority ' + priority;
    }
    case 'route_group':
      await updateTicket(ticketId, actorId ?? '', { groupId: c.groupId ?? null });
      return 'routed';
    case 'assign':
      await updateTicket(ticketId, actorId ?? '', { assigneeId: c.userId ?? null });
      return 'assigned';
    case 'add_comment':
      if (!actorId) return 'skipped: no author';
      await addComment({ ticketId, authorId: actorId, body: fillVariables(c.body ?? '', run, 'raw'), isInternal: c.internal === 'on' });
      return 'comment added';
    default:
      return 'skipped';
  }
}

export interface RunResult {
  steps: string[];
  outcome: 'success' | 'failure' | 'stopped';
}

/**
 * Walks one automation for one ticket. Everything it does happens inside
 * withoutEvents(), so none of it sets off another automation.
 */
export async function runAutomation(
  automation: AutomationRow,
  startedFor: string | null,
  started: {
    request?: StepOutput;
    allowed?: readonly string[];
    templates?: readonly string[];
    /** Files the request carried, for an "Attach the files" step. */
    files?: IncomingAttachment[];
    /** The asset an asset trigger started this for (step 4 of assets). */
    assetId?: string;
  } = {},
): Promise<RunResult> {
  // The ticket the steps act on. A run started by a request may have none
  // until a "Create a ticket" step makes one, which later steps then act on.
  let ticketId = startedFor;
  const { graph } = automation;
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  const steps: string[] = [];
  let outcome: RunResult['outcome'] = 'success';

  try {
    // Quiet (sets off no other automation) and automatic (no comment or
    // status change here is a first response).
    await withoutEvents(() => asAutomatic(async () => {
      const actorId = await actorFor(automation);
      // Outputs of HTTP steps, readable by every later step of this run.
      const outputs: RunContext['outputs'] = new Map();
      if (started.request) outputs.set('request', started.request);
      // Depth first, in the order the wires were made: everything after one
      // action runs before the next action of the same trigger.
      const next = (from: string, pin: Pin) =>
        graph.edges.filter((e) => e.from === from && e.pin === pin).map((e) => e.to);
      const stack = trigger ? next(trigger.id, 'next').reverse() : [];
      for (let i = 0; stack.length > 0; i += 1) {
        if (i >= MAX_STEPS) {
          outcome = 'stopped';
          steps.push('stopped after ' + MAX_STEPS + ' steps');
          break;
        }
        const cursor = stack.pop()!;
        const node = graph.nodes.find((n) => n.id === cursor);
        if (!node) continue;
        const ticket = ticketId ? await getTicketById(ticketId) : undefined;
        if (ticketId && !ticket) {
          steps.push('ticket gone');
          break;
        }
        let pin: Pin = 'next';
        // An asset run reads the asset afresh each step: an earlier one may have changed it.
        const asset = started.assetId ? await getAsset(started.assetId) : undefined;
        if (started.assetId && !asset) {
          steps.push('asset gone');
          break;
        }
        const run: RunContext = { ticket: ticket ?? null, outputs, asset: asset ? await assetVariables(asset) : null };
        // A key limited to some templates acts only on their tickets.
        const templateOf = (ticket as unknown as { template_id?: string | null } | undefined)?.template_id ?? '';
        if (ticket && started.templates && started.templates.length > 0 && !started.templates.includes(templateOf)) {
          throw new Error('the API key may not act on tickets from this template');
        }
        if (ASSET_STEPS.includes(node.type)) {
          if (!asset) throw new Error((nodeSpec(node.type)?.label ?? 'A step') + ' needs an asset: start the automation with an asset trigger');
          steps.push(nodeSpec(node.type)!.label + ': ' + (await assetAct(node, asset.id, actorId, run)));
          stack.push(...next(node.id, 'next').reverse());
          continue;
        }
        const needsTicket = node.type !== 'create_ticket' && node.type !== 'http_request' && node.type !== 'http_request_auth' &&
          node.type !== 'create_template' && node.type !== 'create_notification' &&
          !(node.type === 'if' && node.config.field === 'variable');
        if (!ticket && needsTicket) {
          throw new Error((nodeSpec(node.type)?.label ?? 'A step') + ' needs a ticket: name one in the request ("ticket"), or create one first');
        }
        if (node.type === 'attach_files') {
          if (started.allowed && !started.allowed.includes(node.type)) {
            throw new Error('the API key may not run ' + actionLabel(node.type));
          }
          const files = started.files ?? [];
          if (files.length === 0) {
            steps.push('Attach the files from the request: none were sent');
          } else {
            // Who the files are recorded as uploaded by: the automation's
            // author, else the account mail from strangers hangs off.
            const by = actorId ?? (await systemRequesterId());
            const kept = await storeIncomingAttachments(ticketId!, by, files, { isInternal: node.config.internal === 'on' });
            const note = skippedNote(kept.skipped).replace('on this email', 'in this request');
            if (note && actorId) await addComment({ ticketId: ticketId!, authorId: actorId, body: note, isInternal: true });
            steps.push(
              'Attach the files from the request: ' + kept.stored + ' attached' +
                (kept.skipped.length ? ', ' + kept.skipped.length + ' not kept' : ''),
            );
          }
          stack.push(...next(node.id, 'next').reverse());
          continue;
        }
        if (node.type === 'create_template' || node.type === 'create_notification') {
          if (started.allowed && !started.allowed.includes(node.type)) {
            throw new Error('the API key may not run ' + actionLabel(node.type));
          }
          const said = node.type === 'create_template'
            ? await templateFromStep(node.config, run, actorId)
            : await notificationFromStep(node.config, run, actorId);
          steps.push(nodeSpec(node.type)!.label + ': ' + said);
          stack.push(...next(node.id, 'next').reverse());
          continue;
        }
        if (node.type === 'create_ticket') {
          if (started.allowed && !started.allowed.includes(node.type)) {
            throw new Error('the API key may not run ' + actionLabel(node.type));
          }
          const made = await createFromStep(node.config, run, started.templates);
          ticketId = made.id;
          steps.push('Create a ticket: ' + made.reference + ' - later steps act on it');
          stack.push(...next(node.id, 'next').reverse());
          continue;
        }
        if (node.type === 'if' && !ticket) {
          const holds = await conditionHolds(node.config, {} as TicketListItem, run);
          pin = holds ? 'true' : 'false';
          steps.push('If ' + (node.config.field ?? '') + ': ' + pin);
          stack.push(...next(node.id, pin).reverse());
          continue;
        }
        if (node.type === 'if') {
          const holds = await conditionHolds(node.config, ticket!, run);
          pin = holds ? 'true' : 'false';
          steps.push('If ' + (node.config.field ?? '') + ': ' + pin);
        } else {
          // Started with an API key: only what the key was given, checked
          // now rather than trusted from when it was switched on.
          if (started.allowed && !started.allowed.includes(node.type)) {
            throw new Error('the API key may not run ' + actionLabel(node.type));
          }
          steps.push(nodeSpec(node.type)?.label + ': ' + (await act(node, ticketId ?? '', actorId, run)));
        }
        stack.push(...next(node.id, pin).reverse());
      }
    }));
  } catch (err) {
    outcome = 'failure';
    steps.push('failed: ' + (err instanceof Error ? err.message : String(err)));
    log.warn({ err, automationId: automation.id, ticketId }, 'automation run failed');
  }

  await execute(
    `INSERT INTO automation_runs (id, automation_id, ticket_id, ran_at, outcome, steps)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), automation.id, ticketId, nowIso(), outcome, JSON.stringify(steps)],
  );
  audit({
    action: 'automation.ran',
    outcome: outcome === 'failure' ? 'failure' : 'success',
    actorId: null,
    targetType: ticketId ? 'ticket' : 'automation',
    targetId: ticketId ?? automation.id,
    detail: { automation: automation.name, steps },
  });
  return { steps, outcome };
}

/** Runs still going in the background, so a test (or shutdown) can wait for them. */
const background = new Set<Promise<unknown>>();

/** Resolves once every background run has finished. */
export async function settleAutomations(): Promise<void> {
  while (background.size > 0) await Promise.allSettled([...background]);
}

/** Whether an automation calls out over HTTP, and so may take seconds. */
function callsOut(automation: AutomationRow): boolean {
  return automation.graph.nodes.some((n) => n.type === 'http_request' || n.type === 'http_request_auth');
}

/**
 * The listener: every enabled automation whose trigger matches.
 *
 * One that calls an API runs in the background: the requester raising the
 * ticket must not wait on somebody else's server, its timeout or its
 * retries. One that only changes the ticket runs at once, so the page the
 * requester lands on already shows what it did.
 */
async function onEvent(event: TicketEvent): Promise<void> {
  const automations = (await listAutomations()).filter((a) => a.is_enabled);
  for (const automation of automations) {
    const trigger = automation.graph.nodes.find((n) => n.type === 'trigger');
    if (!trigger || !triggerMatches(trigger.config, event)) continue;
    if (callsOut(automation)) {
      const run = runAutomation(automation, event.ticketId)
        .catch((err: unknown) => log.error({ err, automationId: automation.id }, 'background automation run failed'))
        .finally(() => background.delete(run));
      background.add(run);
    } else {
      await runAutomation(automation, event.ticketId);
    }
  }
}

// ---------------------------------------------------------------------------
// Assets (step 4)
// ---------------------------------------------------------------------------

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain message as a plain email: escaped, its line breaks kept. */
function messageHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => '<p style="margin:0 0 12px">' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1d1d1b">' + paragraphs.join('') + '</div>';
}

/** One asset step, on the asset the run is about. */
async function assetAct(node: GraphNode, assetId: string, actorId: string | null, run: RunContext): Promise<string> {
  const c = node.config;
  const actor = actorId ? { id: actorId } : null;
  switch (node.type) {
    case 'asset_comment':
      await addAssetComment(assetId, fillVariables(c.body ?? '', run, 'raw'), actor);
      return 'comment added';
    case 'asset_status': {
      const status = (await listAssetStatuses()).find((x) => x.id === c.statusId);
      if (!status) throw new Error('the status it sets no longer exists');
      await setAssetStatus(assetId, status.id, actor);
      return 'status ' + status.name;
    }
    case 'asset_email': {
      const asset = (await getAsset(assetId))!;
      const holder = asset.assigned_to ? await findUserById(asset.assigned_to) : undefined;
      const to =
        c.recipient === 'assignee' ? holder?.email ?? ''
          : c.recipient === 'manager' ? (holder?.manager_id ? (await findUserById(holder.manager_id))?.email ?? '' : '')
            : fillVariables(c.email ?? '', run, 'raw').trim();
      if (!to) return 'not sent: ' + (c.recipient === 'manager' ? 'the person it is assigned to has no manager' : 'nobody to send it to');
      const subject = fillVariables(c.subject ?? '', run, 'raw').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
      const sent = await mailOne(to, subject, messageHtml(fillVariables(c.body ?? '', run, 'raw')));
      return sent ? 'queued for ' + to : 'not sent: no mailbox or relay to send it';
    }
    default:
      return 'skipped';
  }
}

/** Whether an asset change is what this trigger waits for. */
export function assetTriggerMatches(config: Record<string, string>, change: AssetChange): boolean {
  switch (config.event) {
    case 'asset.created':
      return change.created;
    case 'asset.status.changed':
      return !change.created && change.statusFrom !== change.statusTo && (!config.toStatus || config.toStatus === change.statusTo);
    case 'asset.assigned':
      return change.assigneeTo !== null && change.assigneeTo !== change.assigneeFrom;
    default:
      return false;
  }
}

/** Set while an asset run works, so what it changes does not start more runs. */
const assetRunning = new AsyncLocalStorage<true>();

async function onAssetEvent(change: AssetChange): Promise<void> {
  if (assetRunning.getStore()) return;
  const automations = (await listAutomations()).filter((a) => a.is_enabled);
  for (const automation of automations) {
    const trigger = automation.graph.nodes.find((n) => n.type === 'trigger');
    if (!trigger || !assetTriggerMatches(trigger.config, change)) continue;
    const go = () => assetRunning.run(true, () => runAutomation(automation, null, { assetId: change.assetId }));
    if (callsOut(automation)) {
      const run = go()
        .catch((err: unknown) => log.error({ err, automationId: automation.id }, 'background automation run failed'))
        .finally(() => background.delete(run));
      background.add(run);
    } else {
      await go();
    }
  }
}

let installed = false;

/** Called once at start-up (and by createApp, so tests get it too). */
export function installAutomations(): void {
  onTicketEvent(onEvent);
  if (!installed) {
    installed = true;
    onAssetChange(onAssetEvent);
  }
}

export interface RunRow {
  id: string;
  automation_id: string;
  ticket_id: string;
  ran_at: string;
  outcome: string;
  steps: string;
}

export function recentRuns(automationId: string): Promise<RunRow[]> {
  return query<RunRow>(
    'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY ran_at DESC LIMIT 20',
    [automationId],
  );
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

interface ExampleStep {
  key: string;
  type: NodeType;
  x: number;
  y: number;
  config: Record<string, string>;
}

/**
 * Worked examples, so an administrator can open one and see how the pieces
 * fit. Created **switched off** and **once ever** (seed_markers), so a
 * deleted example stays deleted and none runs until somebody means it to.
 * Each is a real, valid graph apart from the HTTP one, which needs an API
 * key chosen before it can be switched on.
 */
const EXAMPLES: { name: string; trigger: TriggerKey; triggerConfig?: Record<string, string>; steps: ExampleStep[]; wires: [string, Pin, string][] }[] = [
  {
    name: 'Example: urgent tickets get a note for the duty engineer',
    trigger: 'ticket.created',
    steps: [
      { key: 'urgent', type: 'if', x: 330, y: 120, config: { field: 'priority', op: 'equals', value: 'urgent' } },
      { key: 'note', type: 'add_comment', x: 580, y: 60, config: { body: 'Urgent ticket {{ticket.reference}} - call the duty engineer.', internal: 'on' } },
    ],
    wires: [['trigger', 'next', 'urgent'], ['urgent', 'true', 'note']],
  },
  {
    name: 'Example: thank the requester when a ticket is resolved',
    trigger: 'status.changed',
    steps: [
      { key: 'resolved', type: 'if', x: 330, y: 120, config: { field: 'status', op: 'equals', value: 'resolved' } },
      { key: 'thanks', type: 'add_comment', x: 580, y: 60, config: { body: 'Thank you, {{ticket.requester_name}}. We have resolved {{ticket.reference}}. Reply to this message if anything is still wrong.' } },
    ],
    wires: [['trigger', 'next', 'resolved'], ['resolved', 'true', 'thanks']],
  },
  {
    name: 'Example: a late ticket becomes urgent',
    trigger: 'sla.breached',
    triggerConfig: { clock: 'resolution' },
    steps: [
      { key: 'urgent', type: 'set_priority', x: 330, y: 120, config: { priority: 'urgent' } },
      { key: 'note', type: 'add_comment', x: 580, y: 120, config: { body: 'The resolution target was missed, so the priority is now Urgent.', internal: 'on' } },
    ],
    wires: [['trigger', 'next', 'urgent'], ['urgent', 'next', 'note']],
  },
  {
    name: 'Example: another system raises a ticket',
    trigger: 'http.received',
    steps: [
      { key: 'create', type: 'create_ticket', x: 330, y: 120, config: { title: '{{request.json.title}}', description: '{{request.json.description}}', requesterEmail: '{{request.json.email}}' } },
      { key: 'priority', type: 'set_priority', x: 580, y: 120, config: { priority: 'variable', variable: 'request.json.priority' } },
    ],
    wires: [['trigger', 'next', 'create'], ['create', 'next', 'priority']],
  },
  {
    name: 'Example: another system sets a status, or adds a comment',
    trigger: 'http.received',
    steps: [
      { key: 'which', type: 'if', x: 330, y: 120, config: { field: 'variable', variable: 'request.json.action', op: 'equals', value: 'status' } },
      { key: 'status', type: 'set_status', x: 580, y: 50, config: { status: 'variable', variable: 'request.json.status' } },
      { key: 'comment', type: 'add_comment', x: 580, y: 200, config: { body: '{{request.json.message}}', internal: 'on' } },
    ],
    wires: [['trigger', 'next', 'which'], ['which', 'true', 'status'], ['which', 'false', 'comment']],
  },
];

/** Added later, so a database that already has the first set gets these once too. */
const LATER_EXAMPLES: typeof EXAMPLES = [
  {
    name: 'Example: another system adds a ticket template and its notification',
    trigger: 'http.received',
    steps: [
      {
        key: 'template', type: 'create_template', x: 330, y: 120,
        config: { name: '{{request.json.name}}', summary: '{{request.json.summary}}', type: 'variable', variable: 'request.json.type', ifExists: 'skip' },
      },
      {
        key: 'notification', type: 'create_notification', x: 580, y: 120,
        config: {
          name: '{{request.json.name}} - update',
          subject: '[{{reference}}] {{title}}',
          body: '<p>Hello {{requesterName}},</p>\n<p>{{request.json.message}}</p>\n<p><a href="{{ticketUrl}}">Open the ticket</a></p>',
          ifExists: 'skip',
        },
      },
    ],
    wires: [['trigger', 'next', 'template'], ['template', 'next', 'notification']],
  },
];

/** Adds the examples, switched off, the first time this runs on a database. */
export async function ensureExampleAutomations(defaultTemplateId: string | null): Promise<number> {
  let made = 0;
  for (const [marker, set] of [['example_automations', EXAMPLES], ['example_automations_2', LATER_EXAMPLES]] as const) {
    made += await addExamples(marker, set, defaultTemplateId);
  }
  return made;
}

async function addExamples(marker: string, examples: typeof EXAMPLES, defaultTemplateId: string | null): Promise<number> {
  const done = await queryOne<{ key: string }>('SELECT key FROM seed_markers WHERE key = ?', [marker]);
  if (done) return 0;
  let made = 0;
  for (const example of examples) {
    const clash = await queryOne<{ id: string }>('SELECT id FROM automations WHERE lower(name) = lower(?)', [example.name]);
    if (clash) continue;
    const ids = new Map<string, string>([['trigger', newId()]]);
    for (const step of example.steps) ids.set(step.key, newId());
    const graph: Graph = {
      nodes: [
        { id: ids.get('trigger')!, type: 'trigger', x: 80, y: 120, config: { event: example.trigger, ...(example.triggerConfig ?? {}) } },
        ...example.steps.map((s) => ({
          id: ids.get(s.key)!,
          type: s.type,
          x: s.x,
          y: s.y,
          config:
            s.type === 'create_ticket' && defaultTemplateId ? { templateId: defaultTemplateId, ...s.config }
              : s.type === 'create_template' && defaultTemplateId ? { basedOnId: defaultTemplateId, ...s.config }
                : s.config,
        })),
      ],
      edges: example.wires.map(([from, pin, to]) => ({ from: ids.get(from)!, pin, to: ids.get(to)! })),
    };
    const now = nowIso();
    await execute(
      `INSERT INTO automations (id, name, is_enabled, graph, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, NULL, ?, ?)`,
      [newId(), example.name, JSON.stringify(graph), now, now],
    );
    made += 1;
  }
  await execute('INSERT INTO seed_markers (key, done_at) VALUES (?, ?)', [marker, nowIso()]);
  return made;
}

/**
 * Once, at start-up: marks what automations wrote before writes were marked
 * (migration 56), so an old automatic reply stops counting as a first
 * response too. A run records only when it ended, so this takes the run's
 * ticket, the account the automation acts as, and the two minutes before the
 * run ended - longer than any run with its HTTP retries. Seed marker
 * `automation_writes_marked`.
 */
export async function markPastAutomationWrites(): Promise<number> {
  const marker = 'automation_writes_marked';
  if (await queryOne('SELECT key FROM seed_markers WHERE key = ?', [marker])) return 0;
  const fallback = (await queryOne<{ id: string }>("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1"))?.id ?? null;
  const runs = await query<{ ticket_id: string; ran_at: string; created_by: string | null }>(
    `SELECT r.ticket_id, r.ran_at, a.created_by FROM automation_runs r JOIN automations a ON a.id = r.automation_id
      WHERE r.ticket_id IS NOT NULL`,
  );
  let marked = 0;
  for (const run of runs) {
    const actor = run.created_by ?? fallback;
    if (!actor) continue;
    const from = new Date(new Date(run.ran_at).getTime() - 120_000).toISOString();
    marked += await execute(
      'UPDATE ticket_comments SET automatic = 1 WHERE ticket_id = ? AND author_id = ? AND created_at >= ? AND created_at <= ? AND automatic = 0',
      [run.ticket_id, actor, from, run.ran_at],
    );
    marked += await execute(
      "UPDATE ticket_events SET automatic = 1 WHERE ticket_id = ? AND actor_id = ? AND kind = 'field_changed' AND created_at >= ? AND created_at <= ? AND automatic = 0",
      [run.ticket_id, actor, from, run.ran_at],
    );
  }
  await execute('INSERT INTO seed_markers (key, done_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [marker, nowIso()]);
  if (marked > 0) log.info({ marked, runs: runs.length }, 'marked earlier automation writes as automatic');
  return marked;
}
