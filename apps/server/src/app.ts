import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { schemaRevision } from './boot.js';
import { logger } from './logger.js';
import { attachAuth } from './auth/middleware.js';
import { HttpError } from './http/errors.js';
import { mount } from './http/routes.js';
import type { OidcClient } from './auth/oidc.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { inviteRoutes } from './routes/invites.js';
import { accountRoutes } from './routes/account.js';

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
  /**
   * Null when D3 Auth is not configured or was unreachable at boot: the sign-in screen then shows
   * one button instead of two, and nothing else changes.
   */
  readonly oidc?: OidcClient | null;
}

/** The paths the API owns. Anything else is a screen of the editor. */
const API_PREFIXES = ['api', 'auth', 'health', 'healthz', 'readyz', 'mcp', '.well-known'];

export function createApp({ config, db, oidc = null }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind the Cloudflare Tunnel: one hop, so `req.ip` is the client and the login throttle has a
  // bucket per client rather than one for everybody. Not `true`: that lets a client spoof itself.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(attachAuth(db, config));

  mount(app, '/auth', authRoutes({ db, config, oidcAvailable: oidc !== null }));
  mount(app, '/auth/oidc', oidcRoutes(db, config, oidc));
  mount(app, '/api/invites', inviteRoutes(db, config));
  mount(app, '/api/account', accountRoutes(db));

  /** Liveness: the process is up. Touches nothing else. */
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  /** Readiness: the database answers. */
  app.get('/readyz', (_req, res) => {
    db.$queryRaw`select 1`.then(
      () => res.json({ ok: true }),
      () => res.status(503).json({ ok: false, reason: 'database unreachable' }),
    );
  });

  /**
   * What Shipyard checks after a swap: a status, and the schema revision this instance is running
   * (the newest applied migration), which must equal the image's `dev.d3cloud.shipyard.schema`.
   */
  app.get('/health', (_req, res, next) => {
    schemaRevision(config.DATABASE_URL)
      .then((revision) => {
        res.status(revision === null ? 503 : 200).json({
          status: revision === null ? 'degraded' : 'ok',
          schemaRevision: revision,
        });
      })
      .catch(next);
  });

  for (const prefix of ['/api', '/auth', '/.well-known', '/mcp']) app.use(prefix, apiNotFound);

  // The editor is served by the API, not by a second process: one origin, one cookie, no CORS. In
  // development Vite serves it instead and WEB_DIST is unset.
  const webDist = config.WEB_DIST;
  if (webDist !== undefined && existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    const screens = new RegExp(`^/(?!(?:${API_PREFIXES.map((p) => p.replace('.', '\\.')).join('|')})(?:/|$)).*`);
    app.get(screens, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  // Last: anything thrown. An HttpError is the answer; anything else is a 500 that never leaks its
  // message, which may carry a query or a value from the row that failed.
  app.use(((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message, ...error.extra });
      return;
    }
    if (isBodyParseError(error)) {
      res.status(400).json({ error: 'the request body is not valid JSON' });
      return;
    }
    logger.error({ err: error instanceof Error ? error.message : String(error) }, 'unhandled request error');
    res.status(500).json({ error: 'internal error' });
  }) as ErrorRequestHandler);

  return app;
}

function apiNotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

function isBodyParseError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { type?: unknown }).type === 'entity.parse.failed';
}
