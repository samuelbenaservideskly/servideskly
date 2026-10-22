import { unzip } from './unzip.js';
import { zipFiles } from './xlsx.js';

/**
 * Filling the variables in a Word document (step 5 of assets, 21 Oct 2026):
 * an administrator writes {{FirstName}} in a buyout letter, and each copy
 * sent says the person's name.
 *
 * **Word splits text into runs where it likes** - a spell-check mark or a
 * change of formatting halfway through {{FirstName}} leaves "{{First" in one
 * <w:t> and "Name}}" in the next. So each paragraph's text is read as a whole,
 * the variables found in it, and each replacement written into the run where
 * the variable begins, emptying the runs it spanned. The first run's
 * formatting wins, which is what somebody who formatted the variable meant.
 *
 * Only the text of the body, headers, footers and notes is touched; every
 * other part of the file is copied as it was.
 */

const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
/** A variable as it may be written: {{FirstName}}, {{ FirstName }}. */
const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
/** Anything in double braces, to report what is not a variable ({{Frist name}}). */
const BRACED = /\{\{([^{}]{0,80})\}\}/g;

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface TextNode {
  /** Where the whole <w:t ...>text</w:t> sits in the paragraph's XML. */
  start: number;
  end: number;
  open: string;
  text: string;
}

function textNodes(paragraph: string): TextNode[] {
  const nodes: TextNode[] = [];
  const re = /(<w:t(?:\s[^>]*)?>)([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;
  for (const m of paragraph.matchAll(re)) {
    nodes.push({ start: m.index!, end: m.index! + m[0].length, open: m[1] ?? '<w:t>', text: decode(m[2] ?? '') });
  }
  return nodes;
}

/** Each paragraph of a part, with its text read across runs. */
function paragraphs(xml: string): { start: number; end: number; xml: string }[] {
  const out: { start: number; end: number; xml: string }[] = [];
  for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) out.push({ start: m.index!, end: m.index! + m[0].length, xml: m[0] });
  return out;
}

function fillParagraph(paragraph: string, values: Record<string, string>): string {
  const nodes = textNodes(paragraph);
  if (nodes.length === 0) return paragraph;
  const joined = nodes.map((n) => n.text).join('');
  if (!joined.includes('{{')) return paragraph;
  // Where each node's text starts in the joined text.
  const offsets: number[] = [];
  let at = 0;
  for (const n of nodes) {
    offsets.push(at);
    at += n.text.length;
  }
  const nodeAt = (pos: number) => {
    let i = 0;
    while (i + 1 < nodes.length && offsets[i + 1]! <= pos) i += 1;
    return i;
  };
  const texts = nodes.map((n) => n.text);
  // From the last to the first, so earlier offsets stay true.
  const matches = [...joined.matchAll(VARIABLE)].filter((m) => m[1]! in values).reverse();
  if (matches.length === 0) return paragraph;
  for (const m of matches) {
    const from = m.index!;
    const to = from + m[0].length;
    const first = nodeAt(from);
    const last = nodeAt(to - 1);
    const value = (values[m[1]!] ?? '').replace(/\s*\r?\n\s*/g, ' ');
    const head = texts[first]!.slice(0, from - offsets[first]!);
    if (first === last) {
      texts[first] = head + value + texts[first]!.slice(to - offsets[first]!);
    } else {
      texts[first] = head + value;
      for (let i = first + 1; i < last; i += 1) texts[i] = '';
      texts[last] = texts[last]!.slice(to - offsets[last]!);
    }
  }
  // Write the nodes back, last first; a changed one keeps its spaces.
  let out = paragraph;
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i]!;
    if (texts[i] === n.text) continue;
    const open = /xml:space=/.test(n.open) ? n.open : n.open.replace(/^<w:t/, '<w:t xml:space="preserve"');
    out = out.slice(0, n.start) + open + encode(texts[i]!) + '</w:t>' + out.slice(n.end);
  }
  return out;
}

function fillPart(xml: string, values: Record<string, string>): string {
  let out = xml;
  for (const p of paragraphs(xml).reverse()) {
    const filled = fillParagraph(p.xml, values);
    if (filled !== p.xml) out = out.slice(0, p.start) + filled + out.slice(p.end);
  }
  return out;
}

/** The document, with every known variable replaced. An unknown one is left as written. */
export function fillDocx(docx: Buffer, values: Record<string, string>): Buffer {
  const entries = unzip(docx);
  return zipFiles(entries.map(([name, content]) => (PARTS.test(name) ? [name, Buffer.from(fillPart(content.toString('utf8'), values), 'utf8')] : [name, content])));
}

/**
 * Everything written in double braces in the document, as written - read
 * across runs, as filling reads it - for the upload check.
 */
export function bracedInDocx(docx: Buffer): string[] {
  const found = new Set<string>();
  for (const [name, content] of unzip(docx)) {
    if (!PARTS.test(name)) continue;
    for (const p of paragraphs(content.toString('utf8'))) {
      const text = textNodes(p.xml).map((n) => n.text).join('');
      for (const m of text.matchAll(BRACED)) found.add(m[0]);
    }
  }
  return [...found];
}

/** Whether the bytes are a Word document at all: a zip holding word/document.xml. */
export function isDocx(bytes: Buffer): boolean {
  try {
    return unzip(bytes).some(([name]) => name === 'word/document.xml');
  } catch {
    return false;
  }
}

/** The variable a braced text names, if it is a well-formed one: "{{ FirstName }}" gives FirstName. */
export function variableName(braced: string): string | null {
  const m = /^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/.exec(braced);
  return m ? m[1]! : null;
}
