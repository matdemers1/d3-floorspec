import { pino } from 'pino';

/**
 * Logs never contain tokens, secrets or password material. The redaction list is the second line of
 * defence; the first is not putting them in a log call.
 */
export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'token',
      'tokenHash',
      'totpSecret',
      'KEK',
      'PEPPER',
      'secret',
      'code',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
