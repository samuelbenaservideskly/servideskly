import type { RequestHandler } from 'express';
import { enabledLanguages, interpolatorFor, translatorFor, english } from '../i18n/index.js';
import { languageFor } from '../i18n/resolve.js';

/**
 * Puts `t()` in front of every page.
 *
 * `res.locals.t` is what the rewritten views call. With no language enabled
 * it is `english`, which returns its argument - so a service desk that never
 * adds a language pays one `if` per request and nothing else.
 *
 * It is deliberately **after the session**, because the first rule is what
 * the reader chose, and before anything that renders.
 */
export function language(): RequestHandler {
  return (req, res, next) => {
    if (enabledLanguages().length === 0) {
      res.locals.t = english;
      res.locals.tr = interpolatorFor(english);
      res.locals.language = '';
      next();
      return;
    }

    languageFor(req.currentUser ?? null, req.get('accept-language'))
      .then((tag) => {
        const translate = translatorFor(tag);
        res.locals.language = tag;
        res.locals.t = translate;
        res.locals.tr = interpolatorFor(translate);
        next();
      })
      .catch(() => {
        // Working out a language must never cost a page.
        res.locals.t = english;
        res.locals.tr = interpolatorFor(english);
        res.locals.language = '';
        next();
      });
  };
}
