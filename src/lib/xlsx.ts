import { deflateRawSync } from 'node:zlib';

/**
 * A small Excel (.xlsx) writer: styled sheets, no dependency.
 *
 * An .xlsx file is a zip of a few XML files (Office Open XML). This writes
 * exactly what a report needs - several sheets, a title, a header row in the
 * brand colour, column widths, frozen headers, a filter on the header row,
 * numbers, dates and percentages as real Excel values - and nothing else:
 * no formulas, no shared strings (inline strings are valid and simpler).
 *
 * The zip is written here too: local headers, deflate from node:zlib, a
 * CRC-32 per file, the central directory. That is the whole of the format a
 * spreadsheet program needs, and it keeps the dependency list short.
 */

export type CellType = 'text' | 'number' | 'decimal' | 'percent' | 'date';

export interface Column {
  header: string;
  /** In characters, roughly. */
  width?: number;
  type?: CellType;
}

export interface Sheet {
  /** At most 31 characters; [ ] : * ? / \ are removed. */
  name: string;
  /** A bold line above the table, and lines of notes under it. */
  title?: string;
  notes?: string[];
  columns: Column[];
  rows: unknown[][];
}

// Style indices in styles.xml (cellXfs), in this order.
const S = { plain: 0, header: 1, title: 2, date: 3, number: 4, decimal: 5, percent: 6, note: 7 } as const;

const esc = (v: string) =>
  v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function colName(n: number): string {
  let s = '';
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Days since 1899-12-30, Excel's date serial. */
const excelDate = (d: Date) => d.getTime() / 86_400_000 + 25_569;

function cell(ref: string, value: unknown, type: CellType, style?: number): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'date') {
    const d = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(d.getTime())) return `<c r="${ref}" s="${style ?? S.date}"><v>${excelDate(d)}</v></c>`;
  }
  if ((type === 'number' || type === 'decimal' || type === 'percent') && Number.isFinite(Number(value))) {
    const s = style ?? (type === 'number' ? S.number : type === 'decimal' ? S.decimal : S.percent);
    return `<c r="${ref}" s="${s}"><v>${Number(value)}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const rows: string[] = [];
  let r = 1;
  if (sheet.title) {
    rows.push(`<row r="${r}" ht="22" customHeight="1">${cell('A' + r, sheet.title, 'text', S.title)}</row>`);
    r += 1;
    for (const note of sheet.notes ?? []) {
      rows.push(`<row r="${r}">${cell('A' + r, note, 'text', S.note)}</row>`);
      r += 1;
    }
    r += 1;
  }
  const headerRow = r;
  rows.push(`<row r="${r}" ht="20" customHeight="1">${sheet.columns.map((c, i) => cell(colName(i) + r, c.header, 'text', S.header)).join('')}</row>`);
  for (const values of sheet.rows) {
    r += 1;
    rows.push(`<row r="${r}">${sheet.columns.map((c, i) => cell(colName(i) + r, values[i], c.type ?? 'text')).join('')}</row>`);
  }
  const last = colName(Math.max(0, sheet.columns.length - 1));
  const cols = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? (c.type === 'date' ? 17 : Math.max(10, Math.min(48, c.header.length + 4)))}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${cols}</cols>
<sheetData>${rows.join('')}</sheetData>
${sheet.rows.length > 0 ? `<autoFilter ref="A${headerRow}:${last}${r}"/>` : ''}
</worksheet>`;
}

function stylesXml(headerColour: string): string {
  const argb = 'FF' + headerColour.replace('#', '').toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="15"/><color rgb="FF101828"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="10"/><color rgb="FF667085"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFEAECF0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

const sheetName = (name: string, used: Set<string>) => {
  let base = name.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = 2;
  let candidate = base;
  while (used.has(candidate.toLowerCase())) candidate = base.slice(0, 28) + ' ' + n++;
  used.add(candidate.toLowerCase());
  return candidate;
};

/** The workbook as bytes, ready to send as an .xlsx file. */
export function workbook(sheets: Sheet[], headerColour = '#101828'): Buffer {
  const used = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, used));
  const files: [string, string][] = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`],
    ['xl/styles.xml', stylesXml(/^#[0-9a-f]{6}$/i.test(headerColour) ? headerColour : '#101828')],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)] as [string, string]),
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

// ---------------------------------------------------------------------------
// Zip
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of whatever is given, for anything else that needs one.
 *
 * The writer below was built for .xlsx, which is a zip of XML; a full
 * export of the service desk is a zip of JSON and files, and that is the
 * same machinery rather than a dependency.
 */
export function zipFiles(files: [string, Buffer][]): Buffer {
  return zip(files);
}

function zip(files: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // A fixed timestamp (1980-01-01): the bytes do not depend on when.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, deflated);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}
