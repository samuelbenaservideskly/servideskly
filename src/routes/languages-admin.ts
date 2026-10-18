import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { attempt } from './form-errors.js';
import { auditRequest } from '../lib/audit.js';
import { flash } from '../middleware/view-locals.js';
import { writeLimiter } from '../middleware/security.js';
import { listUserGroups } from '../services/user-groups.js';
import {
  coverage,
  createLanguage,
  deleteLanguage,
  findLanguage,
  importTranslations,
  languageGroups,
  listLanguages,
  loadLanguages,
  renameLanguage,
  setLanguageDomains,
  setLanguageEnabled,
  setLanguageGroups,
  translationMarkdown,
  type LanguageRow,
} from '../i18n/index.js';
import { forgetLanguageGroups } from '../i18n/resolve.js';
import { forgetViews } from '../i18n/engine.js';

/**
 * Settings - Customisation - Locale - Languages.
 *
 * The page is small on purpose: a language is a tag, a name, a document to
 * hand an AI and the answer pasted back. Everything hard about this feature
 * is in src/i18n, and the hardest part of it - keeping the document up to
 * date - is a generated file rather than a page somebody has to visit.
 */

export const languageAdminRouter = Router();

const BASE = '/admin/settings/customization/locale';

/** Every write drops what the process is holding, in one place. */
async function reload(): Promise<void> {
  await loadLanguages();
  forgetLanguageGroups();
  // A translation that changed must reach the next page, and the compiled
  // views hold no translations - only t() calls - so this is belt and
  // braces for a future where they do.
  forgetViews();
}

interface LanguageView {
  row: LanguageRow;
  done: number;
  total: number;
  assigned: string[];
  excluded: string[];
}

async function languageViews(): Promise<LanguageView[]> {
  const rows = await listLanguages();
  const out: LanguageView[] = [];
  for (const row of rows) {
    const groups = await languageGroups(row.tag);
    out.push({
      row,
      ...coverage(row),
      assigned: groups.filter((g) => g.mode === 'assigned').map((g) => g.group_id),
      excluded: groups.filter((g) => g.mode === 'excluded').map((g) => g.group_id),
    });
  }
  return out;
}

/**
 * The locale page, languages and all.
 *
 * `renderLocale` in settings.ts draws the clock and the time zone; this adds
 * the languages to the same view, so there is one page about how the service
 * desk reads rather than two.
 */
export async function languageLocals(
  extra: { errors?: Record<string, string>; openDialog?: string | null; typed?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  return {
    languages: await languageViews(),
    allUserGroups: await listUserGroups(),
    languageErrors: extra.errors ?? {},
    // Every GET must pass this, or the template throws on an undefined local.
    openDialog: extra.openDialog ?? null,
    typed: extra.typed ?? {},
  };
}

async function refuse(
  req: Request,
  res: Response,
  errors: Record<string, string>,
  openDialog: string,
  typed: Record<string, string> = {},
): Promise<void> {
  const { renderLocaleWith } = await import('./settings.js');
  await renderLocaleWith(req, res, { errors, openDialog, typed }, 400);
}

languageAdminRouter.post(
  '/languages',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const input = {
      tag: String(body.tag ?? ''),
      name: String(body.name ?? ''),
      label: String(body.label ?? ''),
    };
    const added = await attempt(() => createLanguage(input, req.currentUser?.id ?? null));
    if (!added.ok) {
      await refuse(req, res, added.errors, 'new-language', input);
      return;
    }
    await reload();
    flash(req, 'success', 'Language added. Download the document, have it translated, and paste it back.');
    res.redirect(BASE + '#language-' + added.value);
  }),
);

languageAdminRouter.post(
  '/languages/:tag',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const input = {
      tag: req.params.tag ?? '',
      name: String(body.name ?? ''),
      label: String(body.label ?? ''),
    };
    const saved = await attempt(() => renameLanguage(input.tag, input, req.currentUser?.id ?? null));
    if (!saved.ok) {
      await refuse(req, res, saved.errors, 'language-' + input.tag, input);
      return;
    }
    await reload();
    flash(req, 'success', 'Saved.');
    res.redirect(BASE + '#language-' + input.tag);
  }),
);

languageAdminRouter.post(
  '/languages/:tag/enabled',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tag = req.params.tag ?? '';
    const on = String((req.body as Record<string, unknown>)?.enabled ?? '') === 'on';
    await setLanguageEnabled(tag, on, req.currentUser?.id ?? null);
    await reload();
    flash(
      req,
      'success',
      on
        ? 'That language is on. People it applies to see it from their next page.'
        : 'That language is off. The translation is kept.',
    );
    res.redirect(BASE + '#language-' + tag);
  }),
);

languageAdminRouter.post(
  '/languages/:tag/domains',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tag = req.params.tag ?? '';
    const lines = String((req.body as Record<string, unknown>)?.domains ?? '')
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const saved = await attempt(() => setLanguageDomains(tag, lines, req.currentUser?.id ?? null));
    if (!saved.ok) {
      await refuse(req, res, saved.errors, 'language-' + tag);
      return;
    }
    await reload();
    flash(req, 'success', 'Saved.');
    res.redirect(BASE + '#language-' + tag);
  }),
);

languageAdminRouter.post(
  '/languages/:tag/groups',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tag = req.params.tag ?? '';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const list = (value: unknown): string[] =>
      Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
    await setLanguageGroups(tag, list(body.assigned), list(body.excluded), req.currentUser?.id ?? null);
    await reload();
    flash(req, 'success', 'Saved.');
    res.redirect(BASE + '#language-' + tag);
  }),
);

/** The document to hand an AI. Generated now, so it is never out of date. */
languageAdminRouter.get(
  '/languages/:tag/document',
  asyncHandler(async (req, res) => {
    const row = await findLanguage(req.params.tag ?? '');
    if (!row) {
      flash(req, 'error', 'That language is no longer here.');
      res.redirect(BASE);
      return;
    }
    auditRequest(req, { action: 'language.downloaded', targetType: 'language', targetId: row.tag });
    res.type('text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${row.tag}-translate.md"`);
    res.send(translationMarkdown(row));
  }),
);

languageAdminRouter.post(
  '/languages/:tag/import',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tag = req.params.tag ?? '';
    const markdown = String((req.body as Record<string, unknown>)?.markdown ?? '');
    const done = await attempt(() => importTranslations(tag, markdown, req.currentUser?.id ?? null));
    if (!done.ok) {
      await refuse(req, res, { markdown: Object.values(done.errors)[0] ?? 'That could not be read.' }, 'import-' + tag);
      return;
    }
    await reload();
    const { matched, unknown, done: covered, total } = done.value;
    flash(
      req,
      'success',
      `${covered} of ${total} strings translated` +
        (unknown > 0 ? ` - ${unknown} rows were for text that has changed since, and were left out.` : '.') +
        (matched === 0 ? ' Nothing matched: check the id column came back as it was sent.' : ''),
    );
    res.redirect(BASE + '#language-' + tag);
  }),
);

languageAdminRouter.post(
  '/languages/:tag/delete',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const tag = req.params.tag ?? '';
    await deleteLanguage(tag, req.currentUser?.id ?? null);
    await reload();
    flash(req, 'success', 'Language removed. Anybody who had chosen it is back to English.');
    res.redirect(BASE);
  }),
);
