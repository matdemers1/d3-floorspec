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
import { projectRoutes } from './routes/projects.js';
import { historyRoutes } from './routes/history.js';
import { changesetRoutes } from './routes/changesets.js';
import { layoutRoutes } from './routes/layouts.js';
import { assistantRoutes } from './routes/assistants.js';
import { checkRoutes, type Render3dWait } from './routes/checks.js';
import { profileRoutes, projectProfileRoutes, rulePackRoutes } from './routes/rules.js';
import { tokenRoutes } from './routes/tokens.js';
import { exportRoutes } from './routes/exports.js';
import { importRoutes } from './routes/imports.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { latestRuns } from './maintenance/runs.js';
import { mountMcp } from './routes/mcp.js';
import { ProblemError, sendProblem } from './http/problem.js';
import { ApplierUnavailable, unavailableApplier, type Applier } from './ops/applier.js';
import { createVerifier, protectedResourceMetadata, type Verifier } from './auth/resource-server.js';
import type { PlanRenderer } from './render.js';
import { EventHub } from './events/hub.js';
import { eventRoutes, type EventRouteOptions } from './events/routes.js';
import { NO_PACKS, type InstalledPacks } from './rules/packs.js';
import { projectShareRoutes, shareRoutes } from './share/routes.js';
import { privateShareHeaders } from './share/guards.js';
import type { ShareLimits } from './share/limit.js';
import { assetRoutes } from './routes/assets.js';
import { defaultAssetStore, type AssetStore } from './assets/store.js';

export interface AppDeps {
  readonly config: Config;
  readonly db: Db;
  /**
   * Null when D3 Auth is not configured or was unreachable at boot: the sign-in screen then shows
   * one button instead of two, and nothing else changes.
   */
  readonly oidc?: OidcClient | null;
  /**
   * The Floorspec Ops applier every edit goes through (FLR-ADR-008). Defaults to one that answers
   * 503 until `@floorspec/ops` is wired in.
   */
  readonly applier?: Applier;
  /**
   * Verifies D3 Auth access tokens at `/mcp`. Defaults to one built from the config when
   * D3AUTH_ISSUER is set; null takes API tokens only.
   */
  readonly verifier?: Verifier | null;
  /** Draws plan PNGs (FLR-T-2.8). Null until the worker's renderer is wired in: renders answer 501. */
  readonly renderer?: PlanRenderer | null;
  /**
   * The live stream's fan-out (FLR-T-3.5): one LISTEN connection, opened on the first subscriber.
   * Defaults to one on DATABASE_URL; whoever stops the server closes it (`eventHubOf`).
   */
  readonly events?: EventHub;
  /** Heartbeat and stream lifetime; tests shorten them. */
  readonly eventStream?: EventRouteOptions;
  /** The installed rule packs (RULE_PACKS_DIR, read at boot). Default: none. */
  readonly rulePacks?: InstalledPacks;
  /** How long a 3D render waits for the worker (FLR-T-8.5); tests shorten it. */
  readonly render3d?: Render3dWait;
  /** The share routes' rate limits (FLR-T-9.6); tests tighten them. */
  readonly shareLimits?: ShareLimits;
  /** The asset store (FLR-T-8.2). Default: the filesystem under ASSET_DIR (src/assets/store.ts). */
  readonly assets?: AssetStore | null;
}

/** The paths the API owns. Anything else is a screen of the editor. */
const API_PREFIXES = ['api', 'auth', 'health', 'healthz', 'readyz', 'mcp', '.well-known'];

export function createApp({
  config,
  db,
  oidc = null,
  applier = unavailableApplier,
  verifier = createVerifier(config),
  renderer = null,
  events = new EventHub(config.DATABASE_URL),
  eventStream = {},
  rulePacks = NO_PACKS,
  render3d = {},
  shareLimits,
  assets = defaultAssetStore(config),
}: AppDeps): Express {
  const app = express();
  (app.locals as { events?: EventHub }).events = events;
  app.disable('x-powered-by');
  // Behind the Cloudflare Tunnel: one hop, so `req.ip` is the client and the login throttle has a
  // bucket per client rather than one for everybody. Not `true`: that lets a client spoof itself.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(attachAuth(db, config, verifier));

  mount(app, '/auth', authRoutes({ db, config, oidcAvailable: oidc !== null }));
  mount(app, '/auth/oidc', oidcRoutes(db, config, oidc));
  mount(app, '/api/invites', inviteRoutes(db, config));
  mount(app, '/api/account', accountRoutes(db));
  mount(app, '/api/projects', projectRoutes(db));
  mount(app, '/api/projects', historyRoutes(db, applier));
  mount(app, '/api/projects', changesetRoutes(db, applier));
  mount(app, '/api/projects', layoutRoutes(db, applier));
  mount(app, '/api/projects', assistantRoutes(db, applier));
  mount(app, '/api/projects', checkRoutes(db, renderer, rulePacks, `${config.PUBLIC_URL.replace(/\/$/, '')}/rule-packs`, render3d));
  mount(app, '/api/projects', projectProfileRoutes(db, rulePacks));
  mount(app, '/api/profiles', profileRoutes(db, rulePacks));
  mount(app, '/api/rule-packs', rulePackRoutes(db, rulePacks));
  mount(app, '/api/projects', eventRoutes(db, events, eventStream));
  mount(app, '/api/projects', exportRoutes(db));
  mount(app, '/api/projects', importRoutes(db, applier));
  mount(app, '/api/projects', assetRoutes(db, assets, config.ASSET_MAX_BYTES));
  mount(app, '/api/tokens', tokenRoutes(db));
  mount(app, '/api/maintenance', maintenanceRoutes(db, config));
  // Sharing (FLR-T-9.6): the owner's links and comments, and what a share link reaches.
  const share = { config, events, rules: rulePacks, stream: eventStream, ...(shareLimits === undefined ? {} : { limits: shareLimits }) };
  mount(app, '/api/projects', projectShareRoutes(db, share));
  mount(app, '/api/share', shareRoutes(db, share));
  mountMcp(app, config);

  /**
   * RFC 9728 protected-resource metadata for `/mcp`, at both paths the spec has clients try: how
   * Claude's connector finds D3 Auth. Registered before the not-found guards and the editor, so a
   * probe gets this document rather than a 404 or a web page.
   */
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, (_req, res) => {
      res.json(protectedResourceMetadata(config));
    });
  }

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
    // The newest backup and drill ride along (FLR-T-12.1) but never decide the status: a failed
    // backup must not make Shipyard roll a good deploy back. It alerts instead (FLR-T-12.2).
    Promise.all([schemaRevision(config.DATABASE_URL), latestRuns(db).catch(() => null)])
      .then(([revision, runs]) => {
        res.status(revision === null ? 503 : 200).json({
          status: revision === null ? 'degraded' : 'ok',
          schemaRevision: revision,
          backup: runs?.backup ?? null,
          drill: runs?.['restore-drill'] ?? null,
        });
      })
      .catch(next);
  });

  for (const prefix of ['/api', '/auth', '/.well-known', '/mcp']) app.use(prefix, apiNotFound);

  // The editor is served by the API, not by a second process: one origin, one cookie, no CORS. In
  // development Vite serves it instead and WEB_DIST is unset.
  // The shared viewer's page (FLR-T-9.6): not indexed, and never the Referer of a page it links to.
  app.use('/s', (_req, res, next) => {
    privateShareHeaders(res);
    next();
  });

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
    if (error instanceof ProblemError) {
      sendProblem(res, error.problem);
      return;
    }
    if (error instanceof ApplierUnavailable) {
      sendProblem(res, { status: 503, type: 'applier-unavailable', title: error.message });
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

/** The app's event hub: close it before closing the HTTP server, or open streams keep it alive. */
export function eventHubOf(app: Express): EventHub {
  const hub = (app.locals as { events?: EventHub }).events;
  if (hub === undefined) throw new Error('this app has no event hub');
  return hub;
}

function apiNotFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not found' });
}

function isBodyParseError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { type?: unknown }).type === 'entity.parse.failed';
}
