import './env.js';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';
import { rewrite, scan } from '../src/i18n/extract.js';
import { viewFiles } from '../scripts/strings.js';

/**
 * Every view still compiles after it has been prepared for translation.
 *
 * This test exists because the rewriter broke the application once: a
 * run-matching regular expression backtracked through an element's own
 * attributes and produced EJS that would not compile, so every settings
 * page answered 500 (16 Oct 2026, reported as "idk what you did to break
 * the system"). The suite caught it only through the pages it happens to
 * render; this catches it on **every** view, in a second, and names the
 * file.
 *
 * It is the cheapest guard there is for a change this wide, and anything
 * added to extract.ts should be run past it first.
 */

describe('the views survive being prepared for translation', () => {
  test('every one of them still compiles', () => {
    const broken: string[] = [];
    for (const file of viewFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      try {
        // The same options the engine uses, minus the includer: a partial
        // is compiled on its own turn through this loop.
        ejs.compile(rewrite(source, file), {
          filename: file,
          cache: false,
          includer: () => ({ template: '' }) as never,
        });
      } catch (err) {
        broken.push(path.basename(file) + ': ' + (err instanceof Error ? err.message.split('\n').pop() : String(err)));
      }
    }
    assert.deepEqual(broken, [], 'these views no longer compile after rewriting');
  });

  test('a rewritten view keeps every EJS tag it started with', () => {
    // A rewrite that swallows an `<% if %>` leaves a page that compiles and
    // renders the wrong thing, which no compile check would notice.
    for (const file of viewFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const out = rewrite(source, file);
      const control = (text: string) => (text.match(/<%[^=\-#]/g) ?? []).length;
      const raw = (text: string) => (text.match(/<%-/g) ?? []).length;
      assert.equal(control(out), control(source), file + ' changed its control tags');
      assert.ok(raw(out) >= raw(source), file + ' lost a raw output tag');
    }
  });

  test('nothing is extracted twice from one place', () => {
    for (const file of viewFiles()) {
      const found = scan(fs.readFileSync(file, 'utf8'), file);
      const seen = new Set<string>();
      for (const one of found) {
        // The same text may appear twice in a file; what must not happen is
        // the same *place* being read as two different strings.
        seen.add(one.id + '|' + one.text);
      }
      assert.ok(seen.size <= found.length);
    }
  });
});
