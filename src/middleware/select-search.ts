/**
 * Search in long dropdowns - the fifth approved script (12 Oct 2026).
 *
 * A page is given public/js/select-search.js only when what it is about to
 * send contains a dropdown long enough to need it (more than SEARCH_FROM
 * options), one that narrows another (data-narrows), or one that asks for the
 * panel whatever its length (data-search). Every other page keeps
 * `script-src 'none'`. Decided on the finished HTML, so no route or view has
 * to remember to ask, and a page whose list is short stays script-free.
 *
 * Never on a framed preview (?portalFrame, /preview, /sample) or an approval
 * page, and never 'unsafe-inline': the policy becomes `script-src 'self'`,
 * so only files we serve can run. Without the script every dropdown works as
 * it always did.
 */
import type { RequestHandler } from 'express';

export const SEARCH_FROM = 8;

const SELECT = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;

/** Whether this HTML has a dropdown, or a list of tick boxes, worth a search box. */
export function wantsSelectSearch(html: string): boolean {
  // Tick boxes sharing a name - a list of groups to choose from, say.
  // A list of rows that asks for a search box of its own - data-search for
  // "whatever the length", data-search-from for "sooner than eight". It is
  // on the list, not on a select, so it is looked for in the whole page.
  if (/\bdata-search(-from)?\b/i.test(html)) return true;

  // Tick boxes and radios alike: a list of one or the other, sharing a name,
  // is the same list to a reader. Radios were missed, which is why the
  // template picker in a mail rule had to ask for the script explicitly.
  const names = new Map<string, number>();
  for (const [, name] of html.matchAll(/<input\b[^>]*type="(?:checkbox|radio)"[^>]*name="([^"]+)"/gi)) {
    const n = (names.get(name!) ?? 0) + 1;
    if (n > SEARCH_FROM) return true;
    names.set(name!, n);
  }
  for (const [, attrs, inner] of html.matchAll(SELECT)) {
    // A multiple select is left alone - a list box needs no search panel -
    // unless it asks for one with data-multi, which is how the Manager
    // dashboard picks several groups from the dropdown used everywhere else.
    if (/\bmultiple\b/i.test(attrs ?? '') && !/\bdata-multi\b/i.test(attrs ?? '')) continue;
    if (/\bdata-narrows=/i.test(attrs ?? '')) return true;
    // A page may ask for the panel on a short list too (`data-search`), and
    // then the script has to be served even though nothing here is long.
    if (/\bdata-search\b/i.test(attrs ?? '')) return true;
    // One that opts out is not a reason to serve the script either (the
    // automations list's trigger choice, 21 Oct 2026).
    if (/\bdata-no-search\b/i.test(attrs ?? '')) continue;
    if (((inner ?? '').match(/<option\b/gi) ?? []).length > SEARCH_FROM) return true;
  }
  return false;
}

/**
 * The scripts a page is given by what its HTML holds. The search panel for
 * long lists, and the sidebar's fold button, which folds at once with
 * sidebar.js (22 Oct 2026) and reloads the page without it.
 */
const PAGE_SCRIPTS: { file: string; wanted: (html: string) => boolean }[] = [
  { file: 'select-search.js', wanted: wantsSelectSearch },
  { file: 'sidebar.js', wanted: (html) => html.includes('data-sidebar-fold') },
];

function skipped(path: string, query: Record<string, unknown>): boolean {
  return (
    query.portalFrame !== undefined ||
    /\/(preview|sample)(\/|$)/.test(path) ||
    path.startsWith('/approvals') ||
    path.startsWith('/login') ||
    path.startsWith('/auth')
  );
}

export function selectSearch(): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' || skipped(req.path, req.query as Record<string, unknown>)) return next();
    const send = res.send.bind(res);
    res.send = (body?: unknown) => {
      // res.render sends before Express sets the type, so an unset type with
      // an HTML document counts too.
      const type = String(res.getHeader('Content-Type') ?? '');
      const html = typeof body === 'string' && (type ? type.startsWith('text/html') : /^\s*<!doctype html/i.test(body));
      if (typeof body === 'string' && html && !res.headersSent) {
        let page: string = body;
        for (const script of PAGE_SCRIPTS) {
          if (!script.wanted(page)) continue;
          const policy = res.getHeader('Content-Security-Policy');
          if (typeof policy === 'string' && policy.includes("script-src 'none'")) {
            res.setHeader('Content-Security-Policy', policy.replace("script-src 'none'", "script-src 'self'"));
          }
          // Allowed now (either by this or by the page's own exception).
          const allowed = String(res.getHeader('Content-Security-Policy') ?? '').match(/script-src [^;]*'self'/);
          if (allowed && !page.includes('/assets/js/' + script.file)) {
            const tag = '<script src="/assets/js/' + script.file + '?v=' + String(req.app.locals.assetVersion ?? '') + '" defer></script>';
            page = page.includes('</body>') ? page.replace('</body>', tag + '\n</body>') : page + tag;
          }
        }
        body = page;
      }
      return send(body as never);
    };
    next();
  };
}
