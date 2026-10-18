import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { execute, query, queryOne, transaction } from '../db/index.js';
import {
  addQuestion,
  hasOptions,
  isCustomFieldType,
  normaliseFields,
  placeField,
  type CustomFieldType,
  type TemplateField,
  type TemplateRow,
} from './templates.js';

/**
 * The custom-field library: Settings - Tickets - Custom fields.
 *
 * A field written once - its label, type and choices - and placed on as many
 * templates as ask it. Placing one **copies** it onto the template, marked
 * with `libraryId`, so the form, validation and answers work exactly as for
 * a field written on the template itself. Two things keep the copies honest:
 *
 * - **Editing a library field rewrites every copy's label, type and
 *   choices** in the same transaction. What a template made of it - mandatory
 *   or not, its width, its placeholder, whether it is on the form - stays.
 * - **Deleting one detaches the copies** rather than taking them off forms:
 *   a template that asks it keeps asking, as a field of its own.
 */

export interface LibraryFieldRow {
  id: string;
  label: string;
  field_type: CustomFieldType;
  choices: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LibraryFieldInput {
  label: string;
  fieldType: CustomFieldType;
  options: string[];
}

function normalise(row: LibraryFieldRow | undefined): LibraryFieldRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    field_type: isCustomFieldType(row.field_type) ? row.field_type : 'text',
    choices: Array.isArray(row.choices) ? row.choices : [],
  };
}

export async function listLibraryFields(): Promise<LibraryFieldRow[]> {
  return (await query<LibraryFieldRow>('SELECT * FROM custom_fields ORDER BY lower(label)')).map((r) => normalise(r)!);
}

export async function findLibraryField(id: string): Promise<LibraryFieldRow | undefined> {
  return normalise(await queryOne<LibraryFieldRow>('SELECT * FROM custom_fields WHERE id = ?', [id]));
}

/** Why this cannot be saved, by field. */
export function libraryFieldProblems(input: LibraryFieldInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.label.trim() || input.label.length > 120) errors.label = 'Give it a label of up to 120 characters.';
  if (hasOptions(input.fieldType) && input.options.length < 2) errors.options = 'A choice needs at least two options, one per line.';
  return errors;
}

async function assertLabel(label: string, exceptId: string | null): Promise<void> {
  const clash = await queryOne<{ id: string }>('SELECT id FROM custom_fields WHERE lower(label) = lower(?)', [label]);
  if (clash && clash.id !== exceptId) throw conflict('The library already has a field with that label.', 'custom_field_label_taken');
}

export async function createLibraryField(input: LibraryFieldInput, actorId: string | null): Promise<LibraryFieldRow> {
  const label = input.label.trim().slice(0, 120);
  await assertLabel(label, null);
  const id = newId();
  const now = nowIso();
  await execute(
    'INSERT INTO custom_fields (id, label, field_type, choices, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, label, input.fieldType, JSON.stringify(hasOptions(input.fieldType) ? input.options : []), actorId, now, now],
  );
  audit({ action: 'custom_field.created', actorId, targetType: 'custom_field', targetId: id, detail: { label, type: input.fieldType } });
  return (await findLibraryField(id))!;
}

interface TemplateFieldsRow {
  id: string;
  name: string;
  fields: unknown;
}

/** Every template carrying a copy of this library field. */
async function templatesUsing(id: string): Promise<TemplateFieldsRow[]> {
  const rows = await query<TemplateFieldsRow>('SELECT id, name, fields FROM ticket_templates');
  return rows.filter((t) => normaliseFields(t.fields).some((f) => f.libraryId === id));
}

/** The templates that ask this field, by name - shown on the list. */
export async function libraryUsage(): Promise<Map<string, string[]>> {
  const rows = await query<TemplateFieldsRow>('SELECT id, name, fields FROM ticket_templates ORDER BY lower(name)');
  const usage = new Map<string, string[]>();
  for (const t of rows) {
    for (const f of normaliseFields(t.fields)) {
      if (f.libraryId) usage.set(f.libraryId, [...(usage.get(f.libraryId) ?? []), t.name]);
    }
  }
  return usage;
}

export async function updateLibraryField(id: string, input: LibraryFieldInput, actorId: string | null): Promise<number> {
  const row = await findLibraryField(id);
  if (!row) throw notFound('That field is no longer in the library.');
  const label = input.label.trim().slice(0, 120);
  await assertLabel(label, id);
  const options = hasOptions(input.fieldType) ? input.options : [];
  const using = await templatesUsing(id);
  await transaction(async (client) => {
    await client.query('UPDATE custom_fields SET label = ?, field_type = ?, choices = ?, updated_at = ? WHERE id = ?', [
      label,
      input.fieldType,
      JSON.stringify(options),
      nowIso(),
      id,
    ]);
    for (const t of using) {
      const fields = normaliseFields(t.fields).map((f): TemplateField => {
        if (f.libraryId !== id) return f;
        const { fieldType: _type, options: _options, ...rest } = f;
        return {
          ...rest,
          label,
          ...(input.fieldType !== 'text' ? { fieldType: input.fieldType } : {}),
          ...(options.length > 0 ? { options } : {}),
        };
      });
      await client.query('UPDATE ticket_templates SET fields = ?, updated_at = ? WHERE id = ?', [JSON.stringify(normaliseFields(fields)), nowIso(), t.id]);
    }
  });
  audit({ action: 'custom_field.updated', actorId, targetType: 'custom_field', targetId: id, detail: { label, templates: using.length } });
  return using.length;
}

/** Deletes it from the library; templates keep their copies as fields of their own. */
export async function deleteLibraryField(id: string, actorId: string | null): Promise<void> {
  const row = await findLibraryField(id);
  if (!row) throw notFound('That field is no longer in the library.');
  const using = await templatesUsing(id);
  await transaction(async (client) => {
    for (const t of using) {
      const fields = normaliseFields(t.fields).map((f) => {
        if (f.libraryId !== id) return f;
        const { libraryId: _gone, ...rest } = f;
        return rest;
      });
      await client.query('UPDATE ticket_templates SET fields = ?, updated_at = ? WHERE id = ?', [JSON.stringify(normaliseFields(fields)), nowIso(), t.id]);
    }
    await client.query('DELETE FROM custom_fields WHERE id = ?', [id]);
  });
  audit({ action: 'custom_field.deleted', actorId, targetType: 'custom_field', targetId: id, detail: { label: row.label } });
}

/**
 * Puts a library field on a template's form: a copy, or - when the template
 * set its copy aside earlier - that copy back, with whatever it was given.
 */
export async function placeLibraryField(template: TemplateRow, libraryId: string, actorId: string | null): Promise<TemplateRow> {
  const field = await findLibraryField(libraryId);
  if (!field) throw notFound('That field is no longer in the library.');
  const existing = normaliseFields(template.fields).find((f) => f.libraryId === libraryId);
  if (existing?.placed) throw conflict('"' + field.label + '" is already on this form.', 'custom_field_on_form');
  if (existing) return placeField(template, existing.key, null, actorId);
  return addQuestion(template, field.label, actorId, {
    fieldType: field.field_type,
    options: field.choices,
    libraryId,
  });
}
