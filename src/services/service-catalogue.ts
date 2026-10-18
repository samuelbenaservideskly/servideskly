import { badRequest, notFound } from '../lib/errors.js';
import { newId, normaliseLine } from '../lib/util.js';
import { settings, updateSettings } from '../settings/index.js';
import { templatesVisibleTo, type TemplateRow } from './templates.js';

/**
 * The service catalogue.
 *
 * On, "New ticket" opens a page of tiles instead of a form: the service desk
 * decides what it offers and in what order, rather than handing somebody a
 * dropdown of every form and asking them to know which one they want.
 *
 * Three decisions worth keeping:
 *
 * 1. **A tile is a template, plus how it reads.** It stores the template id
 *    and, optionally, its own label, description and icon. Left empty, the
 *    template's own name and summary are shown - so renaming a template
 *    renames its tile, which is almost always what was meant.
 * 2. **Order is the only position.** There are no coordinates: the tiles
 *    flow into a grid in the order they are listed, so a tile the reader may
 *    not use is simply left out and the rest close the gap. A grid of fixed
 *    cells would leave a hole in the middle of somebody's catalogue, and the
 *    hole would say that something is there that they may not have.
 * 3. **Access is the template's, not the tile's.** `templatesVisibleTo()`
 *    already answers "may this person raise this form?" from the template's
 *    user groups, and the catalogue asks it rather than inventing a second
 *    rule that could disagree with the form itself.
 *
 * It lives in the settings document rather than a table of its own: it is a
 * short list that one person edits, read on every New ticket, and the
 * settings cache already keeps it in memory.
 */

/**
 * The icons a tile may carry - the names drawn by `partials/icon.ejs`.
 *
 * A fixed list, not free text: the icon is drawn inline as markup, so
 * anything a form could post has to name a shape we already have.
 */
export const CATALOGUE_ICONS = [
  { key: 'ticket', label: 'Ticket' },
  { key: 'laptop', label: 'Laptop' },
  { key: 'monitor', label: 'Monitor' },
  { key: 'phone', label: 'Phone' },
  { key: 'printer', label: 'Printer' },
  { key: 'wifi', label: 'Network' },
  { key: 'server', label: 'Server' },
  { key: 'database', label: 'Database' },
  { key: 'cloud', label: 'Cloud' },
  { key: 'mail', label: 'Mail' },
  { key: 'key', label: 'Access' },
  { key: 'lock', label: 'Security' },
  { key: 'shield', label: 'Shield' },
  { key: 'user', label: 'Person' },
  { key: 'users', label: 'Team' },
  { key: 'userPlus', label: 'New starter' },
  { key: 'package', label: 'Package' },
  { key: 'cart', label: 'Purchase' },
  { key: 'wrench', label: 'Repair' },
  { key: 'bug', label: 'Fault' },
  { key: 'alert', label: 'Incident' },
  { key: 'calendar', label: 'Booking' },
  { key: 'building', label: 'Building' },
  { key: 'file', label: 'Document' },
  { key: 'book', label: 'Guide' },
  { key: 'help', label: 'Question' },
  { key: 'message', label: 'Message' },
  { key: 'sparkles', label: 'Something else' },
] as const;

export type CatalogueIcon = (typeof CATALOGUE_ICONS)[number]['key'];

export function isCatalogueIcon(value: unknown): value is CatalogueIcon {
  return typeof value === 'string' && CATALOGUE_ICONS.some((i) => i.key === value);
}

export interface CatalogueTile {
  id: string;
  templateId: string;
  label: string;
  description: string;
  icon: string;
  /**
   * Which cell of the grid it sits in, counted across the whole catalogue.
   *
   * Absent on a tile placed before cells existed; `placedTiles()` gives
   * those the first free cells, in the order they were added, which is
   * where they were already being drawn.
   */
  cell?: number;
}

/** A tile with the template it opens, resolved. */
export interface CatalogueEntry {
  tile: CatalogueTile;
  template: TemplateRow;
  /** What the tile reads as: its own words, or the template's. */
  label: string;
  description: string;
}

export function serviceCatalogueOn(): boolean {
  return settings().tickets.catalogue.enabled;
}

export function serviceCatalogueHeading(): string {
  return settings().tickets.catalogue.heading;
}

export interface CatalogueGrid {
  columns: number;
  rows: number;
  /** Tiles on a page: the grid, filled. */
  perPage: number;
  /** Show the Service request / Incident / Change request buttons. */
  filters: boolean;
}

export function serviceCatalogueGrid(): CatalogueGrid {
  const { columns, rows, filters } = settings().tickets.catalogue;
  return { columns, rows, filters, perPage: Math.max(1, columns * rows) };
}

export async function setCatalogueGrid(
  columns: number,
  rows: number,
  filters: boolean,
  actorId: string | null,
): Promise<void> {
  if (!Number.isInteger(columns) || columns < 1 || columns > 5) {
    throw badRequest('Between 1 and 5 columns.');
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 10) {
    throw badRequest('Between 1 and 10 rows on a page.');
  }
  const current = settings().tickets.catalogue;
  await updateSettings(
    { tickets: { catalogue: { ...current, columns, rows, filters, tiles: catalogueTiles() } } },
    actorId,
  );
}

export function catalogueTiles(): CatalogueTile[] {
  return settings().tickets.catalogue.tiles.map((tile) => ({ ...tile }));
}

async function saveTiles(
  tiles: CatalogueTile[],
  actorId: string | null,
  extra: { enabled?: boolean; heading?: string } = {},
): Promise<void> {
  const current = settings().tickets.catalogue;
  await updateSettings(
    {
      tickets: {
        catalogue: {
          ...current,
          enabled: extra.enabled ?? current.enabled,
          heading: extra.heading ?? current.heading,
          tiles,
        },
      },
    },
    actorId,
  );
}

export async function setCatalogueEnabled(on: boolean, actorId: string | null): Promise<void> {
  await saveTiles(catalogueTiles(), actorId, { enabled: on });
}

export async function setCatalogueHeading(text: string, actorId: string | null): Promise<void> {
  await saveTiles(catalogueTiles(), actorId, { heading: normaliseLine(text).slice(0, 80) });
}

export interface TileInput {
  templateId: string;
  label?: string;
  description?: string;
  icon?: string;
}

function clean(input: TileInput): Omit<CatalogueTile, 'id'> {
  const templateId = normaliseLine(input.templateId ?? '');
  if (!templateId) throw badRequest('Choose the form this tile opens.');
  return {
    templateId,
    label: normaliseLine(input.label ?? '').slice(0, 60),
    description: normaliseLine(input.description ?? '').slice(0, 140),
    // Anything unknown falls back rather than being refused: the icon is
    // decoration, and a tile is worth more than a message about a shape.
    icon: isCatalogueIcon(input.icon) ? input.icon : 'ticket',
  };
}

/** At most this many cells, which is also at most this many tiles. */
export const MAX_CELLS = 200;

/**
 * Adds a tile in a cell.
 *
 * The editor draws the grid a requester will see and puts a + in every
 * empty cell, so `cell` is the one that was pressed. Without a cell - or
 * with one somebody already holds - it takes the first free cell, which is
 * what "add a tile" means with nowhere in particular in mind.
 */
export async function addTile(
  input: TileInput,
  actorId: string | null,
  cell?: number,
): Promise<CatalogueTile> {
  const placed = placedTiles();
  if (placed.length >= 60) {
    throw badRequest('A catalogue holds at most 60 tiles.');
  }

  const taken = new Set(placed.map((t) => t.cell));
  let at = Number.isInteger(cell) && Number(cell) >= 0 ? Math.min(Number(cell), MAX_CELLS - 1) : 0;
  while (taken.has(at)) at += 1;

  const tile: CatalogueTile = { id: newId(), ...clean(input), cell: at };
  await saveTiles([...placed, tile], actorId);
  return tile;
}

export async function updateTile(
  id: string,
  input: TileInput,
  actorId: string | null,
): Promise<void> {
  const tiles = catalogueTiles();
  const index = tiles.findIndex((t) => t.id === id);
  if (index < 0) throw notFound('That tile is not in the catalogue.');
  tiles[index] = { id, ...clean(input) };
  await saveTiles(tiles, actorId);
}

export async function removeTile(id: string, actorId: string | null): Promise<void> {
  const tiles = catalogueTiles();
  const left = tiles.filter((t) => t.id !== id);
  if (left.length === tiles.length) throw notFound('That tile is not in the catalogue.');
  await saveTiles(left, actorId);
}

/**
 * Every tile with a cell it certainly has.
 *
 * A tile saved before cells existed, or one whose cell another tile already
 * holds, takes the lowest free cell - which for a catalogue that was an
 * ordered list is exactly where it was being drawn.
 */
export function placedTiles(): (CatalogueTile & { cell: number })[] {
  const tiles = catalogueTiles();
  const taken = new Set<number>();
  const placed: (CatalogueTile & { cell: number })[] = [];
  const later: CatalogueTile[] = [];

  for (const tile of tiles) {
    const cell = Number.isInteger(tile.cell) ? Number(tile.cell) : -1;
    if (cell >= 0 && !taken.has(cell)) {
      taken.add(cell);
      placed.push({ ...tile, cell });
    } else {
      later.push(tile);
    }
  }

  let next = 0;
  for (const tile of later) {
    while (taken.has(next)) next += 1;
    taken.add(next);
    placed.push({ ...tile, cell: next });
  }

  return placed.sort((a, b) => a.cell - b.cell);
}

/** The highest cell any tile sits in, or -1 for an empty catalogue. */
export function lastUsedCell(): number {
  return placedTiles().reduce((highest, tile) => Math.max(highest, tile.cell), -1);
}

/**
 * Moves a tile to the cell before or after the one it is in.
 *
 * The arrows are the way to move a tile without a script, and with cells
 * "one place" means the next cell rather than the next tile - so an arrow
 * can move a tile into an empty cell, which is the point of having them.
 * The far ends are a no-op rather than a refusal.
 */
export async function moveTile(
  id: string,
  direction: 'up' | 'down',
  actorId: string | null,
): Promise<void> {
  const placed = placedTiles();
  const tile = placed.find((t) => t.id === id);
  if (!tile) throw notFound('That tile is not in the catalogue.');
  const to = direction === 'up' ? tile.cell - 1 : tile.cell + 1;
  if (to < 0 || to >= MAX_CELLS) return;
  await placeTileAt(id, to, actorId);
}

/**
 * Puts a tile in a cell. Whatever was there changes places with it, so a
 * drop onto an occupied cell is a swap and a drop onto an empty one is a
 * move - which is what both look like to the person dragging.
 */
export async function placeTileAt(id: string, cell: number, actorId: string | null): Promise<void> {
  const target = Math.max(0, Math.min(MAX_CELLS - 1, Math.trunc(cell)));
  const placed = placedTiles();
  const moving = placed.find((t) => t.id === id);
  if (!moving) throw notFound('That tile is not in the catalogue.');
  if (moving.cell === target) return;

  const occupant = placed.find((t) => t.cell === target);
  const next = placed.map((t) => {
    if (t.id === moving.id) return { ...t, cell: target };
    if (occupant && t.id === occupant.id) return { ...t, cell: moving.cell };
    return t;
  });
  await saveTiles(next, actorId);
}

/**
 * The catalogue as one person sees it, each entry in the cell it fills.
 *
 * A tile whose template they may not raise - or which has been retired,
 * deleted or left unfinished since the tile was made - is left out, **and
 * the tiles after it move up into the cells the administrator used**. So a
 * gap left on purpose stays a gap, and a gap left by somebody's permissions
 * closes: nothing advertises a service to the one person who cannot have
 * it, and nothing moves a layout about for everybody else.
 */
export async function serviceCatalogueFor(
  userGroupIds: readonly string[],
): Promise<(CatalogueEntry & { cell: number })[]> {
  const placed = placedTiles();
  if (placed.length === 0) return [];

  const allowed = new Map(
    (await templatesVisibleTo(userGroupIds)).map((template) => [template.id, template]),
  );

  // The cells this catalogue uses, in order: the layout, whoever is reading.
  const cells = placed.map((tile) => tile.cell);
  const entries: (CatalogueEntry & { cell: number })[] = [];

  for (const tile of placed) {
    const template = allowed.get(tile.templateId);
    if (!template) continue;
    entries.push({
      tile,
      template,
      label: tile.label || template.name,
      description: tile.description || template.summary || '',
      // The next cell the layout offers, which is this tile's own unless an
      // earlier one was hidden.
      cell: cells[entries.length]!,
    });
  }
  return entries;
}
