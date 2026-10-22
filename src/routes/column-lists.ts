import type { RequestHandler } from 'express';
import { formatDateTime } from '../lib/format.js';
import { listView, type Cells } from '../lib/column-filters.js';

/**
 * Excel-like headers for the Settings lists that are short and drawn whole
 * (lib/column-filters.ts), applied where the page is rendered rather than
 * in each route: several of these pages are rendered from more than one
 * place (a refused form re-renders the list), and every one of them should
 * keep its filters the same way.
 *
 * Each entry names the view, the array of rows in its locals, the page's
 * address, and how each column's cell reads - from the row and the page's
 * own locals (a template's name, who uses a key). The view draws its
 * headers with partials/col-head.ejs from `columnMenus` and `listState`.
 *
 * A list whose order is itself a setting (mail rules, asset columns, the
 * catalogue) is not here: sorting it would hide the order that matters.
 */

type Locals = Record<string, unknown>;
type Row = Record<string, unknown>;
interface ColumnList {
  rows: string;
  path: string;
  cells: (locals: Locals) => Cells<Row>;
  sortCells?: (locals: Locals) => Cells<Row>;
  labelOf?: (key: string, value: string) => string;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const list = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);

export const COLUMN_LISTS: Record<string, ColumnList> = {
  'admin/settings/api-keys': {
    rows: 'keys',
    path: '/admin/settings/advanced/api-keys',
    cells: (l) => ({
      name: (r) => str(r.name),
      templates: (r) =>
        list(r.template_ids).length === 0 ? 'Any' : list(r.template_ids).map((t) => str((l.templateNames as Locals)?.[t]) || 'a removed template').join(', '),
      starts: (r) => list((l.usedBy as Locals)?.[str(r.id)]).join(', '),
      lastUsed: (r) => (r.last_used_at ? 'Used' : 'Never'),
    }),
    sortCells: () => ({ lastUsed: (r) => str(r.last_used_at) }),
  },
  'admin/settings/connections': {
    rows: 'connections',
    path: '/admin/settings/advanced/connections',
    cells: () => ({
      name: (r) => str(r.name),
      type: (r) => str(r.typeLabel),
      usedBy: (r) => list(r.usedBy).join(', '),
    }),
  },
  'admin/settings/custom-fields': {
    rows: 'fields',
    path: '/admin/settings/templates/custom-fields',
    cells: (l) => ({
      label: (r) => str(r.label),
      type: (r) => str((l.typeLabels as Locals)?.[str(r.field_type)]) || str(r.field_type),
      usedBy: (r) => list(r.usedBy).join(', '),
    }),
  },
  'admin/settings/automation-runs': {
    rows: 'runs',
    path: '/admin/settings/advanced/automation/runs',
    cells: () => ({
      when: (r) => formatDateTime(str(r.ranAt)),
      automation: (r) => str(r.automationName),
      outcome: (r) => (r.outcome === 'success' ? 'Finished' : r.outcome === 'stopped' ? 'Stopped' : 'Failed'),
    }),
    sortCells: () => ({ when: (r) => str(r.ranAt) }),
  },
  'admin/settings/mail': {
    rows: 'mailboxes',
    path: '/admin/settings/mail',
    cells: (l) => ({
      address: (r) => str(r.address),
      kind: (r) => str((l.kindLabels as Locals)?.[str(r.kind)]) || str(r.kind),
      handles: (r) => {
        const group = ((l.groups as Row[]) ?? []).find((g) => g.id === r.group_id);
        return group ? str(group.name) : 'No particular group';
      },
      reads: (r) => (r.receive_enabled ? 'Yes' : 'Sends only'),
      status: (r) => (!r.is_active ? 'Off' : r.last_error ? 'Problem' : 'Active'),
    }),
    sortCells: () => ({ lastRead: (r) => str(r.last_polled_at) }),
  },
};

/** Wraps res.render so the views above get their rows filtered and sorted, and their menus. */
export function columnLists(): RequestHandler {
  return (req, res, next) => {
    const render = res.render.bind(res);
    res.render = ((view: string, options?: unknown, callback?: unknown) => {
      const spec = COLUMN_LISTS[view];
      if (spec && options && typeof options === 'object') {
        const locals = options as Locals;
        const rows = locals[spec.rows];
        if (Array.isArray(rows)) {
          // A refused form re-renders the list with no filters; a GET reads them.
          const query = req.method === 'GET' ? (req.query as Locals) : {};
          const merged = { ...res.locals, ...locals };
          const done = listView(query, rows as Row[], spec.cells(merged), {
            ...(spec.sortCells ? { sortCells: spec.sortCells(merged) } : {}),
            ...(spec.labelOf ? { labelOf: spec.labelOf } : {}),
          });
          locals[spec.rows] = done.rows;
          locals.columnMenus = done.columnMenus;
          locals.listState = done.listState;
          locals.columnPath = spec.path;
        }
      }
      return (render as (v: string, o?: unknown, c?: unknown) => void)(view, options, callback);
    }) as typeof res.render;
    next();
  };
}
