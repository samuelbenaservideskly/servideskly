import './env.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before, describe } from 'node:test';
import { bootstrapTestDatabase } from './support/bootstrap.js';
import { signInAs, type TestSession } from './support/session.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db/index.js';
import {
  addNode,
  configureNode,
  connect,
  createAutomation,
  findAutomation,
  graphProblems,
  recentRuns,
  setAutomationEnabled,
  settleAutomations,
} from '../src/services/automation.js';
import { httpStepProblem, setRetryBaseForTests } from '../src/services/automation-http.js';
import { accessToken, clearTokenCache, createConnection, findConnection } from '../src/services/automation-connections.js';
import { isPrivateAddress, sendHttp } from '../src/services/http-client.js';
import { createTicket } from '../src/services/tickets.js';
import { updateSettings } from '../src/settings/index.js';

let admin: TestSession;
let requester: TestSession;
let server: http.Server;
let base = '';

/** What the fake API saw. */
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let tokensIssued = 0;
let rejectNextBearer = false;

before(async () => {
  await bootstrapTestDatabase();
  createApp();
  admin = await signInAs('http.admin@example.com', 'admin');
  requester = await signInAs('http.requester@example.com', 'user');

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        const form = new URLSearchParams(body);
        const basic = req.headers.authorization === 'Basic ' + Buffer.from('cid:s%3Acret').toString('base64');
        const inBody = form.get('client_id') === 'cid' && form.get('client_secret') === 's:cret';
        if (form.get('grant_type') !== 'client_credentials' || !(basic || inBody)) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid_client', error_description: 'secret s:cret was wrong' }));
          return;
        }
        tokensIssued += 1;
        res.end(JSON.stringify({ access_token: 'tok-' + tokensIssued, token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      if (req.url?.startsWith('/secure')) {
        const ok = req.headers.authorization === 'Bearer tok-' + tokensIssued && !rejectNextBearer;
        rejectNextBearer = false;
        res.statusCode = ok ? 200 : 401;
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (req.url?.startsWith('/flaky')) {
        flakyCalls += 1;
        res.statusCode = flakyCalls < 3 ? 503 : 200;
        if (flakyCalls === 1) res.setHeader('retry-after', '1');
        res.end('{"try": ' + flakyCalls + '}');
        return;
      }
      if (req.url?.startsWith('/fail')) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ id: 'EXT-42', nested: { list: [{ name: 'first' }] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

/** Raises a ticket and waits for the automations it set off in the background. */
async function raise(title: string) {
  const ticket = await createTicket({ title, description: 'Raised by the HTTP tests.', priority: 'normal', category: 'other', requesterId: requester.user.id });
  await settleAutomations();
  return ticket;
}

let flakyCalls = 0;

async function triggerOf(id: string) {
  return (await findAutomation(id))!.graph.nodes.find((n) => n.type === 'trigger')!.id;
}

describe('the transport refuses what it must', () => {
  test('private and metadata addresses are private', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0']) {
      assert.equal(isPrivateAddress(a), true, a);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(a), false, a);
  });

  test('a private address, plain http or a credential in the URL is refused', async () => {
    await assert.rejects(
      sendHttp({ method: 'GET', url: new URL(base + '/x'), headers: {}, timeoutMs: 2000 }, { allowPrivate: false }),
      /only https|private network/,
    );
    await assert.rejects(
      sendHttp({ method: 'GET', url: new URL('https://127.0.0.1/x'), headers: {}, timeoutMs: 2000 }, { allowPrivate: false }),
      /private network/,
    );
    await assert.rejects(
      sendHttp({ method: 'GET', url: new URL('https://localhost/x'), headers: {}, timeoutMs: 2000 }, { allowPrivate: false }),
      /private network/,
    );
    await assert.rejects(
      sendHttp({ method: 'GET', url: new URL('https://u:p@example.com/'), headers: {}, timeoutMs: 2000 }, { allowPrivate: true }),
      /credentials/,
    );
  });

  test('settings are checked before a step can run', () => {
    const ok = { method: 'POST', url: 'https://api.example.com/items/{{ticket.reference}}', bodyType: 'json', body: '{"t": "{{ticket.title}}"}' };
    assert.equal(httpStepProblem(ok, false), '');
    assert.match(httpStepProblem({ ...ok, url: 'https://{{ticket.title}}.example.com/' }, false), /host cannot contain a variable/);
    assert.match(httpStepProblem({ ...ok, headers: 'Authorization: Bearer x' }, false), /credentials/);
    assert.match(httpStepProblem({ ...ok, body: '{"t": {{ticket.title}}}' }, false), /not valid JSON/);
    assert.match(httpStepProblem({ ...ok, timeout: '90' }, false), /timeout/);
    assert.match(httpStepProblem({ ...ok, body: '{"t": "{{nope.status}}"}' }, false), /unknown variable/);
    assert.match(httpStepProblem(ok, true), /connection/);
  });
});

describe('Send HTTP request', () => {
  before(async () => {
    await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
  });

  test('sends method, query, headers and an encoded JSON body; later steps read the answer', async () => {
    const a = await createAutomation('Create upstream', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request', 300, 100, null);
    await configureNode(a.id, call, {
      method: 'POST',
      url: base + '/items/{{ticket.reference}}',
      query: 'source=desk\nwho={{ticket.requester_email}}',
      headers: 'X-Trace: {{ticket.title}}',
      bodyType: 'json',
      body: '{"title": "{{ticket.title}}", "priority": "{{ticket.priority}}"}',
      timeout: '5',
      output: 'upstream',
    }, null);
    const check = await addNode(a.id, 'if', 500, 100, null);
    await configureNode(a.id, check, { field: 'variable', variable: 'upstream.status', op: 'equals', value: '201' }, null);
    const note = await addNode(a.id, 'add_comment', 700, 100, null);
    await configureNode(a.id, note, { body: 'Linked as {{upstream.json.id}} ({{upstream.json.nested.list.0.name}}).', internal: 'on' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await connect(a.id, call, 'next', check, null);
    await connect(a.id, check, 'true', note, null);
    assert.deepEqual(graphProblems((await findAutomation(a.id))!.graph), []);
    await setAutomationEnabled(a.id, true, null);

    seen.length = 0;
    const ticket = await raise('Printer "3rd floor"\nis on fire');
    const req = seen.find((s) => s.url.startsWith('/items/'))!;
    assert.equal(req.method, 'POST');
    assert.match(req.url, /^\/items\/[A-Z]+-\d+\?source=desk&who=http.requester%40example.com$/);
    assert.equal(req.headers['x-trace'], 'Printer "3rd floor" is on fire');
    assert.deepEqual(JSON.parse(req.body), { title: 'Printer "3rd floor"\nis on fire', priority: 'normal' });

    const comments = await query<{ body: string }>('SELECT body FROM ticket_comments WHERE ticket_id = ?', [ticket.id]);
    assert.equal(comments[0]?.body, 'Linked as EXT-42 (first).');
    const runs = await recentRuns(a.id);
    assert.equal(runs[0]?.outcome, 'success');
    assert.doesNotMatch(runs[0]!.steps, /source=desk/, 'the query is never logged');
    await setAutomationEnabled(a.id, false, null);
  });

  test('a failure stops the run, unless told to continue', async () => {
    const a = await createAutomation('Flaky upstream', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request', 300, 100, null);
    await configureNode(a.id, call, { method: 'GET', url: base + '/fail', output: 'up' }, null);
    const note = await addNode(a.id, 'add_comment', 500, 100, null);
    await configureNode(a.id, note, { body: 'Upstream said {{up.status}} ({{up.ok}}).', internal: 'on' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await connect(a.id, call, 'next', note, null);
    await setAutomationEnabled(a.id, true, null);

    const first = await raise('First');
    assert.equal((await recentRuns(a.id))[0]?.outcome, 'failure');
    assert.equal((await query('SELECT id FROM ticket_comments WHERE ticket_id = ?', [first.id])).length, 0);

    await configureNode(a.id, call, { method: 'GET', url: base + '/fail', output: 'up', onError: 'continue' }, null);
    const second = await raise('Second');
    assert.equal((await recentRuns(a.id))[0]?.outcome, 'success');
    const comments = await query<{ body: string }>('SELECT body FROM ticket_comments WHERE ticket_id = ?', [second.id]);
    assert.equal(comments[0]?.body, 'Upstream said 503 (false).');
    await setAutomationEnabled(a.id, false, null);
  });

  test('with the private network not allowed, the step is refused', async () => {
    await updateSettings({ httpRequests: { allowPrivateNetwork: false } }, null);
    const a = await createAutomation('Blocked', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request', 300, 100, null);
    await configureNode(a.id, call, { method: 'GET', url: base + '/x' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);
    seen.length = 0;
    await raise('Blocked');
    assert.equal(seen.length, 0);
    const run = (await recentRuns(a.id))[0]!;
    assert.equal(run.outcome, 'failure');
    assert.match(run.steps, /refused/);
    await setAutomationEnabled(a.id, false, null);
    await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
  });
});

describe('Send authenticated HTTP request', () => {
  let connectionId = '';

  before(async () => {
    await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
    clearTokenCache();
  });

  test('a connection keeps its secret sealed and never shows it', async () => {
    connectionId = await createConnection(
      { name: 'Upstream', authType: 'oauth2', headerName: '', valuePrefix: '', tokenUrl: base + '/token', clientId: 'cid', clientSecret: 's:cret', scope: 'api.write', audience: '', clientAuth: 'basic' },
      admin.user.id,
    );
    const stored = await query<{ client_secret: string }>('SELECT client_secret FROM automation_connections WHERE id = ?', [connectionId]);
    assert.doesNotMatch(stored[0]!.client_secret, /s:cret/);
    const shown = await findConnection(connectionId);
    assert.equal(shown?.hasSecret, true);
    assert.equal((shown as unknown as Record<string, unknown>).client_secret, undefined);
    const audit = await query<{ detail: string }>("SELECT detail FROM audit_log WHERE action LIKE 'automation_connection.%'");
    assert.ok(audit.every((r) => !String(r.detail).includes('s:cret')));
  });

  test('gets a token with client credentials, caches it, and sends it as a Bearer token', async () => {
    const a = await createAutomation('Secure call', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request_auth', 300, 100, null);
    await configureNode(a.id, call, { connectionId, method: 'GET', url: base + '/secure', output: 'secure' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);

    seen.length = 0;
    await raise('One');
    await raise('Two');
    const tokenCalls = seen.filter((s) => s.url === '/token');
    assert.equal(tokenCalls.length, 1, 'the token is reused');
    assert.equal(new URLSearchParams(tokenCalls[0]!.body).get('scope'), 'api.write');
    assert.ok(seen.filter((s) => s.url === '/secure').every((s) => s.headers.authorization === 'Bearer tok-' + tokensIssued));
    const runs = await recentRuns(a.id);
    assert.ok(runs.slice(0, 2).every((r) => r.outcome === 'success'));
    assert.ok(runs.every((r) => !r.steps.includes('tok-')), 'the token is never logged');

    // A token the API refuses is replaced once.
    rejectNextBearer = true;
    const before = tokensIssued;
    await raise('Three');
    assert.equal(tokensIssued, before + 1);
    assert.equal((await recentRuns(a.id))[0]?.outcome, 'success');
    await setAutomationEnabled(a.id, false, null);
  });

  test('a wrong secret fails with the OAuth error code and nothing it echoed', async () => {
    const bad = await createConnection(
      { name: 'Wrong', authType: 'oauth2', headerName: '', valuePrefix: '', tokenUrl: base + '/token', clientId: 'cid', clientSecret: 'nope', scope: '', audience: '', clientAuth: 'body' },
      null,
    );
    await assert.rejects(accessToken(bad), (err: Error) => {
      assert.match(err.message, /401 \(invalid_client\)/);
      assert.doesNotMatch(err.message, /s:cret|nope/);
      return true;
    });
  });
});

describe('connections that are not OAuth', () => {
  before(async () => {
    await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
  });

  test('an API key travels in its own header, with its prefix, and is never logged', async () => {
    const id = await createConnection(
      { name: 'Keyed', authType: 'api_key', headerName: 'X-Api-Key', valuePrefix: 'Token ', tokenUrl: '', clientId: '', clientSecret: 'k-123', scope: '', audience: '', clientAuth: 'body' },
      null,
    );
    const a = await createAutomation('Keyed call', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request_auth', 300, 100, null);
    await configureNode(a.id, call, { connectionId: id, method: 'GET', url: base + '/keyed' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);

    seen.length = 0;
    await raise('Keyed');
    const req = seen.find((s) => s.url === '/keyed')!;
    assert.equal(req.headers['x-api-key'], 'Token k-123');
    assert.equal(req.headers.authorization, undefined);
    assert.ok((await recentRuns(a.id)).every((r) => !r.steps.includes('k-123')));
    await setAutomationEnabled(a.id, false, null);
  });

  test('Basic sends the username and password, and a key header must be a real header name', async () => {
    const id = await createConnection(
      { name: 'Basic one', authType: 'basic', headerName: '', valuePrefix: '', tokenUrl: '', clientId: 'svc', clientSecret: 'p@ss', scope: '', audience: '', clientAuth: 'body' },
      null,
    );
    const a = await createAutomation('Basic call', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request_auth', 300, 100, null);
    await configureNode(a.id, call, { connectionId: id, method: 'GET', url: base + '/basic' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);
    seen.length = 0;
    await raise('Basic');
    assert.equal(seen.find((s) => s.url === '/basic')?.headers.authorization, 'Basic ' + Buffer.from('svc:p@ss').toString('base64'));
    await setAutomationEnabled(a.id, false, null);

    const { connectionProblems } = await import('../src/services/automation-connections.js');
    const bad = connectionProblems({ name: 'x', authType: 'api_key', headerName: 'X Bad', valuePrefix: '', tokenUrl: '', clientId: '', clientSecret: 'k', scope: '', audience: '', clientAuth: 'body' }, false);
    assert.ok(bad.headerName);
    const user = connectionProblems({ name: 'x', authType: 'basic', headerName: '', valuePrefix: '', tokenUrl: '', clientId: 'a:b', clientSecret: 'k', scope: '', audience: '', clientAuth: 'body' }, false);
    assert.ok(user.clientId);
  });
});

describe('retries and the background', () => {
  before(async () => {
    await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
    setRetryBaseForTests(5);
  });

  test('a 503 is tried again until it succeeds, and the log says how many retries it took', async () => {
    flakyCalls = 0;
    const a = await createAutomation('Flaky but fine', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request', 300, 100, null);
    await configureNode(a.id, call, { method: 'GET', url: base + '/flaky', retries: '3' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);
    await raise('Flaky');
    assert.equal(flakyCalls, 3);
    const run = (await recentRuns(a.id))[0]!;
    assert.equal(run.outcome, 'success');
    assert.match(run.steps, /after 2 retries/);
    await setAutomationEnabled(a.id, false, null);
  });

  test('without retries the first 503 is final; a 4xx is never retried', async () => {
    assert.match(httpStepProblem({ method: 'GET', url: 'https://x.example.com/', retries: '9' }, false), /retries/);
    flakyCalls = 0;
    const a = await createAutomation('No retries', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request', 300, 100, null);
    await configureNode(a.id, call, { method: 'GET', url: base + '/flaky' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);
    await raise('Once');
    assert.equal(flakyCalls, 1);
    assert.equal((await recentRuns(a.id))[0]?.outcome, 'failure');
    await setAutomationEnabled(a.id, false, null);
  });

  test('raising the ticket does not wait for an automation that calls out', async () => {
    flakyCalls = 0;
    setRetryBaseForTests(300);
    const a = await createAutomation('Slow upstream', 'ticket.created', admin.user.id);
    const trigger = await triggerOf(a.id);
    const call = await addNode(a.id, 'http_request', 300, 100, null);
    await configureNode(a.id, call, { method: 'GET', url: base + '/flaky', retries: '3' }, null);
    await connect(a.id, trigger, 'next', call, null);
    await setAutomationEnabled(a.id, true, null);
    const started = Date.now();
    await createTicket({ title: 'Fast', description: 'Must not wait for the API.', priority: 'normal', category: 'other', requesterId: requester.user.id });
    assert.ok(Date.now() - started < 250, 'createTicket returned before the retries were done');
    await settleAutomations();
    assert.equal(flakyCalls, 3);
    await setAutomationEnabled(a.id, false, null);
    setRetryBaseForTests(5);
  });
});

describe('Save and test', () => {
  test('sends once with the sample ticket, and reports the answer', async () => {
    await updateSettings({ httpRequests: { allowPrivateNetwork: true } }, null);
    const { testHttpStep } = await import('../src/services/automation-http.js');
    seen.length = 0;
    const result = await testHttpStep({ method: 'POST', url: base + '/items/{{ticket.reference}}', bodyType: 'json', body: '{"t": "{{ticket.title}}"}', retries: '3' }, false);
    assert.equal(result.ok, true);
    assert.equal(result.status, 201);
    assert.match(result.line, /POST http:\/\/127\.0\.0\.1:\d+\/items\/INC-000123 -> 201/);
    assert.match(result.preview, /EXT-42/);
    assert.equal(seen.length, 1, 'once, whatever the retries say');
    assert.equal(JSON.parse(seen[0]!.body).t, 'Printer on the third floor is jammed', 'a sample ticket, never a real one');
  });

  test('a failure is reported, not thrown', async () => {
    const { testHttpStep } = await import('../src/services/automation-http.js');
    const bad = await testHttpStep({ method: 'GET', url: base + '/fail' }, false);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 503);
    const refused = await testHttpStep({ method: 'GET', url: 'https://{{ticket.title}}.example.com/' }, false);
    assert.equal(refused.ok, false);
    assert.match(refused.line, /host cannot contain a variable/);
  });
});
