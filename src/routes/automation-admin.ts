import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { conflict, HttpError, notFound } from '../lib/errors.js';
import { writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import { query } from '../db/index.js';
import { settings, updateSettings } from '../settings/index.js';
import {
  CONDITION_FIELDS,
  NODE_TYPES,
  OPERATORS,
  TRIGGERS,
  SLA_CLOCKS,
  addNode,
  configureNode,
  connect,
  disconnect,
  createAutomation,
  deleteAutomation,
  deleteNode,
  findAutomation,
  graphProblems,
  isHttpTriggered,
  keyProblem,
  listAutomations,
  missingSettings,
  nodeSpec,
  outputNames,
  recentRuns,
  setPositions,
  setTargets,
  moveNode,
  renameAutomation,
  setAutomationEnabled,
  type Graph,
  type GraphNode,
  type NodeType,
  type Pin,
  type TriggerKey,
} from '../services/automation.js';
import { BODY_TYPES, HTTP_METHODS, MAX_TIMEOUT_S, TICKET_VARIABLES, testHttpStep } from '../services/automation-http.js';
import {
  AUTH_TYPES,
  authTypeLabel,
  connectionRedirectUri,
  finishUserSignIn,
  startUserSignIn,
  connectionProblems,
  createConnection,
  deleteConnection,
  listConnections,
  testConnection,
  updateConnection,
  type ConnectionInput,
} from '../services/automation-connections.js';
import { listNotifications } from '../services/mail/notifications.js';
import { listActiveTemplates } from '../services/templates.js';
import { listApiKeys } from '../services/api-keys.js';
import { config as appConfig } from '../config.js';
import { listActiveGroups } from '../services/groups.js';
import { listAssignableStaff } from '../services/users.js';
import { listUserGroups } from '../services/user-groups.js';
import { PRIORITY_LABELS, STATUS_LABELS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_TYPES, TYPE_LABELS } from '../services/tickets.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { allowFormActionTo, allowOwnScripts } from '../middleware/security.js';
import { settingsView } from './settings-shared.js';

/**
 * Settings - Advanced - Automation and Connections.
 *
 * The editor is forms, no script: each step is a card with its settings and
 * where each of its outputs leads, saved with one post; a diagram drawn on
 * the server shows the whole graph above them. Every post returns to the
 * card it came from (`#node-<id>`).
 */
export const automationAdminRouter = Router();
export const connectionsAdminRouter = Router();

const BASE = '/admin/settings/advanced/automation';
const CONNECTIONS = '/admin/settings/advanced/connections';

/** The settings each step type reads from its form. Nothing else is stored. */
const FIELDS: Record<NodeType, string[]> = {
  trigger: ['event', 'apiKeyId', 'clock'],
  if: ['field', 'op', 'value', 'variable'],
  send_notification: ['notificationId', 'recipient', 'email'],
  set_status: ['status', 'variable', 'addNote', 'note', 'noteInternal'],
  set_priority: ['priority', 'variable'],
  route_group: ['groupId'],
  assign: ['userId'],
  add_comment: ['body', 'internal'],
  create_ticket: ['templateId', 'title', 'description', 'requesterEmail'],
  attach_files: ['internal'],
  create_template: ['name', 'summary', 'type', 'variable', 'basedOnId', 'offer', 'ifExists'],
  create_notification: ['name', 'subject', 'body', 'ifExists'],
  http_request: ['method', 'url', 'query', 'headers', 'bodyType', 'body', 'timeout', 'retries', 'output', 'onError'],
  http_request_auth: ['connectionId', 'method', 'url', 'query', 'headers', 'bodyType', 'body', 'timeout', 'retries', 'output', 'onError'],
};

// ---------------------------------------------------------------------------
// The diagram
// ---------------------------------------------------------------------------

const BOX_W = 200;
const BOX_H = 58;
const COL = 250;
const ROW = 84;

/** A one-line reminder of what a step does, for its box. */
function summary(node: GraphNode, names: Map<string, string>): string {
  const c = node.config;
  switch (node.type) {
    case 'trigger': return TRIGGERS.find((t) => t.key === c.event)?.label ?? '';
    case 'if': {
      // What a person would say: "Template is Default request", not its id.
      // Short words: a box has room for about 34 characters.
      const SHORT: Record<string, string> = {
        template: 'Template', group: 'Group', requester_group: 'Requester group',
        requester_email: 'Requester email', priority: 'Priority', status: 'Status',
        type: 'Type', title: 'Title', description: 'Description',
      };
      const field = c.field === 'variable' ? c.variable : SHORT[c.field ?? ''] ?? CONDITION_FIELDS.find((f) => f.key === c.field)?.label;
      const value =
        c.field === 'status' ? STATUS_LABELS[c.value as keyof typeof STATUS_LABELS] ?? c.value
          : c.field === 'priority' ? PRIORITY_LABELS[c.value as keyof typeof PRIORITY_LABELS] ?? c.value
            : c.field === 'type' ? TYPE_LABELS[c.value as keyof typeof TYPE_LABELS] ?? c.value
              : names.get(c.value ?? '') ?? c.value;
      return [field, OPERATORS.find((o) => o.key === c.op)?.label, value].filter(Boolean).join(' ');
    }
    case 'route_group': return names.get(c.groupId ?? '') ?? '';
    case 'create_ticket': return 'from ' + (names.get(c.templateId ?? '') ?? 'a template');
    case 'set_status': return c.status === 'variable' ? 'from ' + (c.variable ?? '') : STATUS_LABELS[c.status as keyof typeof STATUS_LABELS] ?? '';
    case 'set_priority': return c.priority === 'variable' ? 'from ' + (c.variable ?? '') : PRIORITY_LABELS[c.priority as keyof typeof PRIORITY_LABELS] ?? '';
    case 'http_request':
    case 'http_request_auth': {
      let host = '';
      try {
        host = new URL((c.url ?? '').replace(/\{\{[^}]*\}\}/g, 'x')).host;
      } catch {
        host = '';
      }
      return [c.method, host].filter(Boolean).join(' ') + (node.type === 'http_request_auth' && c.connectionId ? ' via ' + (names.get(c.connectionId) ?? '?') : '');
    }
    case 'add_comment': return (c.body ?? '').slice(0, 30);

    case 'attach_files': return c.internal === 'on' ? 'as internal files' : 'visible to the requester';
    case 'create_template':
    case 'create_notification': return (c.name ?? '').slice(0, 30);
    default: return '';
  }
}

/** Columns by distance from the trigger; unreachable ones last. */
function autoPositions(graph: Graph): { at: Map<string, { x: number; y: number }>; reached: Set<string> } {
  const depth = new Map<string, number>();
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (trigger) {
    depth.set(trigger.id, 0);
    const queue = [trigger.id];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const e of graph.edges.filter((x) => x.from === id)) {
        if (!depth.has(e.to)) {
          depth.set(e.to, depth.get(id)! + 1);
          queue.push(e.to);
        }
      }
    }
  }
  const lastColumn = Math.max(0, ...depth.values()) + 1;
  const rows = new Map<number, number>();
  const at = new Map<string, { x: number; y: number }>();
  for (const n of graph.nodes) {
    const col = depth.has(n.id) ? depth.get(n.id)! : lastColumn;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    at.set(n.id, { x: 16 + col * COL, y: 16 + row * ROW });
  }
  return { at, reached: new Set(depth.keys()) };
}

/**
 * Where each box is drawn. The saved positions once somebody has placed the
 * boxes (by dragging, or Arrange); before that - while they still overlap,
 * as steps added through the forms do - the automatic columns.
 */
export function positions(graph: Graph): { at: Map<string, { x: number; y: number }>; reached: Set<string>; stored: boolean } {
  const auto = autoPositions(graph);
  const saved = graph.nodes.map((n) => ({ id: n.id, x: Number(n.x) || 0, y: Number(n.y) || 0 }));
  const overlapping = saved.some((p, i) => saved.some((q, j) => j > i && Math.abs(p.x - q.x) < BOX_W && Math.abs(p.y - q.y) < BOX_H));
  if (overlapping) return { ...auto, stored: false };
  return { at: new Map(saved.map((p) => [p.id, { x: p.x, y: p.y }])), reached: auto.reached, stored: true };
}

/** A place for a new step: to the right of what it follows, clear of other boxes. */
function freeSpot(graph: Graph, afterId: string): { x: number; y: number } {
  const { at, stored } = positions(graph);
  if (!stored) return { x: 0, y: 0 }; // still laid out automatically
  const after = at.get(afterId);
  let x = after ? after.x + COL : Math.max(16, ...[...at.values()].map((p) => p.x + COL));
  let y = after ? after.y : 16;
  const taken = (px: number, py: number) => [...at.values()].some((p) => Math.abs(p.x - px) < BOX_W && Math.abs(p.y - py) < BOX_H);
  for (let i = 0; i < 50 && taken(x, y); i += 1) y += ROW;
  x = Math.min(x, 4800);
  return { x, y };
}

/**
 * A wire from an output dot to an input dot. Forwards: one gentle curve.
 * Into a box to the left: out to the right, along a channel between (or
 * under) the two boxes, and into the input from the left - never back
 * through the boxes in a loop. automation-canvas.js draws the same shape
 * while a box is dragged (curve()); keep the two in step.
 */
function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  if (dx >= 24) {
    const bend = Math.max(24, Math.min(120, dx / 2));
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 + bend) + ' ' + y1 + ' ' + (x2 - bend) + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }
  const g = 24;
  const ym = Math.abs(y2 - y1) > BOX_H + 8 ? (y1 + y2) / 2 : Math.max(y1, y2) + BOX_H / 2 + 18;
  return (
    'M' + x1 + ' ' + y1 +
    ' C' + (x1 + g) + ' ' + y1 + ' ' + (x1 + g) + ' ' + ym + ' ' + x1 + ' ' + ym +
    ' L' + x2 + ' ' + ym +
    ' C' + (x2 - g) + ' ' + ym + ' ' + (x2 - g) + ' ' + y2 + ' ' + x2 + ' ' + y2
  );
}

/** Where a pin's dot sits on its box. */
function pinPoint(x: number, y: number, pins: readonly string[], pin: string): { cx: number; cy: number } {
  const i = Math.max(0, pins.indexOf(pin));
  return { cx: x + BOX_W, cy: y + (BOX_H * (i + 1)) / (pins.length + 1) };
}

/** The diagram: boxes, their output pins, and the wires between them. */
function diagram(graph: Graph, outputs: ReadonlySet<string>, connectionNames: Map<string, string>) {
  const { at, reached, stored } = positions(graph);
  const boxes = graph.nodes.map((n) => {
    const p = at.get(n.id)!;
    const pins = (nodeSpec(n.type)?.pins ?? []) as readonly string[];
    return {
      id: n.id,
      x: p.x,
      y: p.y,
      label: nodeSpec(n.type)?.label ?? n.type,
      summary: summary(n, connectionNames).slice(0, 34),
      kind: nodeSpec(n.type)?.kind ?? 'action',
      problem: missingSettings(n, outputs) !== '',
      reached: reached.has(n.id),
      pins: pins.map((pin) => ({ pin, label: pin === 'true' ? 'Yes' : pin === 'false' ? 'No' : '', ...pinPoint(p.x, p.y, pins, pin) })),
      // Where wires arrive: nothing leads into the trigger.
      input: n.type === 'trigger' ? null : { cx: p.x, cy: p.y + BOX_H / 2 },
    };
  });
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const drawn = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const startOf = (e: (typeof drawn)[number]) => {
    const a = byId.get(e.from)!;
    return a.pins.find((p) => p.pin === e.pin) ?? { cx: a.x + BOX_W, cy: a.y + BOX_H / 2 };
  };
  // Every wire runs dot to dot: out of a pin's dot, into the box's one input
  // dot on its left edge.
  const wires = drawn.map((e) => {
    const b = byId.get(e.to)!;
    const start = startOf(e);
    const x1 = start.cx;
    const y1 = start.cy;
    const x2 = b.x;
    const y2 = b.y + BOX_H / 2;
    return {
      from: e.from,
      to: e.to,
      d: wirePath(x1, y1, x2, y2),
      pin: e.pin === 'next' ? '' : e.pin,
      edgePin: e.pin,
      // Beside its own dot, above Yes and below No, so two labels never meet.
      lx: x1 + 10,
      ly: e.pin === 'false' ? y1 + 15 : y1 - 6,
    };
  });
  const width = Math.max(600, ...boxes.map((box) => box.x + BOX_W + 48));
  const height = Math.max(120, ...boxes.map((box) => box.y + BOX_H + 32));
  return { boxes, wires, width, height, boxW: BOX_W, boxH: BOX_H, stored };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function renderList(res: Response, extra: { status?: number; openDialog?: string | null; errors?: FieldErrors; values?: Record<string, unknown> } = {}) {
  if (extra.status) res.status(extra.status);
  const automations = await listAutomations();
  const last = await query<{ automation_id: string; ran_at: string; outcome: string }>(
    // Each automation's newest run. Not "max(ran_at), outcome ... GROUP BY":
    // that takes outcome from the newest row only in SQLite.
    `SELECT r.automation_id, r.ran_at, r.outcome FROM automation_runs r
      WHERE r.ran_at = (SELECT max(ran_at) FROM automation_runs x WHERE x.automation_id = r.automation_id)`,
  );
  res.render(
    'admin/settings/automations',
    settingsView('advanced', {
      automations: automations.map((a) => ({
        ...a,
        trigger: TRIGGERS.find((t) => t.key === a.graph.nodes.find((n) => n.type === 'trigger')?.config.event)?.label ?? '',
        lastRun: last.find((l) => l.automation_id === a.id) ?? null,
      })),
      triggers: TRIGGERS,
      allowPrivateNetwork: settings().httpRequests.allowPrivateNetwork,
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
    }),
  );
}

automationAdminRouter.get('/', asyncHandler(async (_req, res) => renderList(res)));

/** The newest runs of every automation, for "what has been running?". */
automationAdminRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const asked = Number(req.query.page);
    const page = Number.isInteger(asked) && asked > 0 ? asked : 1;
    const perPage = 50;

    const rows = await query<{
      id: string;
      automation_id: string;
      automation_name: string;
      ticket_id: string | null;
      reference: string | null;
      ticket_title: string | null;
      ran_at: string;
      outcome: string;
      steps: string;
    }>(
      `SELECT r.id, r.automation_id, a.name AS automation_name, r.ticket_id,
              t.ref_prefix, t.ref_seq, t.seq, t.title AS ticket_title,
              r.ran_at, r.outcome, r.steps
         FROM automation_runs r
         JOIN automations a ON a.id = r.automation_id
         LEFT JOIN tickets t ON t.id = r.ticket_id
        ORDER BY r.ran_at DESC
        LIMIT ? OFFSET ?`,
      [perPage + 1, (page - 1) * perPage],
    );

    const more = rows.length > perPage;
    const runs = rows.slice(0, perPage).map((row) => {
      const raw = row as unknown as Record<string, unknown>;
      const prefix = typeof raw.ref_prefix === 'string' ? raw.ref_prefix : '';
      const refSeq = Number(raw.ref_seq ?? raw.seq ?? 0);
      return {
        id: row.id,
        automationId: row.automation_id,
        automationName: row.automation_name,
        ticketId: row.ticket_id,
        // The same reference the ticket shows, built the same way.
        reference: row.ticket_id && prefix ? prefix + '-' + String(refSeq).padStart(6, '0') : '',
        ticketTitle: row.ticket_title ?? '',
        ranAt: row.ran_at,
        outcome: row.outcome,
        // How far it got. The steps are stored as JSON; only their number is
        // shown here, because the detail belongs on the automation's page.
        steps: (() => {
          try {
            const parsed: unknown = JSON.parse(row.steps);
            return Array.isArray(parsed) ? parsed.length : 0;
          } catch {
            return 0;
          }
        })(),
      };
    });

    res.render(
      'admin/settings/automation-runs',
      settingsView('advanced', { runs, page, more }),
    );
  }),
);

automationAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = (typeof body.name === 'string' ? body.name : '').trim();
    const trigger = String(body.trigger ?? '');
    const errors: FieldErrors = {};
    if (!name || name.length > 80) errors.name = 'Give the automation a name of up to 80 characters.';
    if (!TRIGGERS.some((t) => t.key === trigger)) errors.trigger = 'Choose what starts it.';
    if (Object.keys(errors).length > 0) return renderList(res, { status: 400, openDialog: 'new-automation', errors, values: body });
    const created = await attempt(() => createAutomation(name, trigger as TriggerKey, req.currentUser?.id ?? null));
    if (!created.ok) return renderList(res, { status: 400, openDialog: 'new-automation', errors: created.errors, values: body });
    res.redirect(BASE + '/' + created.value.id);
  }),
);

automationAdminRouter.post(
  '/network',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const allow = (req.body as Record<string, unknown>)?.allowPrivateNetwork === 'on';
    await updateSettings({ httpRequests: { allowPrivateNetwork: allow } }, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.http_requests.' + (allow ? 'private_allowed' : 'private_refused'), targetType: 'settings' });
    flash(req, 'success', allow ? 'HTTP steps may now call addresses on the private network.' : 'HTTP steps may call public https addresses only.', 'network');
    res.redirect(BASE + '#network');
  }),
);

// ---------------------------------------------------------------------------
// One automation
// ---------------------------------------------------------------------------

async function load(req: Request) {
  const row = await findAutomation(String(req.params.id));
  if (!row) throw notFound('That automation no longer exists.');
  return row;
}

automationAdminRouter.get(
  '/:id',
  // The drag-and-drop canvas (public/js/automation-canvas.js). Everything it
  // does is a form post the page also offers without it. See allowOwnScripts.
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const outputs = outputNames(row.graph);
    const [notifications, groups, staff, userGroups, connections, runs, apiKeys, keyIssue] = await Promise.all([
      listNotifications(),
      listActiveGroups(),
      listAssignableStaff(),
      listUserGroups(),
      listConnections(),
      recentRuns(row.id),
      listApiKeys(),
      keyProblem(row.graph),
    ]);
    // Every id a step can name, to its name: connections, templates, groups.
    const activeTemplates = await listActiveTemplates();
    const connectionNames = new Map<string, string>([
      ...connections.map((c) => [c.id, c.name] as [string, string]),
      ...activeTemplates.map((t) => [t.id, t.name] as [string, string]),
      ...groups.map((g) => [g.id, g.name] as [string, string]),
      ...userGroups.map((g) => [g.id, g.name] as [string, string]),
    ]);
    // The trigger first, then the order the steps were added.
    const nodes = [...row.graph.nodes].sort((a, b) => (a.type === 'trigger' ? -1 : b.type === 'trigger' ? 1 : 0));
    res.render(
      'admin/settings/automation-edit',
      settingsView('advanced', {
        sectionTitle: row.name,
        automation: row,
        graphIssues: [...graphProblems(row.graph), ...(keyIssue && !graphProblems(row.graph).some((p) => p.startsWith('Trigger:')) ? [keyIssue] : [])],
        apiKeys,
        // Where another system sends the request, when that is the trigger.
        hookUrl: isHttpTriggered(row.graph) ? appConfig.publicOrigin + '/hooks/automations/' + row.id : '',
        nodes: nodes.map((n) => ({
          ...n,
          spec: nodeSpec(n.type),
          problem: missingSettings(n, outputs),
          // Each output's targets, in wiring order: an output may lead to several.
          wires: row.graph.edges
            .filter((e) => e.from === n.id)
            .reduce<Record<string, string[]>>((acc, e) => ({ ...acc, [e.pin]: [...(acc[e.pin] ?? []), e.to] }), {}),
          title: nodeSpec(n.type)?.label + (summary(n, connectionNames) ? ' - ' + summary(n, connectionNames).slice(0, 40) : ''),
        })),
        picture: diagram(row.graph, outputs, connectionNames),
        nodeTypes: NODE_TYPES.filter((t) => t.kind !== 'trigger'),
        triggers: TRIGGERS,
        slaClocks: SLA_CLOCKS,
        slaEnabled: settings().sla.enabled,
        conditionFields: CONDITION_FIELDS,
        operators: OPERATORS,
        statuses: TICKET_STATUSES.map((s) => ({ key: s, label: STATUS_LABELS[s] })),
        priorities: TICKET_PRIORITIES.map((p) => ({ key: p, label: PRIORITY_LABELS[p] })),
        ticketTypes: TICKET_TYPES.map((t) => ({ key: t, label: TYPE_LABELS[t] })),
        notifications,
        templates: activeTemplates,
        groups,
        staff,
        userGroups,
        connections,
        methods: HTTP_METHODS,
        bodyTypes: BODY_TYPES,
        maxTimeout: MAX_TIMEOUT_S,
        ticketVariables: TICKET_VARIABLES,
        outputs: Array.from(outputs),
        // The answer to "Save and test", shown once in that step's popup.
        httpTest: (() => {
          const t = req.session.httpTest;
          delete req.session.httpTest;
          return t ?? null;
        })(),
        runs: runs.map((r) => ({ ...r, stepList: (() => { try { return JSON.parse(r.steps) as string[]; } catch { return []; } })() })),
      }),
    );
  }),
);

automationAdminRouter.post(
  '/:id/rename',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const name = String((req.body as Record<string, unknown>)?.name ?? '').trim();
    if (!name || name.length > 80) {
      flash(req, 'error', 'Give the automation a name of up to 80 characters.');
    } else {
      const done = await attempt(() => renameAutomation(row.id, name, req.currentUser?.id ?? null));
      flash(req, done.ok ? 'success' : 'error', done.ok ? 'Renamed.' : Object.values(done.errors)[0] ?? 'Not renamed.');
    }
    res.redirect(BASE + '/' + row.id);
  }),
);

automationAdminRouter.post(
  '/:id/enabled',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const enabled = (req.body as Record<string, unknown>)?.enabled === 'on';
    const done = await attempt(() => setAutomationEnabled(row.id, enabled, req.currentUser?.id ?? null));
    if (done.ok) flash(req, 'success', enabled ? 'The automation is on.' : 'The automation is off.');
    else flash(req, 'error', 'Not switched on: ' + (Object.values(done.errors)[0] ?? ''));
    res.redirect(BASE + '/' + row.id);
  }),
);

automationAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    await deleteAutomation(row.id, req.currentUser?.id ?? null);
    flash(req, 'success', 'Automation "' + row.name + '" deleted.');
    res.redirect(BASE);
  }),
);

automationAdminRouter.post(
  '/:id/nodes',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = String(body.type ?? '') as NodeType;
    const [afterId] = String(body.after ?? '').split(':');
    // A right-click on an empty spot of the canvas says where; otherwise
    // beside what it follows.
    const x = Number(body.x);
    const y = Number(body.y);
    const spot =
      !afterId && body.x !== undefined && Number.isFinite(x) && Number.isFinite(y)
        ? { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
        : freeSpot(row.graph, afterId ?? '');
    if (!afterId && body.x !== undefined) {
      // Fix the others where they are drawn, as the first drag does, so the
      // new box lands where it was asked for rather than being re-laid out.
      const now = positions(row.graph);
      if (!now.stored) await setPositions(row.id, Object.fromEntries(now.at), req.currentUser?.id ?? null);
    }
    const placed = await attempt(() => addNode(row.id, type, spot.x, spot.y, req.currentUser?.id ?? null));
    if (!placed.ok) {
      flash(req, 'error', Object.values(placed.errors)[0] ?? 'Not added.');
      res.redirect(BASE + '/' + row.id + '#add-step');
      return;
    }
    // "After": wire the new step in where it was asked for.
    const [from, pin] = String(body.after ?? '').split(':');
    if (from && pin) await attempt(() => connect(row.id, from, pin as Pin, placed.value, req.currentUser?.id ?? null));
    flash(req, 'success', (nodeSpec(type)?.label ?? 'Action') + ' added. Fill in its settings.', 'node-' + placed.value);
    // Straight into its settings: the fragment opens its popup.
    res.redirect(BASE + '/' + row.id + '#edit-' + placed.value);
  }),
);

automationAdminRouter.post(
  '/:id/nodes/:nodeId',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const nodeId = String(req.params.nodeId);
    const node = row.graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw notFound('That step no longer exists.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config: Record<string, string> = {};
    for (const key of FIELDS[node.type] ?? []) {
      const value = body[key];
      if (typeof value === 'string' && value.trim() !== '') config[key] = value.replace(/\r\n/g, '\n');
    }
    // An If's value comes from the control for its field (value_<field>, or
    // value_text for a field with no fixed list). A plain "value" still
    // counts, for a form drawn before this.
    if (node.type === 'if') {
      const field = typeof body.field === 'string' ? body.field : '';
      const listed = ['priority', 'status', 'type', 'group', 'requester_group', 'template'].includes(field);
      const picked = body[listed ? 'value_' + field : 'value_text'];
      if (typeof picked === 'string' && picked.trim() !== '') config.value = picked.trim();
      else if (typeof body.value !== 'string' || body.value.trim() === '') delete config.value;
    }
    const actor = req.currentUser?.id ?? null;
    await configureNode(row.id, nodeId, config, actor);
    const problems: string[] = [];
    // Every output's targets, as ticked. An output may lead to several.
    for (const pin of (nodeSpec(node.type)?.pins ?? []) as readonly Pin[]) {
      const raw = body['pin_' + pin];
      const to = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' && raw ? [raw] : [];
      const done = await attempt(() => setTargets(row.id, nodeId, pin, to, actor));
      if (!done.ok) problems.push(Object.values(done.errors)[0] ?? '');
    }
    // "Save and test": send the request once and show the answer in the
    // popup, which the fragment re-opens.
    if (body.test === '1' && (node.type === 'http_request' || node.type === 'http_request_auth')) {
      const result = await testHttpStep(config, node.type === 'http_request_auth');
      req.session.httpTest = { nodeId, ...result };
      auditRequest(req, {
        action: 'automation.http_tested',
        outcome: result.ok ? 'success' : 'failure',
        targetType: 'automation',
        targetId: row.id,
        detail: { step: nodeId, status: result.status },
      });
      res.redirect(BASE + '/' + row.id + '#edit-' + nodeId);
      return;
    }
    flash(req, problems.length ? 'error' : 'success', problems.length ? problems.join(' ') : 'Saved.', 'node-' + nodeId);
    res.redirect(BASE + '/' + row.id + '#step-' + nodeId);
  }),
);

/** Saves where a box was dragged to. The first drag fixes every other box where it was drawn. */
automationAdminRouter.post(
  '/:id/nodes/:nodeId/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const nodeId = String(req.params.nodeId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const x = Number(body.x);
    const y = Number(body.y);
    if (!row.graph.nodes.some((n) => n.id === nodeId) || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw notFound('That step no longer exists.');
    }
    const now = positions(row.graph);
    if (!now.stored) {
      await setPositions(row.id, Object.fromEntries(now.at), req.currentUser?.id ?? null);
    }
    await moveNode(row.id, nodeId, x, y, req.currentUser?.id ?? null);
    res.redirect(BASE + '/' + row.id + '#diagram');
  }),
);

/** A wire drawn on the canvas: one output of one step to another step. */
automationAdminRouter.post(
  '/:id/nodes/:nodeId/connect',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pin = String(body.pin ?? '') as Pin;
    const done = await attempt(() => connect(row.id, String(req.params.nodeId), pin, String(body.to ?? ''), req.currentUser?.id ?? null));
    if (!done.ok) flash(req, 'error', Object.values(done.errors)[0] ?? 'Not connected.');
    res.redirect(BASE + '/' + row.id + '#diagram');
  }),
);

/** One wire removed, from the canvas's menu on a wire. */
automationAdminRouter.post(
  '/:id/disconnect',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pin = String(body.pin ?? 'next') as Pin;
    const done = await attempt(() =>
      disconnect(row.id, String(body.from ?? ''), pin, String(body.to ?? ''), req.currentUser?.id ?? null),
    );
    if (!done.ok) flash(req, 'error', Object.values(done.errors)[0] ?? 'Not disconnected.');
    res.redirect(BASE + '/' + row.id + '#diagram');
  }),
);

/** Lays every box out in columns again. */
automationAdminRouter.post(
  '/:id/arrange',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    await setPositions(row.id, Object.fromEntries(autoPositions(row.graph).at), req.currentUser?.id ?? null);
    res.redirect(BASE + '/' + row.id + '#diagram');
  }),
);

automationAdminRouter.post(
  '/:id/nodes/:nodeId/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const row = await load(req);
    const done = await attempt(() => deleteNode(row.id, String(req.params.nodeId), req.currentUser?.id ?? null));
    flash(req, done.ok ? 'success' : 'error', done.ok ? 'Step removed.' : Object.values(done.errors)[0] ?? 'Not removed.');
    res.redirect(BASE + '/' + row.id + '#steps');
  }),
);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** Automations with a step that signs in through this connection. */
async function usedBy(connectionId: string): Promise<string[]> {
  return (await listAutomations())
    .filter((a) => a.graph.nodes.some((n) => n.config.connectionId === connectionId))
    .map((a) => a.name);
}

async function renderConnections(res: Response, extra: { status?: number; openDialog?: string | null; errors?: FieldErrors; values?: Record<string, unknown> } = {}) {
  if (extra.status) res.status(extra.status);
  const connections = await listConnections();
  // "Sign in" posts here and is redirected to the provider: the page's
  // form-action must allow that redirect, as on the sign-in page.
  allowFormActionTo(
    res,
    connections.filter((c) => c.auth_type === 'oauth2_user').flatMap((c) => {
      try {
        return [new URL(c.authorize_url).origin];
      } catch {
        return [];
      }
    }),
  );
  res.render(
    'admin/settings/connections',
    settingsView('advanced', {
      connections: await Promise.all(connections.map(async (c) => ({ ...c, usedBy: await usedBy(c.id), typeLabel: authTypeLabel(c.auth_type) }))),
      authTypes: AUTH_TYPES,
      redirectUri: connectionRedirectUri(),
      openDialog: extra.openDialog ?? null,
      errors: extra.errors ?? {},
      values: extra.values ?? {},
    }),
  );
}

function readConnection(body: Record<string, unknown>): ConnectionInput {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  // Each type has fields of its own name, because the panels of the other
  // types are hidden, not absent, and would post their values too.
  const authType = AUTH_TYPES.find((t) => t.key === s('authType'))?.key ?? 'oauth2';
  const user = authType === 'oauth2_user';
  return {
    name: s('name').trim(),
    authType,
    headerName: s('headerName').trim(),
    valuePrefix: s('valuePrefix'),
    tokenUrl: (user ? s('userTokenUrl') : s('tokenUrl')).trim(),
    clientId: authType === 'basic' ? s('username').trim() : (user ? s('userClientId') : s('clientId')).trim(),
    clientSecret: authType === 'api_key' ? s('apiKey') : authType === 'basic' ? s('password') : user ? s('userClientSecret') : s('clientSecret'),
    scope: (user ? s('userScope') : s('scope')).trim(),
    audience: user ? '' : s('audience').trim(),
    clientAuth: (user ? s('userClientAuth') : s('clientAuth')) === 'basic' ? 'basic' : 'body',
    authorizeUrl: s('authorizeUrl').trim(),
    clientCert: s('clientCert').replace(/\r\n/g, '\n'),
    clientKey: s('clientKey').replace(/\r\n/g, '\n'),
    keyPassphrase: s('keyPassphrase'),
  };
}

connectionsAdminRouter.get('/', asyncHandler(async (_req, res) => renderConnections(res)));

/**
 * OAuth as a person: the provider sends the administrator back here with a
 * code. The state must be the one this session started with, within ten
 * minutes; otherwise nothing is exchanged.
 */
connectionsAdminRouter.get(
  '/oauth/callback',
  asyncHandler(async (req, res) => {
    const pending = req.session.connectionAuth;
    delete req.session.connectionAuth;
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!pending || !state || state !== pending.state || Date.now() - pending.at > 10 * 60_000) {
      flash(req, 'error', 'That sign-in was not started here, or took too long. Press Sign in again.');
      res.redirect(CONNECTIONS);
      return;
    }
    if (!code) {
      // The provider's error code only; its description can echo input.
      const why = typeof req.query.error === 'string' ? ' (' + req.query.error.replace(/[^\w.-]/g, '').slice(0, 60) + ')' : '';
      flash(req, 'error', 'The provider did not sign in' + why + '.', 'connection-' + pending.id);
      res.redirect(CONNECTIONS + '#row-' + pending.id);
      return;
    }
    const who = req.currentUser?.display_name ?? 'an administrator';
    const done = await attempt(async () => {
      try {
        await finishUserSignIn(pending.id, code, pending.verifier, who, req.currentUser?.id ?? null);
      } catch (err) {
        // A failed exchange (network, the provider saying no) is said beside the row, not as an error page.
        if (!(err instanceof HttpError)) throw conflict(err instanceof Error ? err.message : String(err), 'connection_failed');
        throw err;
      }
    });
    flash(
      req,
      done.ok ? 'success' : 'error',
      done.ok ? 'Signed in. Steps through this connection now act as ' + who + '.' : 'Could not sign in: ' + (Object.values(done.errors)[0] ?? 'the provider refused.'),
      'connection-' + pending.id,
    );
    res.redirect(CONNECTIONS + '#row-' + pending.id);
  }),
);

connectionsAdminRouter.post(
  '/:id/authorize',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const start = await startUserSignIn(id);
    req.session.connectionAuth = { id, state: start.state, verifier: start.verifier, at: Date.now() };
    auditRequest(req, { action: 'automation_connection.sign_in_started', targetType: 'automation_connection', targetId: id });
    res.redirect(start.url);
  }),
);

connectionsAdminRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = readConnection(body);
    // Never echo a secret back into the form.
    const values = { ...body, clientSecret: '', apiKey: '', password: '', userClientSecret: '', clientKey: '', keyPassphrase: '' };
    const errors = connectionProblems(input, false);
    if (Object.keys(errors).length > 0) return renderConnections(res, { status: 400, openDialog: 'new-connection', errors, values });
    const done = await attempt(() => createConnection(input, req.currentUser?.id ?? null));
    if (!done.ok) return renderConnections(res, { status: 400, openDialog: 'new-connection', errors: done.errors, values });
    flash(req, 'success', 'Connection "' + input.name + '" added. Use Test to check it signs in.');
    res.redirect(CONNECTIONS);
  }),
);

connectionsAdminRouter.post(
  '/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input = readConnection(body);
    const values = { ...body, clientSecret: '', apiKey: '', password: '', userClientSecret: '', clientKey: '', keyPassphrase: '' };
    const errors = connectionProblems(input, true);
    if (Object.keys(errors).length > 0) return renderConnections(res, { status: 400, openDialog: 'connection-' + id, errors, values });
    const done = await attempt(() => updateConnection(id, input, req.currentUser?.id ?? null));
    if (!done.ok) return renderConnections(res, { status: 400, openDialog: 'connection-' + id, errors: done.errors, values });
    flash(req, 'success', 'Connection saved.');
    res.redirect(CONNECTIONS);
  }),
);

connectionsAdminRouter.post(
  '/:id/test',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const done = await attempt(() => testConnection(id, req.currentUser?.id ?? null));
    flash(req, done.ok ? 'success' : 'error', done.ok ? done.value : Object.values(done.errors)[0] ?? 'Could not sign in.', 'connection-' + id);
    res.redirect(CONNECTIONS + '#row-' + id);
  }),
);

connectionsAdminRouter.post(
  '/:id/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const done = await attempt(async () => deleteConnection(id, await usedBy(id), req.currentUser?.id ?? null));
    flash(req, done.ok ? 'success' : 'error', done.ok ? 'Connection removed.' : Object.values(done.errors)[0] ?? 'Not removed.', done.ok ? undefined : 'connection-' + id);
    res.redirect(CONNECTIONS + (done.ok ? '' : '#row-' + id));
  }),
);
