/**
 * The job-queue drain (FLR-T-9.3): claims queued jobs from Postgres one at a time with
 * `FOR UPDATE SKIP LOCKED` — so any number of drains (the worker container, or the api in
 * development) share one queue without taking the same job twice — runs each, and stores its file.
 *
 * Woken by NOTIFY on `floorspec_jobs` (a trigger announces every queued insert) and by a slow poll,
 * which also picks up a job whose worker died: a running job whose lock is older than
 * `STALE_AFTER` is taken again, up to `MAX_ATTEMPTS`, then failed with a reason a person can read.
 * Files are kept for `KEEP_DAYS` days; the job row stays as history.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import pg from 'pg';
import { createHandlers, handlers, type Handler, type JobRow } from './handlers.js';

export const JOB_CHANNEL = 'floorspec_jobs';
export const MAX_ATTEMPTS = 3;
const STALE_AFTER = "interval '10 minutes'";
const KEEP_DAYS = 7;

export interface DrainOptions {
  readonly databaseUrl: string;
  /** How often to look without being told to (ms). Default 5000. */
  readonly pollMs?: number;
  /** Who is draining, for `locked_by`. Default host and process ID. */
  readonly workerId?: string;
  readonly handlers?: Readonly<Record<string, Handler>>;
  /** Where the asset store is (`ASSET_DIR`), for the 3D exports' maps. Default the process's `ASSET_DIR`. Ignored when `handlers` is given. */
  readonly assetDir?: string;
  readonly log?: (message: string) => void;
}

export interface Drain {
  /** Claim and run jobs until none is queued; resolves with how many ran. */
  runOnce(): Promise<number>;
  /** Listen and poll until stopped. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** What a person reads when a job fails: the error's own words, never a stack. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}…` : message;
}

export function createDrain(options: DrainOptions): Drain {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 2 });
  const workerId = options.workerId ?? `${hostname()}:${String(process.pid)}`;
  const table = options.handlers ?? (options.assetDir === undefined ? handlers : createHandlers({ assetDir: options.assetDir }));
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  let listener: pg.Client | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;
  let again = false;
  let stopped = false;

  async function claim(): Promise<JobRow | null> {
    // A job abandoned too often is failed rather than tried forever.
    await pool.query(
      `update jobs set status = 'failed', finished_at = now(), locked_by = null,
         error = 'The export stopped part-way ' || attempts || ' times and was not tried again.'
       where status = 'running' and locked_at < now() - ${STALE_AFTER} and attempts >= $1`,
      [MAX_ATTEMPTS],
    );
    const { rows } = await pool.query<JobRow>(
      `update jobs set status = 'running', attempts = attempts + 1, locked_by = $1, locked_at = now(),
         started_at = coalesce(started_at, now()), error = null
       where id = (
         select id from jobs
         where status = 'queued' or (status = 'running' and locked_at < now() - ${STALE_AFTER} and attempts < $2)
         order by created_at, id
         for update skip locked
         limit 1)
       returning id, project_id as "projectId", kind, params, version_hash as "versionHash"`,
      [workerId, MAX_ATTEMPTS],
    );
    return rows[0] ?? null;
  }

  async function runJob(job: JobRow): Promise<void> {
    const handler = table[job.kind];
    try {
      if (handler === undefined) throw new Error(`no worker knows how to run a ${job.kind} job`);
      const { rows } = await pool.query<{ document: unknown }>('select document from versions where hash = $1', [job.versionHash]);
      const version = rows[0];
      if (version === undefined) throw new Error(`version ${job.versionHash.slice(0, 12)} is not in the store`);
      // What this project uploaded: the only asset bytes its exports may carry.
      const claims = await pool.query<{ sha256: string }>('select sha256 from project_assets where project_id = $1', [job.projectId]);
      const file = await handler(version.document as object, { ...job, claimed: new Set(claims.rows.map((r) => r.sha256)) });
      const sha256 = createHash('sha256').update(file.bytes).digest('hex');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into job_outputs (job_id, name, content_type, bytes, sha256) values ($1, $2, $3, $4, $5)
           on conflict (job_id) do update set name = excluded.name, content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256, created_at = now()`,
          [job.id, file.name, file.contentType, Buffer.from(file.bytes), sha256],
        );
        const result = { name: file.name, contentType: file.contentType, size: file.bytes.byteLength, sha256, ...file.summary };
        await client.query(`update jobs set status = 'done', result = $2, finished_at = now(), locked_by = null where id = $1 and locked_by = $3`, [job.id, JSON.stringify(result), workerId]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      log(`job ${job.id} (${job.kind}) done: ${file.name}, ${String(file.bytes.byteLength)} bytes`);
    } catch (error) {
      await pool.query(`update jobs set status = 'failed', error = $2, finished_at = now(), locked_by = null where id = $1`, [job.id, reason(error)]);
      log(`job ${job.id} (${job.kind}) failed: ${reason(error)}`);
    }
  }

  async function drainAll(): Promise<number> {
    let n = 0;
    for (;;) {
      if (stopped) return n;
      const job = await claim();
      if (job === null) break;
      await runJob(job);
      n++;
    }
    await pool.query(`delete from job_outputs where created_at < now() - interval '${String(KEEP_DAYS)} days'`);
    return n;
  }

  /** One drain at a time per process; a wake-up during a drain runs another after it. */
  function kick(): Promise<number> {
    if (running !== null) {
      again = true;
      return running;
    }
    running = drainAll()
      .catch((error: unknown) => {
        log(`job drain failed: ${reason(error)}`);
        return 0;
      })
      .finally(() => {
        running = null;
        if (again && !stopped) {
          again = false;
          void kick();
        }
      });
    return running;
  }

  return {
    runOnce: () => kick(),
    async start() {
      stopped = false;
      listener = new pg.Client({ connectionString: options.databaseUrl });
      listener.on('notification', (m) => {
        if (m.channel === JOB_CHANNEL) void kick();
      });
      listener.on('error', (error) => {
        log(`job listener error: ${reason(error)}; polling continues`);
      });
      await listener.connect();
      await listener.query(`LISTEN ${JOB_CHANNEL}`);
      timer = setInterval(() => void kick(), options.pollMs ?? 5000);
      void kick();
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await running;
      await listener?.end().catch(() => undefined);
      listener = null;
      await pool.end();
    },
  };
}
