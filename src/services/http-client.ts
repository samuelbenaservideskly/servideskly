import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Outbound HTTP for automations - "Send HTTP request" and the token request
 * of "Send authenticated HTTP request".
 *
 * No dependency: node:https with a `lookup` of our own. That is what makes
 * the address check hold - the check runs on the address the socket is
 * actually opened to, so a name that resolves to a public address when it is
 * checked and a private one when it is used (DNS rebinding) cannot slip
 * through.
 *
 * The rules:
 *
 * - **https only**, unless "Allow requests to the private network" is on
 *   (Settings - Advanced - Automation), and then plain http only to a
 *   private address - an internal service that has no certificate.
 * - **Private, loopback, link-local and metadata addresses are refused**
 *   unless that setting is on. A ticket system that can be made to call
 *   169.254.169.254 hands out the cloud credentials of the machine it runs on.
 * - **Redirects are not followed.** A 3xx is reported as it is; following it
 *   would be a way round both rules above.
 * - **Bounded**: a timeout over the whole exchange, and at most
 *   MAX_RESPONSE_BYTES of the answer kept.
 */

export const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpRequestInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** A client certificate for mutual TLS (https only). */
  tls?: { cert: string; key: string; passphrase?: string };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  ms: number;
}

export class HttpRequestRefused extends Error {}

/** Addresses no automation may reach unless the private network is allowed. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === '::' || lower === '::1' ||
      lower.startsWith('fc') || lower.startsWith('fd') ||
      lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') ||
      lower.startsWith('ff')
    );
  }
  return true;
}

function checkAddress(address: string, protocol: string, allowPrivate: boolean): string | null {
  const isPrivate = isPrivateAddress(address);
  if (isPrivate && !allowPrivate) {
    return 'refused: the address is on a private network. Allow it under Settings - Advanced - Automation if this is intended.';
  }
  if (protocol === 'http:' && !isPrivate) return 'refused: use https for addresses on the internet.';
  return null;
}

/** Sends one request. Throws HttpRequestRefused for a policy refusal, Error for a failure. */
export function sendHttp(input: HttpRequestInput, options: { allowPrivate: boolean }): Promise<HttpResponse> {
  const { url } = input;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowPrivate)) {
    return Promise.reject(new HttpRequestRefused('refused: only https addresses can be called.'));
  }
  if (url.username || url.password) {
    return Promise.reject(new HttpRequestRefused('refused: put credentials in a connection, not in the address.'));
  }

  // An address written as an IP is never looked up, so it is checked here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const refused = checkAddress(host, url.protocol, options.allowPrivate);
    if (refused) return Promise.reject(new HttpRequestRefused(refused));
  }

  const lookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        (callback as (e: Error) => void)(err);
        return;
      }
      for (const a of addresses) {
        const refused = checkAddress(a.address, url.protocol, options.allowPrivate);
        if (refused) {
          (callback as (e: Error) => void)(new HttpRequestRefused(refused));
          return;
        }
      }
      if ((lookupOptions as { all?: boolean }).all) {
        (callback as unknown as (e: null, list: dns.LookupAddress[]) => void)(null, addresses);
      } else {
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      }
    });
  };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const transport = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { 'user-agent': 'ServiceDesk-Automation/1', ...input.headers };
    if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));

    const req = transport.request(
      url,
      {
        method: input.method,
        headers,
        lookup,
        agent: false,
        ...(input.tls && url.protocol === 'https:'
          ? { cert: input.tls.cert, key: input.tls.key, ...(input.tls.passphrase ? { passphrase: input.tls.passphrase } : {}) }
          : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - MAX_RESPONSE_BYTES)));
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flat,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            ms: Date.now() - started,
          });
        };
        res.on('end', finish);
        res.on('error', (err) => {
          if (!done) reject(err);
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('timed out after ' + Math.round(input.timeoutMs / 1000) + ' s'));
    }, input.timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}
