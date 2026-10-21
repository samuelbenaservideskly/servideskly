import crypto from 'node:crypto';

/**
 * Finding the reader's text in a view, and rewriting it to ask for a
 * translation.
 *
 * The requirement that decided this file: **a new feature must appear in the
 * translator's document by itself** (asked for 16 Oct 2026). A catalogue
 * somebody keeps by hand fails that on the first busy afternoon, so the
 * catalogue is generated from the views, by this code.
 *
 * It is used twice, and that is the whole point:
 *
 * - `scan()` builds the catalogue (`npm run strings` -> src/i18n/strings.json),
 *   which is what the markdown download and the coverage count read.
 * - `rewrite()` is run **on the way into the template engine**, in memory, so
 *   the views on disk stay plain English. Nothing is hand-keyed and no
 *   mechanical commit rewrites two hundred files, which also means the diff
 *   of a view is still the diff of a view.
 *
 * Because both come from one parser, a string cannot be in the catalogue and
 * untranslated on the page, or the other way round.
 *
 * ## What counts as the reader's text
 *
 * Conservative on purpose. With no language chosen `t()` returns its
 * argument, so a rewritten template renders byte-for-byte what it did
 * before - which is why the existing suite is a real test of this file. The
 * cost of that safety is that some text is left in English rather than
 * translated badly:
 *
 * - **A whole text node**, between two tags, with no EJS tag inside it:
 *   `<h1>Tickets</h1>`. A run broken by interpolation - "Showing <%= n %>
 *   tickets" - is **left alone**: the halves are not sentences, and
 *   translating them separately reads worse than English. The same goes for
 *   one broken by inline markup (`<strong>`), where a translation could
 *   otherwise carry markup of its own into the page.
 * - **The value of a plain `placeholder`, `title`, `aria-label` or `alt`**,
 *   which is read aloud or shown as a tooltip. Never `value`, `name`, `id`,
 *   `href` or a `data-` attribute: those are posted, matched or routed on,
 *   and translating one changes what the server is sent.
 * - Never inside `<script>` or `<style>`, never an EJS comment (`<%# %>`),
 *   and never anything an administrator wrote - that reaches a page through
 *   `<%- %>` as data, which this never touches.
 */

/** One string, as the catalogue holds it. */
export interface CatalogueEntry {
  /** The English, exactly as the view has it. It is also the lookup key. */
  text: string;
  /** What this is and where a reader meets it - written for a translator. */
  context: string;
  /** One view that has it, for somebody checking a word in place. */
  where: string;
  /** How many places use it. "Save" is one row, not fifty. */
  uses: number;
}

export interface Found {
  id: string;
  text: string;
  context: string;
}

/**
 * The id of a string: a hash of **the text alone**.
 *
 * Keyed by content, not by position, so the same word in forty views is one
 * row in the document and one translation - and an AI cannot render "Save"
 * forty different ways. A changed English string is a new id, which is what
 * should happen: it invalidates the translation it no longer matches.
 */
export function stringId(text: string): string {
  return 's' + crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
}

/** Tags whose contents are code, not words. */
const CODE_TAGS = new Set(['script', 'style']);

/**
 * Elements that sit *inside* a sentence. Text that touches one is a piece of
 * a longer run - "Tickets from <strong><%= name %></strong>" - and a piece
 * is not a string: "Tickets from" alone translates badly, and a translation
 * cannot move the name to where the grammar needs it. Those stay English
 * until something can carry the whole run.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'br', 'code', 'em', 'i', 'kbd', 'mark', 'small', 'span',
  'strong', 'sub', 'sup', 'time', 'u', 'wbr',
]);

/**
 * Whether the little element beside a string is decoration rather than words.
 *
 * `<a class="btn"><span aria-hidden="true">+</span> New account</a>` is the
 * shape of every create button here, and the rule above - "text touching
 * inline markup is half a run" - threw all of them away: the dialog title
 * was translated and the button that opens it was not (reported 16 Oct
 * 2026, "under Uzivatele new account, under Skupiny as well").
 *
 * A plus sign, a cross, a chevron: an element carrying `aria-hidden` or no
 * letter at all is not part of the sentence, so the words beside it are a
 * whole string. Anything that cannot be read - an element whose contents
 * are cut by an EJS tag - counts as words, which keeps the conservative
 * answer the conservative one.
 */
function isDecoration(openTag: string, inner: string): boolean {
  if (inner.includes('<')) return false;
  if (/aria-hidden\s*=\s*"true"/i.test(openTag)) return true;
  return !/\p{L}/u.test(inner);
}

/** What the element that closed at `closeAt` held, if it can be read. */
function closedBeforeText(html: string, closeAt: number, name: string): { open: string; inner: string } | null {
  const openAt = html.lastIndexOf('<' + name, closeAt);
  if (openAt < 0) return null;
  const openEnd = html.indexOf('>', openAt);
  if (openEnd < 0 || openEnd >= closeAt) return null;
  return { open: html.slice(openAt, openEnd + 1), inner: html.slice(openEnd + 1, closeAt) };
}

/** What the element opening at `openAt` holds, if it can be read. */
function openedNextText(html: string, openAt: number, name: string): { open: string; inner: string } | null {
  const openEnd = html.indexOf('>', openAt);
  if (openEnd < 0) return null;
  const closeAt = html.indexOf('</' + name, openEnd);
  if (closeAt < 0) return null;
  return { open: html.slice(openAt, openEnd + 1), inner: html.slice(openEnd + 1, closeAt) };
}

/** The attributes a reader hears or hovers over. */
const TEXT_ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

const ATTRIBUTE_PATTERN = new RegExp(
  '(' + TEXT_ATTRIBUTES.join('|') + ')="([^"<>]*)"',
  'g',
);

/** EJS tags of every kind, so the text between them can be found. */
const EJS_TAG = /<%[\s\S]*?%>/g;

/** Something a reader reads has a letter in it. */
function worthTranslating(text: string): boolean {
  const inner = text.trim();
  if (inner.length === 0 || inner.length > 400) return false;
  if (!/\p{L}/u.test(inner)) return false;
  /*
   * Anything holding an HTML entity is left alone - `&#9733; Default`, the
   * star beside the default relay.
   *
   * The view writes the entity, and `<%= %>` escapes what it prints, so
   * passing that text through t() turns the ampersand into `&amp;` and the
   * page reads "&#9733; Default" in full. Reported 16 Oct 2026, and it is
   * the one way this rewriting can change a page: the fix is to decline the
   * string. Write the character itself in the view if it should be
   * translatable.
   */
  if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(inner)) return false;
  return true;
}

/**
 * What to tell a translator about a string, worked out from the element it
 * sits in. This is the one thing the script cannot read off the page, and
 * it is what makes a translation read like an interface rather than a
 * dictionary.
 */
function contextFor(openTag: string, where: string, attribute?: string): string {
  const name = /^<\s*([a-zA-Z0-9-]+)/.exec(openTag)?.[1]?.toLowerCase() ?? '';
  const classes = /class="([^"]*)"/.exec(openTag)?.[1] ?? '';
  const has = (c: string) => classes.split(/\s+/).includes(c);
  const page = where.replace(/^views\//, '').replace(/\.ejs$/, '');

  let what = 'Text';
  if (attribute === 'placeholder') what = 'The grey example inside an input';
  else if (attribute === 'title') what = 'A tooltip';
  else if (attribute === 'aria-label') what = 'A label for a screen reader';
  else if (attribute === 'alt') what = 'The description of an image';
  else if (name === 'button' || (name === 'a' && has('btn'))) what = 'A button';
  else if (name === 'label') what = 'The label of a form field';
  else if (name === 'option') what = 'One choice in a dropdown';
  else if (name === 'th') what = 'A table column heading';
  else if (name === 'legend') what = 'The heading of a group of fields';
  else if (name === 'summary') what = 'A heading that opens and closes a panel';
  else if (/^h[1-6]$/.test(name)) what = 'A heading';
  else if (name === 'a') what = 'A link';
  else if (has('hint')) what = 'A note under a control';
  else if (has('lede')) what = 'The sentence under a heading';
  else if (has('visually-hidden')) what = 'Read only by a screen reader';
  else if (name === 'p' || name === 'span' || name === 'div' || name === 'li') what = 'Text on the page';

  return what + ' on ' + page;
}

/** A tag that decides *whether* something is drawn, not *what* it says. */
function isControl(tag: string): boolean {
  return tag.startsWith('<%') && !/^<%[=\-#]/.test(tag);
}

/**
 * The pieces of a view: EJS tags, and the HTML between them.
 *
 * Each piece says what sits on either side of it, because a piece bounded
 * by **control** tags - `<% if (x) { %>Open<% } %>` - holds a whole string
 * even though there is no tag to delimit it. Text beside an *output* tag is
 * a different matter: that is a run, and runsIn() reads it.
 */
function chunks(source: string): { html: string; at: number; before: string; after: string }[] {
  const out: { html: string; at: number; before: string; after: string }[] = [];
  let last = 0;
  let before = '';
  EJS_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EJS_TAG.exec(source))) {
    out.push({ html: source.slice(last, m.index), at: last, before, after: m[0] });
    before = m[0];
    last = m.index + m[0].length;
  }
  out.push({ html: source.slice(last), at: last, before, after: '' });
  return out;
}

/**
 * Words that are a joint, not a label.
 *
 * Between two control tags, " and " is the middle of a sentence somebody
 * built out of branches, and translating it alone produces word salad. A
 * label - "Open", "ticket(s)", "Not set" - is not in this list.
 */
const CONNECTORS = new Set([
  'and', 'or', 'of', 'to', 'in', 'on', 'for', 'by', 'with', 'from', 'at', 'the', 'a', 'an',
]);

/** A JavaScript string literal for the rewritten template. */
function literal(text: string): string {
  return (
    "'" +
    text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n') +
    "'"
  );
}

/**
 * Every place in one chunk of HTML that holds the reader's text.
 *
 * Each is a span of the chunk with the text and how to describe it. The two
 * callers differ only in what they do with the list.
 */
interface Place {
  start: number;
  end: number;
  text: string;
  context: string;
  attribute?: string;
}

function placesIn(html: string, where: string, carry = '', edges = { start: false, end: false }): Place[] {
  const found: Place[] = [];
  /*
   * A piece between two control tags is bounded by them: "Open" in
   * `<% if (x) { %>Open<% } %>` is a whole string, and without this it was
   * left in English because there was no '>' before it and no '<' after
   * (reported 16 Oct 2026, "everything that is currently in english ...
   * should be translated as well").
   *
   * The delimiters are added to a copy, and every position is mapped back.
   */
  const shift = edges.start ? 1 : 0;
  const text = (edges.start ? '>' : '') + html + (edges.end ? '<' : '');
  if (shift || edges.end) {
    return placesIn(text, where, carry)
      .filter((place) => {
        const word = place.text.trim().toLowerCase();
        return !CONNECTORS.has(word);
      })
      .map((place) => ({ ...place, start: place.start - shift, end: place.end - shift }))
      .filter((place) => place.start >= 0 && place.end <= html.length);
  }

  // A whole text node: ">...<", so both ends are inside this chunk. A run cut
  // by an EJS tag has no closing "<" and simply does not match, which is the
  // skip described at the top of the file.
  const node = />([^<>]*)</g;
  let m: RegExpExecArray | null;
  while ((m = node.exec(html))) {
    const inner = m[1] ?? '';
    if (!worthTranslating(inner)) continue;

    // The element this text sits in, and whether that element is code.
    const openAt = html.lastIndexOf('<', m.index);
    const openTag = openAt < 0 ? carry : html.slice(openAt, m.index + 1);
    const name = /^<\s*([a-zA-Z0-9-]+)/.exec(openTag)?.[1]?.toLowerCase() ?? '';
    if (CODE_TAGS.has(name)) continue;

    /*
     * Beside inline markup: a piece of a run, not a string of its own -
     * unless the markup is decoration, which the + on every create button
     * is.
     */
    const endsAt = m.index + 1 + inner.length;
    const after = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(html.slice(endsAt));
    const openedNext = after && !after[0].includes('/') ? after[1]!.toLowerCase() : '';
    const closedBefore = openTag.startsWith('</') ? openTag.slice(2).replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() : '';

    if (INLINE_TAGS.has(closedBefore)) {
      const held = closedBeforeText(html, openAt, closedBefore);
      if (!held || !isDecoration(held.open, held.inner)) continue;
    }
    if (INLINE_TAGS.has(openedNext)) {
      const held = openedNextText(html, endsAt, openedNext);
      if (!held || !isDecoration(held.open, held.inner)) continue;
    }

    const lead = /^\s*/.exec(inner)![0].length;
    const trail = /\s*$/.exec(inner)![0].length;
    found.push({
      start: m.index + 1 + lead,
      end: m.index + 1 + inner.length - trail,
      text: inner.slice(lead, inner.length - trail),
      context: contextFor(openTag, where),
    });
    // Overlapping matches share the "<" that ends one and opens the next.
    node.lastIndex = m.index + m[0].length - 1;
  }

  ATTRIBUTE_PATTERN.lastIndex = 0;
  while ((m = ATTRIBUTE_PATTERN.exec(html))) {
    const value = m[2] ?? '';
    if (!worthTranslating(value)) continue;
    const openAt = html.lastIndexOf('<', m.index);
    const openTag = openAt < 0 ? carry : html.slice(openAt, m.index);
    const start = m.index + (m[1]?.length ?? 0) + 2;
    found.push({
      start,
      end: start + value.length,
      text: value,
      context: contextFor(openTag, where, m[1]),
      attribute: m[1],
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/** The tag still open at the end of a chunk, for the chunk after it. */
function lastOpenTag(html: string, carry: string): string {
  const at = html.lastIndexOf('<');
  if (at < 0) return carry;
  const tag = html.slice(at);
  return /^<\s*[a-zA-Z0-9-]/.test(tag) ? tag : carry;
}

/**
 * A `t('...')` call written by hand inside an EJS tag.
 *
 * Some of a view's words are not text nodes: the sidebar builds each link
 * inside a `<% %>` block, so "New ticket" is an argument rather than
 * something between two tags, and the rewriter never sees it. Wrapping it in
 * `t()` where it is written is the answer, and this is what makes the
 * catalogue notice - so the document still covers everything without anybody
 * keeping a list (reported 16 Oct 2026, with a Czech page whose sidebar was
 * in English).
 *
 * Only a plain literal is read. `t(label)` is a variable and cannot be
 * known here, which is correct: a pinned dashboard's name is the person's
 * own text and is not translated.
 */
const T_CALL = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)/g;

/**
 * Two more ways a view hands over its own words, both read like `t()`:
 *
 * - `tx('Up to {0} files', [n])` - a sentence with values in it, as plain
 *   text, for a place that escapes what it is given (an attribute, the ⓘ).
 * - `include('.../info', { text: '...' })` - the ⓘ translates its own
 *   `text`, so its explanation only has to be found here.
 */
const TX_CALL = /\btx\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,/g;
const INFO_TEXT = /['/]info'\s*,\s*\{\s*text:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\}/g;

function callsIn(source: string, where: string): Found[] {
  const out: Found[] = [];
  const page = where.replace(/^views\//, '').replace(/\.ejs$/, '');
  EJS_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = EJS_TAG.exec(source))) {
    // Not a comment: <%# %> is a note to whoever reads the code.
    if (tag[0].startsWith('<%#')) continue;
    for (const pattern of [T_CALL, TX_CALL, INFO_TEXT]) {
      pattern.lastIndex = 0;
      let call: RegExpExecArray | null;
      while ((call = pattern.exec(tag[0]))) {
        const raw = call[1] ?? call[2] ?? '';
        const text = raw.replace(/\\(['"\\])/g, '$1');
        if (!worthTranslating(text)) continue;
        const context =
          pattern === TX_CALL
            ? 'Text on ' + page + '. Keep each {0}, {1}...: it is a value'
            : pattern === INFO_TEXT
              ? 'An explanation behind an (i) mark on ' + page
              : 'Text on ' + page;
        out.push({ id: stringId(text), text, context });
      }
    }
  }
  return out;
}

/**
 * A sentence with a value in it: "Last changed {0} by {1}".
 *
 * These are the strings the first version left in English, and they are
 * everywhere - "{0} subcategories", "Showing {0} tickets", "Last changed
 * {0} by {1}". Translating the halves separately is worse than leaving
 * them: "Last changed" and "by" are not sentences, and no translator can
 * put the value where their grammar needs it. A pattern can.
 *
 * What is matched: a text run between two tags holding only words and
 * `<%= %>` output tags. Deliberately **not**:
 *
 * - a run holding `<%- %>` (raw markup - escaping it would break it, and
 *   not escaping a translation would let one carry script onto the page);
 * - a run holding `<% %>` control flow, where there is no single sentence;
 * - a run with more than four values, or one whose own text already
 *   contains a `{0}`, which would make the pattern ambiguous.
 *
 * The values are **not translated** and never part of the pattern: they are
 * a name, a count, a date - the owner's "excluding variables of course".
 */
const MAX_PARTS = 4;

export interface RunPlace {
  start: number;
  end: number;
  /** The sentence with {0}, {1} where the values go. */
  pattern: string;
  /** The expressions, in order, exactly as the view wrote them. */
  parts: string[];
  context: string;
}

/** The output tag's expression, or null when it is anything else. */
function outputExpression(tag: string): string | null {
  const m = /^<%=([\s\S]*?)%>$/.exec(tag);
  return m ? (m[1] ?? '').trim() : null;
}

/**
 * Find the runs, by walking the pieces rather than with one big regular
 * expression.
 *
 * The first version was a regex - `>((?:[^<>]|<%=...%>)+)<` - and it
 * backtracked its way straight through an element's own attributes,
 * producing a `tr('...class="..."...')` that EJS could not compile. A page
 * that will not render is a worse bug than a sentence left in English, so
 * this walks the chunk list instead and can only ever see text that is
 * really text:
 *
 * - a run **starts** after the last `>` of a chunk (the end of an element's
 *   opening tag), with no `<` after it;
 * - it **continues** only across `<%= %>` output tags, over chunks holding
 *   no markup at all;
 * - it **ends** at the first `<` (the next tag), and nowhere else.
 */
export function runsIn(source: string, where: string): RunPlace[] {
  const pieces = chunks(source);
  const out: RunPlace[] = [];

  for (let i = 0; i < pieces.length; i += 1) {
    const head = pieces[i]!;
    const opens = head.html.lastIndexOf('>');
    if (opens < 0) continue;
    const lead = head.html.slice(opens + 1);
    if (lead.includes('<')) continue; // not text position
    // Only a real element tag ends a run's start: "%>"" is an EJS tag.
    if (head.html[opens - 1] === '%') continue;

    const parts: string[] = [];
    let pattern = lead;
    let j = i;
    let endAt = -1;

    // Walk forward: output tag, text, output tag, text... until a '<'.
    while (j < pieces.length - 1) {
      const expression = outputExpression(pieces[j]!.after);
      if (expression === null) break;
      const next = pieces[j + 1]!;
      const stop = next.html.indexOf('<');
      const text = stop < 0 ? next.html : next.html.slice(0, stop);
      if (text.includes('>')) break;
      parts.push(expression);
      pattern += '{' + (parts.length - 1) + '}' + text;
      j += 1;
      if (stop >= 0) {
        endAt = next.at + stop;
        break;
      }
    }

    if (endAt < 0 || parts.length === 0 || parts.length > MAX_PARTS) continue;
    if (/\{\d\}/.test(pattern.replace(/\{\d\}/g, ''))) continue;
    if (!worthTranslating(pattern.replace(/\{\d\}/g, ' '))) continue;

    const openTag = head.html.slice(head.html.lastIndexOf('<', opens), opens + 1);
    const name = /^<\s*([a-zA-Z0-9-]+)/.exec(openTag)?.[1]?.toLowerCase() ?? '';
    if (CODE_TAGS.has(name)) continue;

    const from = head.at + opens + 1;
    const leading = /^\s*/.exec(pattern)![0].length;
    const trailing = /\s*$/.exec(pattern)![0].length;
    out.push({
      start: from + leading,
      end: endAt - trailing,
      pattern: pattern.slice(leading, pattern.length - trailing),
      parts,
      context: contextFor(openTag, where),
    });
    i = j;
  }

  return out;
}

/** A sentence's values, as the rewritten template passes them. */
function partsLiteral(parts: string[]): string {
  return '[' + parts.join(', ') + ']';
}

/** Every string one view holds. */
export function scan(source: string, where: string): Found[] {
  const out: Found[] = [
    ...callsIn(source, where),
    ...runsIn(source, where).map((run) => ({
      id: stringId(run.pattern),
      text: run.pattern,
      context: run.context,
    })),
  ];
  let carry = '';
  for (const chunk of chunks(source)) {
    const edges = { start: isControl(chunk.before), end: isControl(chunk.after) };
    for (const place of placesIn(chunk.html, where, carry, edges)) {
      out.push({ id: stringId(place.text), text: place.text, context: place.context });
    }
    carry = lastOpenTag(chunk.html, carry);
  }
  return out;
}

/**
 * The same view, asking for each of those strings to be translated.
 *
 * `t()` is a template local; with no language it returns its argument, so
 * this is a no-op on an English service desk. The English stays **in the
 * call**, which is why a stale catalogue cannot empty a page: the view
 * carries its own fallback.
 */
export function rewrite(source: string, where: string): string {
  // Every place, in the source's own coordinates, left to right.
  const places: Place[] = [];
  let carry = '';
  for (const chunk of chunks(source)) {
    const edges = { start: isControl(chunk.before), end: isControl(chunk.after) };
    for (const place of placesIn(chunk.html, where, carry, edges)) {
      places.push({ ...place, start: chunk.at + place.start, end: chunk.at + place.end });
    }
    carry = lastOpenTag(chunk.html, carry);
  }
  /*
   * A sentence with values in it, as one string. `tr` escapes the pattern
   * and each value, so the output is already HTML - hence `<%- %>`.
   */
  const runs = runsIn(source, where).map((run) => ({
    start: run.start,
    end: run.end,
    code: '<%- tr(' + literal(run.pattern) + ', ' + partsLiteral(run.parts) + ') %>',
  }));

  const all = [
    ...places.map((place) => ({
      start: place.start,
      end: place.end,
      code: '<%= t(' + literal(place.text) + ') %>',
    })),
    ...runs,
  ].sort((a, b) => a.start - b.start);

  let out = '';
  let cursor = 0;
  for (const place of all) {
    if (place.start < cursor) continue; // Never replace inside a replacement.
    out += source.slice(cursor, place.start);
    out += place.code;
    cursor = place.end;
  }
  return out + source.slice(cursor);
}
