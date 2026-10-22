import { csvField, parseCsv } from '../lib/csv.js';
import { query } from '../db/index.js';
import { sqlJsonText } from '../db/index.js';
import { createAsset, enabledColumns, listStatuses, valueProblems, type AssetColumn, type AssetInput } from './assets.js';
import { findUserByEmail } from './users.js';

/**
 * Importing assets from a CSV (step 2 of assets, 21 Oct 2026). The rules of
 * the users import (services/local-import.ts), because they have worked:
 *
 * - **The template is the columns switched on now**, plus Status, so what
 *   is downloaded is what is read back. A header names a column by its label
 *   or its variable (`SerialNumber`), in any case; an unknown header is
 *   refused rather than silently dropped.
 * - **The sheet is checked whole, and one bad row imports nothing**, each
 *   problem with its row number - half an import is worse than none.
 * - **A serial number already here is skipped and listed**, as is a second
 *   row with the same one, so uploading the same sheet twice is harmless.
 */

export const MAX_ASSET_ROWS = 1000;
const STATUS = 'status';

/** The header a person column carries in the template. */
const personHeader = (c: AssetColumn) => c.label + ' (email)';

export async function assetTemplateCsv(): Promise<string> {
  const columns = await enabledColumns();
  const statuses = await listStatuses();
  const header = ['Status', ...columns.map((c) => (c.format === 'person' ? personHeader(c) : c.label))];
  const example = [
    statuses[0]?.name ?? '',
    ...columns.map((c) =>
      c.format === 'person' ? '' : c.key === 'Model' ? 'ThinkPad T14' : c.key === 'SerialNumber' ? 'PF-123456' : c.format === 'date' ? '2026-10-21' : '',
    ),
  ];
  // The byte-order mark makes Excel read the file as UTF-8.
  return '﻿' + [header, example].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export interface AssetImportPlan {
  problems: string[];
  create: AssetInput[];
  /** Rows skipped, said in words: "Row 4: serial number PF-1 is already here". */
  skipped: string[];
}

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function planAssetImport(text: string): Promise<AssetImportPlan> {
  const rows = parseCsv(text);
  const plan: AssetImportPlan = { problems: [], create: [], skipped: [] };
  if (rows.length < 2) {
    plan.problems.push('The sheet has no rows under its header. Fill in the template and upload it.');
    return plan;
  }
  if (rows.length - 1 > MAX_ASSET_ROWS) {
    plan.problems.push('At most ' + MAX_ASSET_ROWS + ' assets at a time. Split the sheet and upload it in parts.');
    return plan;
  }

  // Which column each header names.
  const columns = await enabledColumns();
  const byName = new Map<string, AssetColumn | typeof STATUS>();
  byName.set('status', STATUS);
  for (const c of columns) {
    byName.set(fold(c.label), c);
    byName.set(fold(c.key), c);
    if (c.format === 'person') byName.set(fold(personHeader(c)), c);
  }
  const header = rows[0]!.map((h) => byName.get(fold(h)));
  rows[0]!.forEach((h, i) => {
    if (h.trim() && !header[i]) plan.problems.push('Unknown column "' + h.trim() + '". Download the template for the columns there are.');
  });
  if (plan.problems.length) return plan;

  const statuses = await listStatuses();
  // Serial numbers already here, folded, so case and spaces do not make a copy.
  const existing = new Set(
    (await query<{ s: string | null }>('SELECT ' + sqlJsonText('field_values', 'SerialNumber') + ' AS s FROM assets'))
      .map((r) => (r.s ? fold(r.s) : ''))
      .filter(Boolean),
  );
  const seen = new Set<string>();

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const at = 'Row ' + (r + 1) + ': ';
    const input: AssetInput = { statusId: statuses[0]?.id ?? null, assignee: '', values: {} };
    let ok = true;
    for (let i = 0; i < header.length; i += 1) {
      const target = header[i];
      const value = (row[i] ?? '').trim();
      if (!target || !value) continue;
      if (target === STATUS) {
        const status = statuses.find((s) => fold(s.name) === fold(value));
        if (!status) {
          plan.problems.push(at + 'no status called "' + value + '".');
          ok = false;
        } else input.statusId = status.id;
      } else if (target.format === 'person') {
        const person = await findUserByEmail(value);
        if (!person || person.status !== 'active') {
          plan.problems.push(at + 'nobody active has the address ' + value + '.');
          ok = false;
        } else input.assignee = person.email;
      } else {
        input.values[target.key] = value;
      }
    }
    for (const problem of Object.values(valueProblems(columns, input.values))) {
      plan.problems.push(at + problem);
      ok = false;
    }
    if (!ok) continue;
    const serial = fold(input.values.SerialNumber ?? '');
    if (serial && existing.has(serial)) {
      plan.skipped.push(at + 'serial number ' + input.values.SerialNumber + ' is already here.');
      continue;
    }
    if (serial && seen.has(serial)) {
      plan.skipped.push(at + 'serial number ' + input.values.SerialNumber + ' is earlier in the sheet.');
      continue;
    }
    if (serial) seen.add(serial);
    plan.create.push(input);
  }
  if (plan.problems.length) plan.create = [];
  return plan;
}

/** Creates what the plan says, one by one, each with its history and announcements. */
export async function runAssetImport(create: AssetInput[], actor: { id: string } | null): Promise<number> {
  for (const input of create) await createAsset(input, actor);
  return create.length;
}
