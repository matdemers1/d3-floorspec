# Backups, the restore drill, restoring, and alerts

FLR-T-12.1 (FLR-REQ-147, FLR-REQ-171) and FLR-T-12.2 (FLR-REQ-148). Commands are written for the
Zima, from `/DATA/floorspec`, where the stack is the compose project `floorspec`:

```bash
cd /DATA/floorspec
alias dc='docker compose -p floorspec -f compose.yml -f compose.tunnel.yml'
```

On a self-hosted checkout, use `docker compose -f deploy/compose.yml -f deploy/compose.dev.yml`
instead. Deploys go through Shipyard, never by SSH; restoring a database is an operator action on
the host and is the one thing in this file that is done there by hand.

## What runs on its own

| Job | When | Key | Runs in |
|---|---|---|---|
| `backup` | daily, from `BACKUP_HOUR_UTC` (default 07:00 UTC) | `backup:<YYYY-MM-DD>` | api |
| `restore-drill` | weekly, after the first backup of the ISO week that succeeds | `restore-drill:<YYYY-Www>` | api |
| health watchdog | every `WATCHDOG_INTERVAL_MS` (default 60 s) | — | worker |

The api checks every five minutes whether the day's key has run. **Inserting the key into
`maintenance_runs` is the claim**, so asking every five minutes runs one backup a day, and an api
restarted at noon (a deploy) still gets that day's run. A failed backup is not retried under the
same key: it alerted, and you take one by hand once the cause is fixed. The schedule is on when
`NODE_ENV=production` (the image) unless `BACKUP_SCHEDULE=off`.

They run in the api because the drill boots the app, and only the api image has the app, the
PostgreSQL 16 client tools (`pg_dump`, `pg_restore`, `psql`) and the `backups` volume.

### What a backup writes

Into `BACKUP_DIR` (`/backups` in the image — the `floorspec_backups` Docker volume, on the host at
`/var/lib/docker/volumes/floorspec_backups/_data`):

- `floorspec-<UTC timestamp>.dump` — `pg_dump --format=custom` of the whole database. Written as
  `.partial` and renamed, so nothing ever sees half a dump. **Under 1 KiB is a failure.**
- `floorspec-<UTC timestamp>.manifest.json` — `sha256`, `bytes`, `schemaRevision` (the newest
  applied migration), `rowCounts` of `accounts`, `projects`, `versions`, `heads`, `op_log`,
  `changesets` and `audit_log`, the asset summary, and the `pg_dump` version. The counts and
  revision are read inside the same snapshot the dump is taken from (`pg_dump --snapshot`), so they
  describe exactly what is in the file.
- `assets/` — a mirror of `ASSET_DIR` (the image sets `/assets`, the `assets` volume), when it is
  not empty. The asset store is content-addressed (FLR-T-8.2) — each upload is the file
  `ab/cd/<sha256>` and never changes — so only new files are copied. With `ASSET_DIR` unset, or the
  store empty, the manifest records `{"status": "none", "reason": …}`. An `ASSET_DIR` that is set but
  missing fails the backup — that is a volume that did not mount, not an empty store. The database
  keeps which project uploaded which digest (`project_assets`); a dump without its asset mirror
  restores models whose textures fall back to their colour until the files are copied back.

Nightly dumps older than `BACKUP_RETENTION_DAYS` (default 30) are pruned after a successful
backup; the newest is never pruned.

**Separate from these:** Shipyard's pre-deploy backup (`node dist/cli/backup.js`, in
`deploy/shipyard.yml`) and the api's own pre-migration dump at boot write
`<timestamp>-predeploy.dump` and `<timestamp>-pre-migration.dump` into the same volume. They are
not `floorspec-*`, so the nightly pruning and the drill leave them alone.

**Off-machine:** the volume is on the Zima's own disk. Copy it elsewhere as well (step 6 below).

## Taking a backup now

```bash
dc exec api node dist/cli/run-job.js backup
```

It prints the manifest and `backup: succeeded (run <id>)`, or the error and whether the alert was
emailed, and exits non-zero on failure. Manual runs are recorded in `maintenance_runs` with the
key `manual:backup:<time>` and alert on failure exactly as scheduled ones do.

## The drill

```bash
dc exec api node dist/cli/run-job.js restore-drill
```

What it does, in order — every step a failure that alerts:

1. Takes the newest `floorspec-*.dump` and checks its sha256 against its manifest.
2. Drops any `floorspec_drill_*` database more than six hours old (a drill that was killed), then
   creates a fresh scratch database, `floorspec_drill_<timestamp>_<random>`, on the same server.
   The role needs `CREATEDB`; the `floorspec` role the postgres image creates is a superuser.
3. `pg_restore --no-owner --no-privileges --exit-on-error` into it.
4. Counts the same seven tables and reads the schema revision; they must equal the manifest's.
5. **Boots the app on it and opens a project.** The real app factory, in the api process, against
   the scratch database on a loopback port: `GET /health` must answer 200; then the most recently
   edited project is opened as its owner — a session is issued *in the scratch database* — with
   `GET /api/projects/:id` and `GET /api/projects/:id/model.json`. The served model is hashed with
   the engine's `contentHash`, and the hash must equal the head the app reported. The engine's
   validation verdict is recorded (`valid`, `errors`) but does not fail the drill: a model may
   legitimately hold errors. A dump with no project passes with the note "the dump holds no
   project, so none was opened".
6. Drops the scratch database in a `finally` (`WITH (FORCE)`), pass or fail.

### The recorded result

Each run is a row in `maintenance_runs` (`kind`, `key`, `trigger`, `status`, `started_at`,
`finished_at`, `error`, `result`). A drill's `result`:

```json
{
  "dump": "floorspec-2026-10-05T07-05-00-123Z.dump",
  "dumpCreatedAt": "2026-10-05T07:05:00.123Z",
  "sha256": "…",
  "manifest": "verified",
  "scratchDatabase": "floorspec_drill_20261005070512_k3x9",
  "schemaRevision": "20261005120000_maintenance_alerts",
  "restoredRows": { "accounts": 1, "projects": 2, "versions": 140, "heads": 3, "op_log": 150, "changesets": 1, "audit_log": 300 },
  "app": {
    "health": { "status": 200, "schemaRevision": "20261005120000_maintenance_alerts" },
    "projects": 2,
    "opened": { "id": "…", "name": "…", "head": "…", "modelHash": "…", "modelBytes": 12345, "valid": true, "errors": 0 }
  },
  "durationMs": 1830,
  "notes": []
}
```

Where to read it:

- `GET /health` — `backup: {at, ok}` and `drill: {at, ok}` for the newest finished run of each.
  They never change `/health`'s status: a failed backup must not make Shipyard roll back a good
  deploy. It alerts instead.
- `GET /api/maintenance` (operator only) — the last ten runs of each kind with their results, the
  dumps on disk, whether alert email is configured, and the last twenty alerts with why any was not
  sent.
- The database: `dc exec postgres psql -U floorspec -d floorspec -c "select key, status, finished_at, error from maintenance_runs order by started_at desc limit 10"`.

### Drilling a particular file

```bash
dc exec api node dist/cli/run-job.js restore-drill --dump /backups/<file>.dump
```

Without a manifest beside it, the sha256 and row-count checks are skipped and the result says so
in `notes`.

## Restoring for real

The drill proves the dump restores. This is what you do when you need it. Restore **beside** the
live database, check it, then switch — never over the top of the only copy you have.

1. **Stop writes.** `dc stop api worker`. Leave `postgres` running.
2. **Pick the dump.** `dc run --rm --no-deps --entrypoint ls api -lt /backups` (or read
   `GET /api/maintenance` before stopping the api). Prefer a nightly `floorspec-*.dump` with a
   manifest; a `*-pre-migration.dump` is the right one after a failed migration.
3. **Restore into a new database** with the helper, which creates it, runs `pg_restore
   --exit-on-error` (the custom-format equivalent of `ON_ERROR_STOP`) and prints the restored
   row counts beside the manifest's:

   ```bash
   /DATA/floorspec/backup/restore.sh floorspec-2026-10-05T07-05-00-123Z.dump floorspec_restored
   ```

   (It is `deploy/backup/restore.sh` in the repository; copy it to the host beside the compose
   files.) Without the helper:

   ```bash
   dc exec postgres psql -U floorspec -d postgres -v ON_ERROR_STOP=1 -c 'create database floorspec_restored'
   dc run --rm --no-deps --entrypoint sh api -c \
     'pg_restore --no-owner --no-privileges --exit-on-error \
        --dbname "${DATABASE_URL%/*}/floorspec_restored" /backups/<file>.dump'
   ```

4. **Check it** holds what you expect: the counts against the manifest, and your newest project.

   ```bash
   dc exec postgres psql -U floorspec -d floorspec_restored -v ON_ERROR_STOP=1 \
     -c 'select count(*) from projects' -c 'select name, updated_at from projects order by updated_at desc limit 5'
   ```

5. **Switch.** Either rename the databases (keeps `DATABASE_URL` as it is):

   ```bash
   dc exec postgres psql -U floorspec -d postgres -v ON_ERROR_STOP=1 \
     -c 'alter database floorspec rename to floorspec_broken_<date>' \
     -c 'alter database floorspec_restored rename to floorspec'
   ```

   then `dc start api worker`. The api migrates on boot if the dump predates the image's schema
   (after its own pre-migration dump). Sign in and open a project. Drop `floorspec_broken_<date>`
   once you are sure.
6. **Assets:** copy the mirror back into the asset volume — files are
   content-addressed, so copying over an existing store only fills in what is missing:
   `dc run --rm --no-deps --entrypoint cp api -an /backups/assets/. "$ASSET_DIR"/`.
7. **Off the machine:** `dc cp api:/backups ./floorspec-backups` copies the volume out.

A restore needs the same `KEK` and `PEPPER` as the instance that made the dump (TOTP secrets are
wrapped with the KEK; password hashes are peppered). Keep them, out of the repository, with the
off-machine copy.

## Alerts

Email to the operator through **D3 Auth's mail relay**, the same relay, protocol and variable
names as Foreman and Shipyard (`POST {to, subject, text}` with `Authorization: Bearer <token>`).
In `/DATA/floorspec/api.env`, which both the api and the worker read:

| Variable | What |
|---|---|
| `MAIL_RELAY_URL` | The relay Worker's URL (D3 Auth's mail-relay settings). |
| `MAIL_RELAY_TOKEN` | The relay's bearer token. Issued by the D3 Auth owner; a secret — never in the repository. |
| `ALERT_TO` | The operator's address. |

All three or none. Unset, every alert is still written to the log and to the `alerts` table, and
both processes say at boot `alerts: logged only — …`; half-set, they warn and name what is
missing.

| Alert | Sent by | When |
|---|---|---|
| `backup-failed` — "The nightly backup failed" | api | A backup fails (pg_dump, the 1 KiB guard, an unmounted `ASSET_DIR`), or a run was abandoned part-way. |
| `drill-failed` — "The restore drill failed" | api | Any drill step fails. |
| `deploy-failed` — "The api failed to start (…)" | api | A boot fails after the config is read: a migration that fails, a rule pack that is not one. On a Shipyard deploy this is the deploy failing. Sent only when the `alerts` table answers, so a crash-looping api mails once an hour, not once a restart. |
| `health-failed` / `health-recovered` | worker | `WATCHDOG_THRESHOLD` (default 3) failed checks in a row of the api's `/health` (`HEALTH_URL`, default `http://api:3400/health`) or the database; then once when both pass again. One pair per episode. |

Every kind is sent at most once an hour (the watchdog's once per episode), remembered in the
`alerts` table across processes and restarts. Each subject and body is redacted before sending:
credentials in URLs, and the database password, `KEK`, `PEPPER`, the D3 Auth client secret and the
relay token by value. A relay that refuses or does not answer within ten seconds is logged, and the
job that was alerting carries on.

**Shipyard does not email on a failed deploy** (its alerts are a stale agent, a failed backup and a
failed drill — its own). A Floorspec deploy that fails is covered here twice: the new api's boot
failure, and the watchdog when the api stays down long enough to fail three checks.

### Proving each one

```bash
# The relay is configured and reaches the operator:
dc exec api node dist/cli/run-job.js alert-test

# A failed backup: a backup directory the api cannot write (its code is root-owned).
dc exec -e BACKUP_DIR=/app/not-writable api node dist/cli/run-job.js backup

# A failed drill: a dump that is not one.
dc exec api sh -c 'head -c 8192 /dev/urandom > /tmp/corrupt.dump'
dc exec api node dist/cli/run-job.js restore-drill --dump /tmp/corrupt.dump

# A failed health check, and its recovery: stop the api for longer than three checks.
dc stop api; sleep 240; dc start api
```

Each forced failure is recorded in `maintenance_runs` and `alerts` like a real one. An alert of the
same kind within the hour is recorded but not mailed (`GET /api/maintenance` shows why), so space
the proofs out or prove one kind at a time. The deploy failure is
proved by `apps/server/test/integration/maintenance.test.ts`, which boots the api against a
database whose migration fails, and boots it again to show the second failure is not mailed.
