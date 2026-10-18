import pino from 'pino';
import { config } from '../config.js';

/**
 * Structured logger. Anything that could carry a credential or an assertion is
 * redacted at the logger, so a stray log call cannot leak it.
 */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.client_secret',
      '*.clientSecret',
      '*.access_token',
      '*.id_token',
      '*.refresh_token',
      '*.code',
      '*.code_verifier',
      '*.SAMLResponse',
      '*.assertion',
      'body.SAMLResponse',
      'query.code',
    ],
    censor: '[redacted]',
  },
  base: { app: 'helpdesk' },
  transport: config.isProduction
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
});
