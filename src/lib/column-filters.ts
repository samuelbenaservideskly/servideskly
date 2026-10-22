/**
 * Excel-like column filters (asked for 21 Oct 2026): every column header of
 * a table can sort, and filter by the column's own values with tick boxes,
 * the way AutoFilter does.
 *
 * - **In the address**: a filter is `cf_<column>=<value>`, once per ticked
 *   value, so a filtered table can be pinned, bookmarked or sent. Several
 *   values in one column mean any of them; several columns narrow together.
 * - **No script**: the menu is a `<details>` (partials/col-head.ejs) holding a
 *   GET form that carries every other filter as hidden inputs. A long list
 *   of values gets select-search.js's search box, as any list of tick boxes.
 * - **Values come from the rows the other filters leave**, as in Excel: the
 *   column's own filter is left out when its values are counted, so ticking
 *   a second value in the same column is always possible.
 * - **The SQL is never the column name from the address.** Each table names
 *   its filterable columns and the expression for each; anything else is
 *   ignored. The values themselves are bound parameters.
 */

export const CF_PREFIX = 'cf_';

/** At most this many values are listed in a menu, the most frequent first. */
export const MAX_VALUES = 200;

/** A blank cell (unassigned, no value) as a value that can be ticked. */
export const BLANK = '';

export type ColumnFilters = Record<string, string[]>;

/** The ticked values per column, for the columns a table allows. */
export function readColumnFilters(query: Record<string, unknown>, allowed: readonly string[]): ColumnFilters {
  const out: ColumnFilters = {};
  for (const key of allowed) {
    const raw = query[CF_PREFIX + key];
    const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.slice(0, 300));
    const unique = [...new Set(list)].slice(0, MAX_VALUES);
    if (unique.length) out[key] = unique;
  }
  return out;
}

/** The same filters, without one column: for counting that column's values. */
export function withoutColumn(filters: ColumnFilters, key: string): ColumnFilters {
  const { [key]: _gone, ...rest } = filters;
  return rest;
}

/**
 * The WHERE clause for one column's ticked values. A blank value matches an
 * empty or missing cell, so "Unassigned" can be ticked beside names.
 */
export function columnClause(expr: string, values: readonly string[]): { sql: string; params: string[] } {
  const named = values.filter((v) => v !== BLANK);
  const parts: string[] = [];
  if (named.length) parts.push(expr + ' IN (' + named.map(() => '?').join(', ') + ')');
  if (values.includes(BLANK)) parts.push('(' + expr + " IS NULL OR " + expr + " = '')");
  return { sql: '(' + parts.join(' OR ') + ')', params: named };
}

/** Every column's clause, ANDed, for the columns a table defines. */
export function columnClauses(filters: ColumnFilters, exprs: Record<string, string>): { where: string[]; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  for (const [key, values] of Object.entries(filters)) {
    const expr = exprs[key];
    if (!expr || values.length === 0) continue;
    const clause = columnClause(expr, values);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  return { where, params };
}

/** The address parameters for a set of filters, for links that keep them. */
export function filterParams(filters: ColumnFilters): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(filters)) if (values.length) out[CF_PREFIX + key] = values;
  return out;
}

export interface ColumnValue {
  value: string;
  label: string;
  count: number;
}

/** Labels in order for a menu: alphabetical, blanks last, the ticked ones always present. */
export function menuValues(rows: readonly ColumnValue[], selected: readonly string[], labelOf: (value: string) => string): ColumnValue[] {
  const byValue = new Map(rows.map((r) => [r.value, r]));
  for (const value of selected) if (!byValue.has(value)) byValue.set(value, { value, label: labelOf(value), count: 0 });
  return [...byValue.values()].sort((a, b) => {
    if (a.value === BLANK) return 1;
    if (b.value === BLANK) return -1;
    return a.label.localeCompare(b.label);
  });
}

// ---------------------------------------------------------------------------
// In memory: for a short list a page already holds whole (most of Settings)
// ---------------------------------------------------------------------------

/** How a row's cell reads, per column: the value filtered on and sorted by. */
export type Cells<T> = Record<string, (row: T) => string>;

/** The rows whose cells are among the ticked values, column by column. */
export function filterRows<T>(rows: readonly T[], filters: ColumnFilters, cells: Cells<T>): T[] {
  return rows.filter((row) =>
    Object.entries(filters).every(([key, values]) => {
      const cell = cells[key];
      return !cell || values.length === 0 || values.includes(cell(row) ?? BLANK);
    }),
  );
}

/** Rows sorted by one column, as text, numbers compared as numbers. Stable. */
export function sortRows<T>(rows: readonly T[], sort: string | undefined, dir: 'asc' | 'desc' | undefined, cells: Cells<T>): T[] {
  const cell = sort ? cells[sort] : undefined;
  if (!cell) return [...rows];
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: cell(row) ?? '' }))
    .sort((a, b) => {
      // Blanks last either way, as in the SQL lists.
      if (a.v === '' && b.v !== '') return 1;
      if (b.v === '' && a.v !== '') return -1;
      return sign * a.v.localeCompare(b.v, undefined, { numeric: true, sensitivity: 'base' }) || a.i - b.i;
    })
    .map((x) => x.row);
}

/** Each column's menu, counted over the rows every other filter leaves. */
export function rowMenus<T>(
  rows: readonly T[],
  filters: ColumnFilters,
  cells: Cells<T>,
  labelOf: (key: string, value: string) => string = (_k, v) => v,
): Record<string, { values: ColumnValue[]; selected: string[] }> {
  const menus: Record<string, { values: ColumnValue[]; selected: string[] }> = {};
  for (const [key, cell] of Object.entries(cells)) {
    const counts = new Map<string, number>();
    for (const row of filterRows(rows, withoutColumn(filters, key), cells)) {
      const v = cell(row) ?? BLANK;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const values = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VALUES)
      .map(([value, count]) => ({ value, label: labelOf(key, value), count }));
    const selected = filters[key] ?? [];
    menus[key] = { values: menuValues(values, selected, (v) => labelOf(key, v)), selected };
  }
  return menus;
}
