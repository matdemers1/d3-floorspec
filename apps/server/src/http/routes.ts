import {
  Router,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Db, Tx } from '../db.js';
import { writeAudit, type AuditEntry } from '../domain/audit.js';
import { publishInTx, publishNow, WithEvents } from '../events/publish.js';
import type { ProjectEvent } from '../events/types.js';
import { logger } from '../logger.js';
import { HttpError } from './errors.js';
import { isAgent, type TokenPrincipal } from './context.js';

/**
 * How every route is declared (FLR-T-0.4, FLR-T-0.6).
 *
 * A router built here has no `post`, `put`, `patch` or `delete` of its own. A route that changes
 * anything is declared with `mutate`, which runs the handler inside a transaction and writes the
 * audit row in that same transaction — so a change cannot commit without its record, and a route
 * cannot forget to write one by being written the ordinary Express way.
 *
 * Two further defaults are chosen to fail closed:
 *   - **Every route needs a signed-in account** unless it says `access: 'public'`.
 *   - **Every path with `:projectId` loads the project and requires the caller to own it**, before
 *     the handler runs, answering 404 otherwise. Ownership is not something a handler can forget.
 *
 * Each declaration is also recorded, so the tests enumerate the real surface: the audit walk and
 * the isolation suite both fail when a route exists that their tables do not cover.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Access = 'public' | 'account' | 'operator';

/**
 * Whether a bearer credential (an API token, or Claude's D3 Auth connector) may call a route, and
 * with which scope. Absent: sessions only.
 *   - `read`: any token with the `read` scope.
 *   - `propose`: a `write` token (commits to main) or an `agent` one (writes a changeset).
 *   - `write`: a `write` token only — never an agent (FLR-ADR-016).
 */
export type TokenAccess = 'read' | 'propose' | 'write';

export interface RouteRecord {
  readonly method: Method;
  readonly path: string;
  readonly mutating: boolean;
  readonly access: Access;
  readonly projectScoped: boolean;
  readonly token: TokenAccess | null;
}

/** What a mutation hands back: the response to send once committed, and the row to audit. */
export interface MutationResult {
  readonly reply: (res: Response) => void;
  /**
   * The audit row. `null` only when nothing changed — a refused login, a code that did not match.
   * The audit walk (test/integration/audit.test.ts) calls every mutating route successfully and
   * fails on any that answers without a row.
   */
  readonly audit: AuditEntry | null;
  /**
   * What the live stream should hear (FLR-T-3.5). Queued on the same transaction with
   * `pg_notify`, so Postgres delivers them when — and only if — it commits.
   */
  readonly events?: readonly ProjectEvent[];
}

export type MutationHandler = (req: Request, tx: Tx) => Promise<MutationResult>;
export type ReadHandler = (req: Request, res: Response) => Promise<void> | void;

export interface RouteOptions {
  readonly access?: Access;
  /** Accept bearer credentials too, at this scope. Only for `account` routes. */
  readonly token?: TokenAccess;
  /** Extra middleware, run after the access and ownership guards. */
  readonly before?: readonly RequestHandler[];
}

const PROJECT_PARAM = ':projectId';

export class Routes {
  readonly router = Router();
  readonly records: RouteRecord[] = [];

  constructor(private readonly db: Db) {}

  read(path: string, handler: ReadHandler, options: RouteOptions = {}): this {
    const record = this.record('GET', path, false, options);
    this.router.get(path, ...this.guards(record, options), (req, res, next) => {
      Promise.resolve(handler(req, res)).catch(next);
    });
    return this;
  }

  mutate(method: Method, path: string, handler: MutationHandler, options: RouteOptions = {}): this {
    const record = this.record(method, path, true, options);
    const run: RequestHandler = (req, res, next) => {
      this.db
        .$transaction(
          async (tx) => {
            const result = await handler(req, tx);
            if (result.audit !== null) await writeAudit(tx, req, result.audit);
            if (result.events !== undefined && result.events.length > 0) await publishInTx(tx, result.events);
            return result;
          },
          // Argon2id runs inside some of these; the default five seconds is generous but not for
          // a cold container under load.
          { timeout: 20_000, maxWait: 10_000 },
        )
        .then((result) => {
          result.reply(res);
        })
        .catch((error: unknown) => {
          if (!(error instanceof WithEvents)) {
            next(error);
            return;
          }
          // News of something that did not happen (a replay that failed): the transaction has rolled
          // back by now, so it goes out on its own. A failure to publish it never changes the answer.
          publishNow(this.db, error.events)
            .catch((failure: unknown) => {
              logger.warn({ err: failure instanceof Error ? failure.message : String(failure) }, 'could not publish an event');
            })
            .finally(() => {
              next(error.error);
            });
        });
    };
    const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    this.router[verb](path, ...this.guards(record, options), run);
    return this;
  }

  private record(method: Method, path: string, mutating: boolean, options: RouteOptions): RouteRecord {
    const record: RouteRecord = {
      method,
      path,
      mutating,
      access: options.access ?? 'account',
      projectScoped: path.includes(PROJECT_PARAM),
      token: options.token ?? null,
    };
    if (record.token !== null && record.access !== 'account') {
      throw new Error(`${method} ${path}: only an account route can accept a token`);
    }
    this.records.push(record);
    return record;
  }

  private guards(record: RouteRecord, options: RouteOptions): RequestHandler[] {
    const guards: RequestHandler[] = [];
    if (record.access !== 'public') guards.push(requireCaller(record.token));
    if (record.access === 'operator') guards.push(requireOperator);
    if (record.projectScoped) guards.push(this.ownedProject());
    guards.push(...(options.before ?? []));
    return guards;
  }

  /**
   * Load the project named by `:projectId` and require the caller to own it. **404, never 403**:
   * somebody else's project and no project at all are the same answer, so the existence of an ID
   * leaks nothing (FLR-T-0.6). A deleted project is gone for every route.
   */
  private ownedProject(): RequestHandler {
    return (req, _res, next) => {
      const id = req.params['projectId'];
      const accountId = req.auth?.accountId ?? req.token?.accountId;
      // A per-project token reaches its own project and no other: anything else is the same 404 an
      // account gets for a project it does not own.
      const tokenProject = req.auth === undefined ? req.token?.projectId : null;
      if (
        typeof id !== 'string' ||
        !UUID.test(id) ||
        accountId === undefined ||
        (tokenProject !== null && tokenProject !== undefined && tokenProject !== id)
      ) {
        next(new HttpError(404, 'project not found'));
        return;
      }
      this.db.project
        .findFirst({ where: { id, ownerAccountId: accountId, deletedAt: null } })
        .then((project) => {
          if (project === null) {
            next(new HttpError(404, 'project not found'));
            return;
          }
          req.project = project;
          next();
        })
        .catch(next);
    };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A session always passes; a bearer credential passes only a route that accepts one, with a scope
 * that route allows. Nobody at all is a 401; a token on a person-only route is a 403 that says so.
 */
function requireCaller(tokenAccess: TokenAccess | null): RequestHandler {
  return (req, _res, next) => {
    if (req.auth !== undefined) {
      next();
      return;
    }
    const token = req.token;
    if (token === undefined) {
      next(new HttpError(401, 'sign in first'));
      return;
    }
    if (tokenAccess === null) {
      next(new HttpError(403, 'this needs a person signed in to D3 Floorspec, not a token'));
      return;
    }
    if (!tokenAllows(token, tokenAccess)) {
      next(new HttpError(403, tokenRefusal(token, tokenAccess)));
      return;
    }
    next();
  };
}

export function tokenAllows(token: TokenPrincipal, access: TokenAccess): boolean {
  switch (access) {
    case 'read':
      return token.scopes.has('read');
    case 'propose':
      return token.scopes.has('write') || token.scopes.has('agent');
    case 'write':
      return token.scopes.has('write') && !isAgent(token);
  }
}

function tokenRefusal(token: TokenPrincipal, access: TokenAccess): string {
  if (access === 'write' && isAgent(token)) {
    return 'an agent cannot do this: agents propose changesets, and a person accepts them (FLR-ADR-016)';
  }
  return `this token does not have the ${access === 'propose' ? 'write or agent' : access} scope`;
}

function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.role !== 'operator') {
    next(new HttpError(403, 'only the operator can do this'));
    return;
  }
  next();
}

/** Mount a set of routes under a prefix and record their full paths on the app. */
export function mount(app: Express, prefix: string, routes: Routes): void {
  app.use(prefix, routes.router);
  const all = registry(app);
  for (const record of routes.records) {
    const path = `${prefix}${record.path}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
    all.push({ ...record, path });
  }
}

/** Every route the app declared through `Routes`, with its full path. */
export function registry(app: Express): RouteRecord[] {
  const locals = app.locals as { routes?: RouteRecord[] };
  locals.routes ??= [];
  return locals.routes;
}
