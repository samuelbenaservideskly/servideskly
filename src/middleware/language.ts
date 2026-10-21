import type { RequestHandler } from 'express';
import { enabledLanguages, interpolatorFor, textInterpolatorFor, translatorFor, english } from '../i18n/index.js';
import { languageFor } from '../i18n/resolve.js';
import { localise } from '../i18n/localise.js';
import { withWords } from '../i18n/current.js';

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
      res.locals.tx = textInterpolatorFor(english);
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
        res.locals.tx = textInterpolatorFor(translate);
        if (translate === english) {
          next();
          return;
        }
        localise(res, translate);
        // For code that draws text itself (i18n/current.ts).
        withWords(translate, () => next());
      })
      .catch(() => {
        // Working out a language must never cost a page.
        res.locals.t = english;
        res.locals.tr = interpolatorFor(english);
        res.locals.tx = textInterpolatorFor(english);
        res.locals.language = '';
        next();
      });
  };
}
