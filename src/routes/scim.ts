import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { config } from '../config.js';
import { asyncHandler } from '../lib/async-handler.js';
import { logger } from '../lib/logger.js';
import { settings } from '../settings/index.js';
import {
  ScimError,
  SCIM_ERROR_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_USER_SCHEMA,
  applyScimPatch,
  countScimUsers,
  createScimUser,
  deleteScimUser,
  findByFilter,
  findScimUser,
  listScimUsers,
  parseScimFilter,
  readScimUser,
  toScimUser,
  tokenIsValid,
  updateScimUser,
} from '../services/scim.js';

const log = logger.child({ module: 'routes/scim' });

/**
 * The SCIM 2.0 endpoint Entra ID provisions against.
 *
 * Mounted before sessions, CSRF and the global rate limiter: this is a
 * machine-to-machine API authenticated by a bearer token, it must not allocate
 * a session, and a provisioning cycle can be a few hundred requests in a
 * burst. It carries its own authentication and its own limits instead.
 *
 * Base URL to paste into Entra: {APP_BASE_URL}/scim/v2
 */
export const scimRouter = Router();

const CONTENT_TYPE = 'application/scim+json; charset=utf-8';

function baseUrl(): string {
  return config.publicOrigin + '/scim/v2';
}

function sendScim(res: Response, status: number, body: unknown): void {
  res.status(status).type(CONTENT_TYPE).send(JSON.stringify(body));
}

function sendError(res: Response, status: number, detail: string, scimType?: string): void {
  sendScim(res, status, {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  });
}

// Entra sends application/scim+json; some tooling sends application/json.
scimRouter.use(
  express.json({ type: ['application/scim+json', 'application/json'], limit: '1mb' }),
);

/**
 * Bearer authentication.
 *
 * Deliberately uniform: a missing, malformed, wrong or revoked token all
 * produce the same 401, so the response cannot be used to probe whether SCIM
 * is configured at all.
 */
scimRouter.use((req: Request, res: Response, next: NextFunction) => {
  const header = req.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !tokenIsValid(match[1]!.trim())) {
    log.warn(
      { path: req.path, method: req.method, ip: req.ip },
      'SCIM request refused: bad or missing bearer token',
    );
    res.set('WWW-Authenticate', 'Bearer realm="scim"');
    sendError(res, 401, 'A valid bearer token is required.');
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

scimRouter.get('/ServiceProviderConfig', (_req, res) => {
  sendScim(res, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: config.publicOrigin + '/',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'Authentication by a bearer token issued in Admin -> Settings.',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: baseUrl() + '/ServiceProviderConfig' },
  });
});

scimRouter.get('/ResourceTypes', (_req, res) => {
  sendScim(res, 200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 1,
    itemsPerPage: 1,
    startIndex: 1,
    Resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: SCIM_USER_SCHEMA,
        meta: { resourceType: 'ResourceType', location: baseUrl() + '/ResourceTypes/User' },
      },
    ],
  });
});

scimRouter.get('/Schemas', (_req, res) => {
  sendScim(res, 200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 1,
    itemsPerPage: 1,
    startIndex: 1,
    Resources: [
      {
        id: SCIM_USER_SCHEMA,
        name: 'User',
        description: 'A person who can sign in and raise tickets.',
        attributes: [
          { name: 'userName', type: 'string', required: true, uniqueness: 'server' },
          { name: 'displayName', type: 'string', required: false },
          { name: 'active', type: 'boolean', required: false },
          { name: 'emails', type: 'complex', multiValued: true, required: false },
        ],
        meta: { resourceType: 'Schema', location: baseUrl() + '/Schemas/' + SCIM_USER_SCHEMA },
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

scimRouter.get(
  '/Users',
  asyncHandler(async (req, res) => {
    const filter = typeof req.query.filter === 'string' ? req.query.filter : '';
    const startIndex = Math.max(Number(req.query.startIndex ?? 1) || 1, 1);
    const count = Math.min(Math.max(Number(req.query.count ?? 100) || 100, 1), 200);

    if (filter) {
      const rows = await findByFilter(parseScimFilter(filter));
      sendScim(res, 200, {
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: rows.length,
        itemsPerPage: rows.length,
        startIndex: 1,
        Resources: rows.map((row) => toScimUser(row, baseUrl())),
      });
      return;
    }

    const [rows, total] = await Promise.all([
      listScimUsers(startIndex, count),
      countScimUsers(),
    ]);
    sendScim(res, 200, {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      itemsPerPage: rows.length,
      startIndex,
      Resources: rows.map((row) => toScimUser(row, baseUrl())),
    });
  }),
);

scimRouter.get(
  '/Users/:id',
  asyncHandler(async (req, res) => {
    const row = await findScimUser(String(req.params.id));
    if (!row) throw new ScimError(404, 'No such user.');
    sendScim(res, 200, toScimUser(row, baseUrl()));
  }),
);

scimRouter.post(
  '/Users',
  asyncHandler(async (req, res) => {
    const input = readScimUser((req.body ?? {}) as Record<string, unknown>);
    const created = await createScimUser(input);
    res.set('Location', baseUrl() + '/Users/' + created.id);
    sendScim(res, 201, toScimUser(created, baseUrl()));
  }),
);

scimRouter.put(
  '/Users/:id',
  asyncHandler(async (req, res) => {
    const existing = await findScimUser(String(req.params.id));
    if (!existing) throw new ScimError(404, 'No such user.');
    const input = readScimUser((req.body ?? {}) as Record<string, unknown>);
    const updated = await updateScimUser(existing, input, { replace: true });
    sendScim(res, 200, toScimUser(updated, baseUrl()));
  }),
);

scimRouter.patch(
  '/Users/:id',
  asyncHandler(async (req, res) => {
    const existing = await findScimUser(String(req.params.id));
    if (!existing) throw new ScimError(404, 'No such user.');
    const input = applyScimPatch((req.body ?? {}) as Record<string, unknown>);
    const updated = await updateScimUser(existing, input, { replace: false });
    sendScim(res, 200, toScimUser(updated, baseUrl()));
  }),
);

scimRouter.delete(
  '/Users/:id',
  asyncHandler(async (req, res) => {
    const existing = await findScimUser(String(req.params.id));
    if (!existing) throw new ScimError(404, 'No such user.');
    await deleteScimUser(existing);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Groups are answered, not provisioned.
 *
 * Entra probes /Groups even when only users are in scope, and a 404 there
 * makes it log errors against an otherwise healthy job. An empty list is the
 * honest answer: this service has no groups, because group membership grants
 * nothing here - roles are assigned under Admin -> Users.
 */
scimRouter.get('/Groups', (_req, res) => {
  sendScim(res, 200, {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 0,
    itemsPerPage: 0,
    startIndex: 1,
    Resources: [],
  });
});

scimRouter.all(['/Groups', '/Groups/*'], (_req, res) => {
  sendError(
    res,
    501,
    'Group provisioning is not supported. Assign the group to the application so its ' +
      'members are provisioned as users, and leave group provisioning off in the mapping.',
    'notImplemented',
  );
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

scimRouter.use((_req, res) => {
  sendError(res, 404, 'No such SCIM resource.');
});

/**
 * SCIM has its own error document, so this router cannot fall through to the
 * HTML error handler - Entra would surface a page of markup as the failure.
 */
scimRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ScimError) {
    if (err.status >= 500) log.error({ err }, 'SCIM request failed');
    sendError(res, err.status, err.message, err.scimType);
    return;
  }
  if (err instanceof SyntaxError) {
    sendError(res, 400, 'The request body was not valid JSON.', 'invalidSyntax');
    return;
  }
  log.error({ err }, 'unhandled SCIM error');
  sendError(res, 500, 'The request could not be processed.');
});

/** True when SCIM is switched on and has a token. */
export function scimReady(): boolean {
  const scim = settings().scim;
  return scim.enabled && scim.configured;
}
