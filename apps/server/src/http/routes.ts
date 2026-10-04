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
import { HttpError } from './errors.js';

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

export interface RouteRecord {
  readonly method: Method;
  readonly path: string;
  readonly mutating: boolean;
  readonly access: Access;
  readonly projectScoped: boolean;
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
}

export type MutationHandler = (req: Request, tx: Tx) => Promise<MutationResult>;
export type ReadHandler = (req: Request, res: Response) => Promise<void> | void;

export interface RouteOptions {
  readonly access?: Access;
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
            return result;
          },
          // Argon2id runs inside some of these; the default five seconds is generous but not for
          // a cold container under load.
          { timeout: 20_000, maxWait: 10_000 },
        )
        .then((result) => {
          result.reply(res);
        })
        .catch(next);
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
    };
    this.records.push(record);
    return record;
  }

  private guards(record: RouteRecord, options: RouteOptions): RequestHandler[] {
    const guards: RequestHandler[] = [];
    if (record.access !== 'public') guards.push(requireAccount);
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
      const accountId = req.auth?.accountId;
      if (typeof id !== 'string' || !UUID.test(id) || accountId === undefined) {
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

function requireAccount(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth === undefined) {
    next(new HttpError(401, 'sign in first'));
    return;
  }
  next();
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
