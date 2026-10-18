/**
 * Just enough CSV for an administrator's spreadsheet: RFC 4180 quoting,
 * CRLF or LF, a UTF-8 byte-order mark, and a comma *or* semicolon between
 * fields - Excel writes semicolons wherever the decimal separator is a comma,
 * which is most of Europe, so a file saved in Prague arrives that way.
 */

/** The separator the header line uses: a semicolon only if it has no comma. */
function delimiterOf(text: string): ',' | ';' {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  return firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
}

/** Rows of fields. Blank lines are dropped; fields are not trimmed here. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** One field, quoted when it has to be. */
export function csvField(value: string): string {
  return /[",;\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
}
