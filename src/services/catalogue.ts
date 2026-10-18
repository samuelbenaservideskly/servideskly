import { execute, query, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';

/**
 * The category catalogue: category → subcategory → item.
 *
 * One self-referencing table rather than three, so the whole tree is managed
 * on one page and a fourth level could be added without a schema change.
 *
 * **Nothing is seeded.** The classification an organisation uses is theirs to
 * decide; shipping an invented one would only mean deleting it first.
 *
 * A ticket is filed against whichever node was chosen, at whatever depth - * "Hardware" on its own is as valid as "Hardware › Not working › Mouse". That
 * matters because the tree is built up over time: it must be usable when only
 * the top level exists.
 */

export const LEVELS = [1, 2, 3] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<Level, string> = {
  1: 'Category',
  2: 'Subcategory',
  3: 'Item',
};

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  level: Level;
  name: string;
  description: string;
  is_active: boolean;
  sort_order: number;
  /** Team work filed here goes to. Inherited downwards - see routingGroupFor. */
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A node with its ancestry resolved, for display and for pickers. */
export interface CategoryNode extends CategoryRow {
  /** 'Hardware › Not working › Mouse' */
  path: string;
  /** Ancestors first, then this node. */
  trail: CategoryRow[];
  children: CategoryNode[];
  /** True when nothing is filed against it and it has no children. */
  removable?: boolean;
}

export const PATH_SEPARATOR = ' › ';

const ORDER = ' ORDER BY level, sort_order, lower(name)';

export function listAll(): Promise<CategoryRow[]> {
  return query<CategoryRow>('SELECT * FROM ticket_categories' + ORDER);
}

export function findCategory(id: string): Promise<CategoryRow | undefined> {
  return queryOne<CategoryRow>('SELECT * FROM ticket_categories WHERE id = ?', [id]);
}

/**
 * The whole tree, each node carrying its full path.
 *
 * Built in memory from one query rather than with a recursive CTE: the
 * catalogue is small by nature, and this keeps the SQL portable to the server
 * database this will eventually move to.
 */
export function buildTree(rows: readonly CategoryRow[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  for (const row of rows) {
    byId.set(row.id, { ...row, path: row.name, trail: [row], children: [] });
  }

  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Paths depend on ancestors, so walk the tree rather than the flat list.
  const walk = (node: CategoryNode, trail: CategoryRow[]): void => {
    node.trail = [...trail, node];
    node.path = node.trail.map((n) => n.name).join(PATH_SEPARATOR);
    node.children.sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
    );
    for (const child of node.children) walk(child, node.trail);
  };
  roots.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  for (const root of roots) walk(root, []);

  return roots;
}

/** Depth-first, so a list reads in the same order as the tree. */
export function flatten(nodes: readonly CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  const visit = (node: CategoryNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

export async function catalogueTree(): Promise<CategoryNode[]> {
  return buildTree(await listAll());
}

/**
 * Every node that may be chosen when filing a ticket.
 *
 * A node is offered only when it is active **and every ancestor is too**.
 * Walking down from the active roots rather than filtering once is what makes
 * that true at any depth: a single pass would keep an item whose immediate
 * parent is active but whose grandparent has been retired, and that item would
 * then surface as though it were a top-level category.
 */
export async function selectableCategories(): Promise<CategoryNode[]> {
  const active = (await listAll()).filter((row) => row.is_active);
  const childrenOf = new Map<string, CategoryRow[]>();
  for (const row of active) {
    const key = row.parent_id ?? '';
    const list = childrenOf.get(key) ?? [];
    list.push(row);
    childrenOf.set(key, list);
  }

  const reachable: CategoryRow[] = [];
  const descend = (parentKey: string): void => {
    for (const row of childrenOf.get(parentKey) ?? []) {
      reachable.push(row);
      descend(row.id);
    }
  };
  descend('');

  return flatten(buildTree(reachable));
}

/** The path of one node, for display. Empty when it no longer exists. */
export async function categoryPath(id: string | null): Promise<string> {
  if (!id) return '';
  const all = await listAll();
  const node = flatten(buildTree(all)).find((n) => n.id === id);
  return node?.path ?? '';
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CategoryInput {
  name: string;
  description: string;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
  groupId: string | null;
}

async function assertNameFree(
  name: string,
  parentId: string | null,
  exceptId: string | null,
): Promise<void> {
  const clash = await queryOne<{ id: string }>(
    `SELECT id FROM ticket_categories
      WHERE coalesce(parent_id, '') = coalesce(?, '') AND lower(name) = lower(?)`,
    [parentId, name],
  );
  if (clash && clash.id !== exceptId) {
    throw conflict(
      'Something with that name already sits at this level. Names only have to be ' +
        'unique among their siblings, so the same name under a different parent is fine.',
      'category_name_taken',
    );
  }
}

/** The level is derived from the parent, never taken from the form. */
async function levelFor(parentId: string | null): Promise<Level> {
  if (!parentId) return 1;
  const parent = await findCategory(parentId);
  if (!parent) throw notFound('That parent category no longer exists.');
  if (parent.level >= 3) {
    throw conflict(
      'An item is the deepest level. Add this under a category or a subcategory instead.',
      'too_deep',
    );
  }
  return (parent.level + 1) as Level;
}

export async function createCategory(
  input: CategoryInput,
  actorId: string | null,
): Promise<CategoryRow> {
  const level = await levelFor(input.parentId);
  await assertNameFree(input.name, input.parentId, null);

  const id = newId();
  const now = nowIso();
  await execute(
    `INSERT INTO ticket_categories
       (id, parent_id, level, name, description, is_active, sort_order, group_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.parentId,
      level,
      input.name,
      input.description,
      input.isActive ? 1 : 0,
      input.sortOrder,
      input.groupId,
      now,
      now,
    ],
  );

  audit({
    action: 'category.created',
    actorId,
    targetType: 'category',
    targetId: id,
    detail: { name: input.name, level },
  });

  const created = await findCategory(id);
  if (!created) throw new Error('category vanished immediately after insert: ' + id);
  return created;
}

/**
 * Renames or retires a node.
 *
 * The parent is deliberately not editable: moving a subtree would change the
 * level of everything beneath it, and re-filing the tickets already classified
 * under it is a decision for a person, not a side effect of a rename.
 */
export async function updateCategory(
  id: string,
  input: Omit<CategoryInput, 'parentId'>,
  actorId: string | null,
): Promise<CategoryRow> {
  const existing = await findCategory(id);
  if (!existing) throw notFound('That category no longer exists.');
  await assertNameFree(input.name, existing.parent_id, id);

  await execute(
    `UPDATE ticket_categories SET
        name = ?, description = ?, is_active = ?, sort_order = ?, group_id = ?,
        updated_at = ?
      WHERE id = ?`,
    [
      input.name,
      input.description,
      input.isActive ? 1 : 0,
      input.sortOrder,
      input.groupId,
      nowIso(),
      id,
    ],
  );

  audit({
    action: 'category.updated',
    actorId,
    targetType: 'category',
    targetId: id,
    detail: { name: input.name, active: input.isActive },
  });

  const updated = await findCategory(id);
  if (!updated) throw new Error('category disappeared during update: ' + id);
  return updated;
}

/** How many tickets are filed against this node or anything beneath it. */
export async function usageCount(id: string): Promise<number> {
  const all = await listAll();
  const descendants = new Set<string>([id]);
  // The tree is shallow, so repeated passes are cheaper than recursion in SQL.
  for (let i = 0; i < 3; i++) {
    for (const row of all) {
      if (row.parent_id && descendants.has(row.parent_id)) descendants.add(row.id);
    }
  }
  const ids = [...descendants];
  const row = await queryOne<{ c: number }>(
    'SELECT count(*) AS c FROM tickets WHERE category_id IN (' + ids.map(() => '?').join(', ') + ')',
    ids,
  );
  return row?.c ?? 0;
}

/**
 * Removes a node and everything beneath it.
 *
 * Refused while tickets are filed against any of it: the classification of a
 * ticket that already happened is a record, not a setting. Retire it instead - * that takes it out of the pickers and leaves the history readable.
 */
export async function deleteCategory(id: string, actorId: string | null): Promise<void> {
  const existing = await findCategory(id);
  if (!existing) return;

  const used = await usageCount(id);
  if (used > 0) {
    throw conflict(
      used +
        ' ticket(s) are filed under this or something beneath it, so removing it would ' +
        'erase how they were classified. Retire it instead to take it out of the pickers.',
      'category_in_use',
    );
  }

  // Children cascade in the schema.
  await execute('DELETE FROM ticket_categories WHERE id = ?', [id]);
  audit({
    action: 'category.deleted',
    actorId,
    targetType: 'category',
    targetId: id,
    detail: { name: existing.name },
  });
}

/**
 * The technician group work filed against a node should go to.
 *
 * Inherited **downwards**: an item with no group of its own falls back to
 * its subcategory, then to its category. That way a whole branch is routed
 * with one setting, and an exception is one override rather than a rewrite.
 *
 * Returns null when nothing in the branch names a group.
 */
export async function routingGroupFor(categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  const node = flatten(buildTree(await listAll())).find((n) => n.id === categoryId);
  if (!node) return null;
  // The trail runs ancestors-first, so the nearest setting is the last one.
  for (const step of [...node.trail].reverse()) {
    if (step.group_id) return step.group_id;
  }
  return null;
}
