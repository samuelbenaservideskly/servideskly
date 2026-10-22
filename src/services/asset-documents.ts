import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { execute, query, queryOne } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { bracedInDocx, fillDocx, isDocx, variableName } from '../lib/docx.js';
import { openFile, sealFile } from '../lib/field-crypto.js';
import { docxToPdf } from '../lib/pdf-convert.js';
import { newId, nowIso } from '../lib/util.js';
import { getAsset, assetTitle, recordAssetEvent } from './assets.js';
import { attachmentLimits, formatBytes, sanitiseFilename, verifyType } from './attachments.js';
import { assetVariableNames, assetVariables } from './asset-variables.js';

/**
 * Documents with variables (step 5 of assets, 21 Oct 2026): a .docx an
 * administrator uploads under Settings - Assets - Documents, filled in for
 * one asset by an automation's "Email about the asset" and attached.
 *
 * - **Checked on upload**: every {{...}} in it is read (across Word's runs,
 *   as filling reads it) and any that is not a variable is listed beside the
 *   template - "{{Frist name}} is not a variable" - so a typo is found by the
 *   administrator, not by the person who receives the letter.
 * - **The variables are the asset's** (asset-variables.ts): every column by
 *   its key, the person's names and email, Company, Status, Today.
 * - **Sent as a PDF** when SOFFICE_PATH names LibreOffice (lib/pdf-convert.ts);
 *   otherwise as the filled .docx, and the run says which.
 * - **Every copy sent is kept** on the asset (kind 'generated'), so its page
 *   shows what went out and when. Files are sealed on disk like attachments.
 */

export const ASSET_FILE_DIR = path.join(config.uploadDir, 'asset-files');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

export interface AssetFileRow {
  id: string;
  kind: 'template' | 'generated';
  asset_id: string | null;
  name: string;
  content_type: string;
  byte_size: number;
  stored_name: string;
  doc_variables: string[];
  doc_problems: string[];
  created_by: string | null;
  created_at: string;
}

function rowOf(row: AssetFileRow): AssetFileRow {
  return {
    ...row,
    byte_size: Number(row.byte_size),
    doc_variables: Array.isArray(row.doc_variables) ? row.doc_variables : [],
    doc_problems: Array.isArray(row.doc_problems) ? row.doc_problems : [],
  };
}

async function store(bytes: Buffer): Promise<string> {
  await fs.mkdir(ASSET_FILE_DIR, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(path.join(ASSET_FILE_DIR, name), sealFile(bytes), { mode: 0o600, flag: 'wx' });
  return name;
}

export async function readAssetFile(row: Pick<AssetFileRow, 'stored_name'>): Promise<Buffer> {
  if (!/^[0-9a-f]{32}$/.test(row.stored_name)) throw new Error('bad stored name');
  return openFile(await fs.readFile(path.join(ASSET_FILE_DIR, row.stored_name)));
}

export async function findAssetFile(id: string): Promise<AssetFileRow | undefined> {
  const row = await queryOne<AssetFileRow>('SELECT * FROM asset_files WHERE id = ?', [id]);
  return row ? rowOf(row) : undefined;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listDocumentTemplates(): Promise<AssetFileRow[]> {
  return (await query<AssetFileRow>("SELECT * FROM asset_files WHERE kind = 'template' ORDER BY lower(name)")).map(rowOf);
}

/** What the document writes in double braces: the variables it uses, and what is not one. */
export async function checkTemplate(bytes: Buffer): Promise<{ variables: string[]; problems: string[] }> {
  const known = new Set(await assetVariableNames());
  const variables: string[] = [];
  const problems: string[] = [];
  for (const braced of bracedInDocx(bytes)) {
    const name = variableName(braced);
    if (name && known.has(name)) variables.push(name);
    else problems.push(braced + ' is not a variable');
  }
  return { variables: [...new Set(variables)].sort(), problems };
}

export async function addDocumentTemplate(
  fileName: string,
  bytes: Buffer,
  actor: { id: string } | null,
): Promise<AssetFileRow> {
  if (bytes.length > MAX_TEMPLATE_BYTES) throw badRequest('A document must be 5 MB or smaller.', 'too_large');
  if (!/\.docx$/i.test(fileName) || !isDocx(bytes)) throw badRequest('Upload a Word document (.docx).', 'not_docx');
  const checked = await checkTemplate(bytes);
  const name = fileName.replace(/\.docx$/i, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || 'Document';
  const id = newId();
  await execute(
    `INSERT INTO asset_files (id, kind, asset_id, name, content_type, byte_size, stored_name, doc_variables, doc_problems, created_by, created_at)
     VALUES (?, 'template', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, DOCX_TYPE, bytes.length, await store(bytes), JSON.stringify(checked.variables), JSON.stringify(checked.problems), actor?.id ?? null, nowIso()],
  );
  audit({ action: 'asset_document.added', actorId: actor?.id ?? null, targetType: 'asset_document', targetId: id, detail: { name, problems: checked.problems.length } });
  return (await findAssetFile(id))!;
}

export async function deleteDocumentTemplate(id: string, actor: { id: string } | null): Promise<void> {
  const row = await findAssetFile(id);
  if (!row || row.kind !== 'template') throw notFound('That document no longer exists.');
  await execute('DELETE FROM asset_files WHERE id = ?', [id]);
  await fs.rm(path.join(ASSET_FILE_DIR, row.stored_name), { force: true }).catch(() => undefined);
  audit({ action: 'asset_document.deleted', actorId: actor?.id ?? null, targetType: 'asset_document', targetId: id, detail: { name: row.name } });
}

// ---------------------------------------------------------------------------
// Filling one in
// ---------------------------------------------------------------------------

/** The copies sent about one asset, newest first. */
export async function listGeneratedFor(assetId: string): Promise<AssetFileRow[]> {
  return (await query<AssetFileRow>("SELECT * FROM asset_files WHERE kind = 'generated' AND asset_id = ? ORDER BY created_at DESC", [assetId])).map(rowOf);
}

/**
 * Fills a template in for an asset and keeps the copy on it: a PDF when
 * LibreOffice is there, else the .docx. Returns the stored copy.
 */
export async function generateDocument(
  templateId: string,
  assetId: string,
  actor: { id: string } | null,
): Promise<{ file: AssetFileRow; pdf: boolean }> {
  const template = await findAssetFile(templateId);
  if (!template || template.kind !== 'template') throw new Error('the document it attaches no longer exists');
  const asset = await getAsset(assetId);
  if (!asset) throw new Error('the asset no longer exists');
  const filled = fillDocx(await readAssetFile(template), await assetVariables(asset));
  const pdfBytes = await docxToPdf(filled);
  const bytes = pdfBytes ?? filled;
  const base = (template.name + ' - ' + assetTitle(asset)).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 150);
  const id = newId();
  await execute(
    `INSERT INTO asset_files (id, kind, asset_id, name, content_type, byte_size, stored_name, created_by, created_at)
     VALUES (?, 'generated', ?, ?, ?, ?, ?, ?, ?)`,
    [id, assetId, base + (pdfBytes ? '.pdf' : '.docx'), pdfBytes ? 'application/pdf' : DOCX_TYPE, bytes.length, await store(bytes), actor?.id ?? null, nowIso()],
  );
  return { file: (await findAssetFile(id))!, pdf: Boolean(pdfBytes) };
}

// ---------------------------------------------------------------------------
// Attachments: files people add to an asset (22 Oct 2026)
// ---------------------------------------------------------------------------

/** At most this many files on one asset. */
export const MAX_ASSET_ATTACHMENTS = 20;

export interface AssetAttachmentRow {
  id: string;
  asset_id: string;
  name: string;
  content_type: string;
  byte_size: number;
  stored_name: string;
  created_by: string | null;
  created_at: string;
  uploader_name?: string | null;
}

export async function listAssetAttachments(assetId: string): Promise<AssetAttachmentRow[]> {
  const rows = await query<AssetAttachmentRow>(
    `SELECT f.*, u.display_name AS uploader_name FROM asset_attachments f LEFT JOIN users u ON u.id = f.created_by
      WHERE f.asset_id = ? ORDER BY f.created_at DESC`,
    [assetId],
  );
  return rows.map((r) => ({ ...r, byte_size: Number(r.byte_size) }));
}

export async function findAssetAttachment(id: string): Promise<AssetAttachmentRow | undefined> {
  const row = await queryOne<AssetAttachmentRow>('SELECT * FROM asset_attachments WHERE id = ?', [id]);
  return row ? { ...row, byte_size: Number(row.byte_size) } : undefined;
}

/**
 * Adds files to an asset, checked as a ticket's attachments are: the type
 * from the file's own bytes (verifyType), the size limit from Settings -
 * Customisation - Attachments, and MAX_ASSET_ATTACHMENTS. Every file is
 * checked before any is stored, so a bad second file leaves nothing behind.
 */
export async function addAssetAttachments(
  assetId: string,
  files: readonly { originalname: string; buffer: Buffer }[],
  actor: { id: string } | null,
): Promise<number> {
  const asset = await getAsset(assetId);
  if (!asset) throw notFound('That asset no longer exists.');
  if (files.length === 0) throw badRequest('Choose at least one file.', 'no_file');
  const limits = attachmentLimits();
  if (!limits.enabled) throw badRequest('Attachments are switched off under Settings - Customisation - Attachments.', 'attachments_off');
  const existing = Number((await queryOne<{ n: number }>('SELECT count(*) AS n FROM asset_attachments WHERE asset_id = ?', [assetId]))?.n ?? 0);
  if (existing + files.length > MAX_ASSET_ATTACHMENTS) throw badRequest('An asset holds at most ' + MAX_ASSET_ATTACHMENTS + ' files.', 'too_many_files');
  const checked = files.map((file) => {
    const name = sanitiseFilename(file.originalname);
    if (file.buffer.length === 0) throw badRequest(name + ' is empty.', 'empty_file');
    if (file.buffer.length > limits.maxBytes) throw badRequest(name + ' is larger than ' + formatBytes(limits.maxBytes) + '.', 'file_too_large');
    const type = verifyType(name, file.buffer.subarray(0, 512));
    return { name, type, buffer: file.buffer };
  });
  for (const file of checked) {
    const stored = await store(file.buffer);
    await execute(
      'INSERT INTO asset_attachments (id, asset_id, name, content_type, byte_size, stored_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), assetId, file.name, file.type.contentType, file.buffer.length, stored, actor?.id ?? null, nowIso()],
    );
    await recordAssetEvent(assetId, actor, 'file', 'File', '', file.name);
  }
  audit({ action: 'asset.attachment.added', actorId: actor?.id ?? null, targetType: 'asset', targetId: assetId, detail: { files: checked.map((f) => f.name) } });
  return checked.length;
}

export async function deleteAssetAttachment(row: AssetAttachmentRow, actor: { id: string } | null): Promise<void> {
  await execute('DELETE FROM asset_attachments WHERE id = ?', [row.id]);
  if (/^[0-9a-f]{32}$/.test(row.stored_name)) await fs.rm(path.join(ASSET_FILE_DIR, row.stored_name), { force: true });
  await recordAssetEvent(row.asset_id, actor, 'file_removed', 'File', row.name, '');
  audit({ action: 'asset.attachment.deleted', actorId: actor?.id ?? null, targetType: 'asset', targetId: row.asset_id, detail: { file: row.name } });
}
