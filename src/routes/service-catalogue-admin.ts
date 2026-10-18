import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { auditRequest } from '../lib/audit.js';
import { allowOwnScripts, writeLimiter } from '../middleware/security.js';
import { flash } from '../middleware/view-locals.js';
import {
  CATALOGUE_ICONS,
  addTile,
  serviceCatalogueOn,
  serviceCatalogueGrid,
  serviceCatalogueHeading,
  moveTile,
  placeTileAt,
  placedTiles,
  lastUsedCell,
  removeTile,
  setCatalogueEnabled,
  setCatalogueGrid,
  setCatalogueHeading,
  updateTile,
} from '../services/service-catalogue.js';
import { listActiveTemplates, templateAudience } from '../services/templates.js';
import { listUserGroups } from '../services/user-groups.js';
import { attempt, type FieldErrors } from './form-errors.js';
import { settingsView } from './settings-shared.js';

/**
 * Settings - Tickets - Service catalogue.
 *
 * The switch and the tiles are one page: a catalogue with nothing on it is
 * not worth switching on, and the switch is the first thing somebody arriving
 * at a page of tiles wants to know the state of.
 *
 * Mounted on the templates router, so it sits under
 * /admin/settings/templates/catalogue beside the forms it arranges.
 */
export const serviceCatalogueAdminRouter = Router();

/** Where a tile's row is, so a POST comes back to it rather than to the top. */
function tileUrl(id: string): string {
  return '/admin/settings/templates/catalogue' + (id ? '#tile-' + id : '');
}

async function catalogueView(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const templates = await listActiveTemplates();
  const byId = new Map(templates.map((t) => [t.id, t]));
  const groups = new Map((await listUserGroups()).map((g) => [g.id, g.name]));

  const tiles = await Promise.all(
    placedTiles().map(async (tile) => {
      const template = byId.get(tile.templateId);
      // Who the form behind it is offered to. A template restricted to a
      // user group is simply not there for anybody outside it, which looks
      // like a tile that went missing - reported 16 Oct 2026 as "4 tiles
      // but only 3 in New ticket". Said here, where it can be acted on.
      const audience = template ? await templateAudience(template.id) : [];
      return {
        ...tile,
        // A tile can outlive the form it opens - a template retired or
        // deleted. It is shown with the reason rather than quietly dropped,
        // because on this page the administrator is the one who can fix it.
        template: template ?? null,
        label: tile.label || template?.name || 'Untitled',
        description: tile.description || template?.summary || '',
        offeredTo: audience.map((id) => groups.get(id) ?? 'a group that no longer exists'),
      };
    }),
  );

  return settingsView('templates', {
    sectionTitle: 'Tickets',
    tab: 'catalogue',
    enabled: serviceCatalogueOn(),
    heading: serviceCatalogueHeading(),
    grid: serviceCatalogueGrid(),
    // One page past the last tile, always: that is where a tile goes when
    // somebody wants a second page (asked for 16 Oct 2026).
    lastCell: lastUsedCell(),
    tiles,
    templates,
    icons: CATALOGUE_ICONS,
    errors: {} as FieldErrors,
    values: {} as Record<string, unknown>,
    openDialog: null,
    // Which empty cell's + was pressed, if any.
    addAt: null as number | null,
    ...extra,
  });
}

serviceCatalogueAdminRouter.get(
  '/',
  // The preview's drag-and-drop: catalogue-grid.js, ours, on this page only
  // (approved 15 Oct 2026). It posts a form, so connect-src stays 'none'.
  allowOwnScripts(),
  asyncHandler(async (req, res) => {
    // "?add=<cell>" from a + in the grid: the Add dialog opens with that
    // position in it. Anything else is ignored rather than refused - it is
    // an address somebody can type.
    const asked = Number(req.query.add);
    const addAt = Number.isInteger(asked) && asked >= 0 ? asked : null;
    res.render(
      'admin/settings/template-catalogue',
      await catalogueView(addAt === null ? {} : { addAt, openDialog: 'new-tile' }),
    );
  }),
);

/** How many across, and how many rows before the catalogue pages. */
serviceCatalogueAdminRouter.post(
  '/grid',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const columns = Number(raw.columns);
    const rows = Number(raw.rows);

    const saved = await attempt(() =>
      setCatalogueGrid(columns, rows, raw.filters === 'on', req.currentUser?.id ?? null),
    );
    if (!saved.ok) {
      res.status(400).render(
        'admin/settings/template-catalogue',
        await catalogueView({ errors: saved.errors }),
      );
      return;
    }

    auditRequest(req, {
      action: 'settings.catalogue.grid',
      targetType: 'settings',
      targetId: 'current',
      detail: { columns, rows, filters: raw.filters === 'on' },
    });
    flash(req, 'success', 'Layout saved.');
    res.redirect('/admin/settings/templates/catalogue');
  }),
);

/**
 * A dropped tile: into that cell, swapping with whatever was there.
 *
 * The arrows post the same move one cell at a time, so a browser without
 * the script can do everything this does.
 */
serviceCatalogueAdminRouter.post(
  '/tiles/position',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const cell = Number(raw.cell ?? raw.index);
    if (!id || !Number.isFinite(cell)) {
      res.redirect('/admin/settings/templates/catalogue');
      return;
    }
    await placeTileAt(id, cell, req.currentUser?.id ?? null);
    res.redirect(tileUrl(id));
  }),
);

serviceCatalogueAdminRouter.post(
  '/switch',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const on = (req.body ?? {}).enabled === 'on';
    await setCatalogueEnabled(on, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: on ? 'settings.catalogue.on' : 'settings.catalogue.off',
      targetType: 'settings',
      targetId: 'current',
    });
    flash(
      req,
      'success',
      on ? 'New ticket now opens the service catalogue.' : 'New ticket opens the request form again.',
    );
    res.redirect('/admin/settings/templates/catalogue');
  }),
);

serviceCatalogueAdminRouter.post(
  '/heading',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const text = typeof (req.body ?? {}).heading === 'string' ? req.body.heading : '';
    await setCatalogueHeading(text, req.currentUser?.id ?? null);
    auditRequest(req, { action: 'settings.catalogue.heading', targetType: 'settings', targetId: 'current' });
    flash(req, 'success', 'Saved.');
    res.redirect('/admin/settings/templates/catalogue');
  }),
);

/** What a tile's form posted, whichever form it was. */
function tileInput(body: Record<string, unknown>): {
  templateId: string;
  label: string;
  description: string;
  icon: string;
} {
  return {
    templateId: typeof body.templateId === 'string' ? body.templateId : '',
    label: typeof body.label === 'string' ? body.label : '',
    description: typeof body.description === 'string' ? body.description : '',
    icon: typeof body.icon === 'string' ? body.icon : 'ticket',
  };
}

serviceCatalogueAdminRouter.post(
  '/tiles',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const input = tileInput((req.body ?? {}) as Record<string, unknown>);

    // attempt() turns a refusal into field errors beside the form, rather
    // than a 400 page that loses what was typed (trap 6).
    // Which empty cell of the grid was pressed, when it was a cell.
    const asked = Number((req.body as Record<string, unknown>)?.index);
    const added = await attempt(() =>
      addTile(input, req.currentUser?.id ?? null, Number.isFinite(asked) ? asked : undefined),
    );
    if (!added.ok) {
      res.status(400).render(
        'admin/settings/template-catalogue',
        await catalogueView({ errors: added.errors, values: input, openDialog: 'new-tile' }),
      );
      return;
    }

    auditRequest(req, {
      action: 'settings.catalogue.tile_added',
      targetType: 'settings',
      targetId: 'current',
      detail: { templateId: input.templateId },
    });
    flash(req, 'success', 'Tile added.');
    res.redirect(tileUrl(added.value.id));
  }),
);

serviceCatalogueAdminRouter.post(
  '/tiles/:id',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const input = tileInput((req.body ?? {}) as Record<string, unknown>);

    const saved = await attempt(() => updateTile(id, input, req.currentUser?.id ?? null));
    if (!saved.ok) {
      res.status(400).render(
        'admin/settings/template-catalogue',
        await catalogueView({ errors: saved.errors, values: input, openDialog: 'tile-' + id }),
      );
      return;
    }

    auditRequest(req, {
      action: 'settings.catalogue.tile_changed',
      targetType: 'settings',
      targetId: 'current',
      detail: { tile: id },
    });
    flash(req, 'success', 'Tile saved.');
    res.redirect(tileUrl(id));
  }),
);

serviceCatalogueAdminRouter.post(
  '/tiles/:id/move',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const direction = (req.body ?? {}).direction === 'up' ? 'up' : 'down';
    await moveTile(id, direction, req.currentUser?.id ?? null);
    res.redirect(tileUrl(id));
  }),
);

serviceCatalogueAdminRouter.post(
  '/tiles/:id/remove',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    await removeTile(id, req.currentUser?.id ?? null);
    auditRequest(req, {
      action: 'settings.catalogue.tile_removed',
      targetType: 'settings',
      targetId: 'current',
      detail: { tile: id },
    });
    flash(req, 'success', 'Tile removed. The form itself is untouched.');
    res.redirect('/admin/settings/templates/catalogue');
  }),
);
