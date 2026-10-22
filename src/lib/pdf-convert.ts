import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';

const log = logger.child({ module: 'pdf' });

/**
 * A Word document as a PDF, through LibreOffice (step 5 of assets, 21 Oct
 * 2026). There is no faithful Word-to-PDF in Node itself, so this is the
 * one outside program the service desk can use: `SOFFICE_PATH` names it
 * (for example /usr/bin/soffice, or C:\Program Files\LibreOffice\program\soffice.exe).
 *
 * - **Unset, or failing, gives null**, and the caller sends the .docx
 *   instead and says so: a document a little less tidy beats no document.
 * - Each conversion gets a temporary folder and its own LibreOffice
 *   profile, so two at once cannot lock each other out; a minute at most.
 * - The file name is ours (document.docx), never the uploaded one, and the
 *   program is started without a shell.
 */

export const pdfAvailable = (): boolean => Boolean(process.env.SOFFICE_PATH?.trim());

export async function docxToPdf(docx: Buffer): Promise<Buffer | null> {
  const soffice = process.env.SOFFICE_PATH?.trim();
  if (!soffice) return null;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'helpdesk-pdf-'));
  try {
    const input = path.join(dir, 'document.docx');
    await writeFile(input, docx);
    await new Promise<void>((resolve, reject) => {
      execFile(
        soffice,
        [
          '-env:UserInstallation=' + pathToFileURL(path.join(dir, 'profile')).href,
          '--headless',
          '--norestore',
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          input,
        ],
        { timeout: 60_000, windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    return await readFile(path.join(dir, 'document.pdf'));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'the document could not be made a PDF; sending the .docx');
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
