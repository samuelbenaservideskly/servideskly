import express, { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { IncomingAttachment } from '../services/mail/transport.js';
import type { ApiKeyRow } from '../services/api-keys.js';
import type { AutomationRow } from '../services/automation.js';
import { audit } from '../lib/audit.js';
import { ticketReference } from '../lib/util.js';
import { logger } from '../lib/logger.js';
import { queryOne } from '../db/index.js';
import { apiKeyGuessLimiter, hookLimiter } from '../middleware/security.js';
import { findAutomation, isHttpTriggered, runAutomation } from '../services/automation.js';
import { forbiddenSteps, keyForSecret, markKeyUsed } from '../services/api-keys.js';
import type { StepOutput } from '../services/automation-http.js';

const log = logger.child({ module: 'hooks' });

/**
 * POST /hooks/automations/:id - another system starts an automation whose
 * trigger is "An HTTP request is received".
 *
 * A machine API like SCIM: bearer key, no session, no CSRF, JSON in and
 * JSON out, mounted ahead of the browser pipeline. It is not a general API:
 * one automation per URL, the key named on its trigger, and only the steps
 * that key was given.
 *
 * Every refusal is one of a few answers, so a caller probing for which
 * automations exist learns nothing: 401 for a key that does not open this
 * automation (including one that does not exist), 404 for a ticket that does
 * not exist, 403 for one the key may not touch.
 *
 * "ticket" is optional: without it the steps have no ticket until a "Create
 * a ticket" step makes one, and a step that needs one stops the run.
 *
 * **Files** come two ways, for an "Attach the files from the request" step:
 * in JSON as `"files": [{"name": "x.png", "content": "<base64>"}]`, or as a
 * multipart/form-data upload (what Postman's form-data sends), whose other
 * fields read like JSON ones. The key is checked **before** the body is read,
 * so a large body is only ever read for a caller who holds a key.
 */
export const hooksRouter = Router();

hooksRouter.use(hookLimiter);
// Refused keys (401) are counted per address: ten in fifteen minutes, then 429.
hooksRouter.use(apiKeyGuessLimiter);

/** Base64 adds a third: room for a few files at the attachment limit. */
const JSON_LIMIT = '35mb';
const MAX_FILES = 10;
/** Per file: the store refuses anything over the configured limit, with a note. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/**
 * The whole multipart body. Files are held in memory until stored, so this is
 * what one request may cost: well inside a 1.75 GB plan, where 20 files of
 * 100 MB once allowed a single request to exhaust it.
 */
const MAX_MULTIPART_BYTES = 60 * 1024 * 1024;

const jsonBody = express.json({ type: ['application/json', 'application/*+json'], limit: JSON_LIMIT });
const multipartBody = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES, fields: 50, fieldSize: 64 * 1024 },
}).any();

interface Opened {
  key: ApiKeyRow;
  automation: AutomationRow;
}

/** The key and the automation it opens - from the URL and the header alone. */
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.get('authorization') ?? '';
    const secret = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
    const [key, automation] = await Promise.all([keyForSecret(secret), findAutomation(String(req.params.id))]);
    const trigger = automation?.graph.nodes.find((n) => n.type === 'trigger');
    if (!key || !automation || !isHttpTriggered(automation.graph) || trigger?.config.apiKeyId !== key.id) {
      refuse(res, 401, 'Access denied.');
      return;
    }
    res.locals.opened = { key, automation } satisfies Opened;
    next();
  } catch (err) {
    next(err);
  }
}

/** JSON or multipart, read only after the key has been checked. */
function readBody(req: Request, res: Response, next: NextFunction): void {
  if (req.is('multipart/form-data')) {
    // Refused before a byte is read when the request says it is larger.
    if (Number(req.get('content-length') ?? 0) > MAX_MULTIPART_BYTES) {
      refuse(res, 413, 'The upload is too large: at most ' + MAX_MULTIPART_BYTES / 1024 / 1024 + ' MB per request.');
      return;
    }
    multipartBody(req, res, next);
  }
  else jsonBody(req, res, next);
}

/** The files a request carried, from either way of sending them. */
function filesOf(req: Request, fields: Record<string, unknown>): IncomingAttachment[] {
  const out: IncomingAttachment[] = [];
  for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) {
    out.push({ filename: f.originalname || 'file', contentType: f.mimetype || '', content: f.buffer, cid: '', inline: false });
  }
  const listed = Array.isArray(fields.files) ? fields.files.slice(0, MAX_FILES) : [];
  for (const raw of listed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const content = typeof r.content === 'string' ? r.content.replace(/\s+/g, '') : '';
    // Not base64 at all: an empty file, which the store refuses with a note.
    const bytes = /^[A-Za-z0-9+/=_-]*$/.test(content) ? Buffer.from(content, content.includes('-') || content.includes('_') ? 'base64url' : 'base64') : Buffer.alloc(0);
    out.push({
      filename: typeof r.name === 'string' && r.name ? r.name : 'file',
      contentType: typeof r.contentType === 'string' ? r.contentType : '',
      content: bytes,
      cid: '',
      inline: false,
    });
  }
  return out;
}

function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/** A reference such as INC-000123, or a ticket id. */
export async function ticketFor(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  const ref = /^([A-Za-z0-9]{1,8})-(\d{1,12})$/.exec(value.trim());
  if (ref) {
    const row = await queryOne<{ id: string }>(
      'SELECT id FROM tickets WHERE lower(ref_prefix) = lower(?) AND ref_seq = ?',
      [ref[1], Number.parseInt(ref[2]!, 10)],
    );
    return row?.id;
  }
  return (await queryOne<{ id: string }>('SELECT id FROM tickets WHERE id = ?', [value.trim()]))?.id;
}

hooksRouter.post('/automations/:id', authenticate, readBody, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key, automation } = res.locals.opened as Opened;
    await markKeyUsed(key.id);
    if (!automation.is_enabled) {
      refuse(res, 409, 'This automation is switched off.');
      return;
    }
    // Narrowed since it was switched on: refuse before anything runs.
    const refused = forbiddenSteps(key, automation.graph.nodes.map((n) => n.type));
    if (refused.length > 0) {
      refuse(res, 403, 'The key may not run every step of this automation.');
      return;
    }

    const body: unknown = req.body;
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const files = filesOf(req, fields);
    // What later steps can read: everything sent, with each file as its name
    // and size - never its bytes, which would fill the run log.
    const readable: Record<string, unknown> = { ...fields };
    if (files.length > 0) readable.files = files.map((f) => ({ name: f.filename, size: f.content.byteLength }));
    let ticketId: string | null = null;
    if (fields.ticket !== undefined && fields.ticket !== null && fields.ticket !== '') {
      ticketId = (await ticketFor(fields.ticket)) ?? null;
      if (!ticketId) {
        refuse(res, 404, 'There is no such ticket.');
        return;
      }
      // A key limited to some templates touches only their tickets - and a
      // ticket it may not touch reads the same as one that is not there.
      if (key.template_ids.length > 0) {
        const t = await queryOne<{ template_id: string | null }>('SELECT template_id FROM tickets WHERE id = ?', [ticketId]);
        if (!t?.template_id || !key.template_ids.includes(t.template_id)) {
          refuse(res, 404, 'There is no such ticket.');
          return;
        }
      }
    }

    const request: StepOutput = {
      status: 200,
      ok: true,
      body: JSON.stringify(readable),
      json: readable,
      headers: { 'content-type': req.get('content-type') ?? '' },
      error: '',
    };
    const result = await runAutomation(automation, ticketId, { request, allowed: key.allowed_actions, templates: key.template_ids, files });
    audit({
      action: 'automation.http_started',
      outcome: result.outcome === 'failure' ? 'failure' : 'success',
      actorId: null,
      targetType: 'automation',
      targetId: automation.id,
      detail: { key: key.name, ticketId },
    });
    // The ticket the run ended on - the one it created, when it created one.
    const last = await queryOne<{ ticket_id: string | null }>(
      'SELECT ticket_id FROM automation_runs WHERE automation_id = ? ORDER BY ran_at DESC LIMIT 1',
      [automation.id],
    );
    const ref = last?.ticket_id
      ? await queryOne<{ ref_prefix: string; ref_seq: number }>('SELECT ref_prefix, ref_seq FROM tickets WHERE id = ?', [last.ticket_id])
      : undefined;
    // A step needed a ticket the request did not name: the caller's mistake.
    const noTicket = result.outcome === 'failure' && result.steps.some((x) => x.includes('needs a ticket'));
    if (noTicket) {
      refuse(res, 400, 'Name the ticket: {"ticket": "INC-000123"}, or start with a "Create a ticket" step.');
      return;
    }
    res.status(result.outcome === 'failure' ? 500 : 200).json({
      outcome: result.outcome,
      ...(ref ? { ticket: ticketReference(Number(ref.ref_seq), ref.ref_prefix) } : {}),
    });
  } catch (err) {
    next(err);
  }
});

hooksRouter.use((_req: Request, res: Response) => refuse(res, 404, 'Not found.'));

// A malformed JSON body, or anything else: JSON, never the HTML error page.
hooksRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) log.error({ err }, 'hook failed');
  if (err instanceof multer.MulterError) {
    refuse(res, 413, err.code === 'LIMIT_FILE_COUNT' ? 'At most ' + MAX_FILES + ' files per request.' : 'The upload is too large.');
    return;
  }
  refuse(res, status, status === 400 ? 'The body is not valid JSON.' : status === 413 ? 'The body is too large.' : 'Something went wrong.');
});
