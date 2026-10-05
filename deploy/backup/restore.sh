#!/usr/bin/env sh
# Restore a dump from the `backups` volume into a NEW database beside the live one, and print what
# it holds beside what its manifest says was dumped (FLR-T-12.1; docs/runbooks/restore.md).
#
#   restore.sh <dump file name> <new database name>
#   restore.sh floorspec-2026-10-05T07-05-00-123Z.dump floorspec_restored
#
# Never touches the live database: switching to the restore is a separate, deliberate step in the
# runbook. On the Zima, keep this beside the compose files (/DATA/floorspec/backup/restore.sh); it
# reads them from its parent directory unless COMPOSE says otherwise. pg_restore runs in a one-off
# api container, whose PostgreSQL 16 client matches the server, with --exit-on-error: the custom
# format's ON_ERROR_STOP. A half-restore must not look like a success.
set -eu

dump="${1:-}"
db="${2:-}"
if [ -z "$dump" ] || [ -z "$db" ]; then
  echo "usage: $0 <dump file name in the backups volume> <new database name>" >&2
  exit 2
fi
case "$dump" in
  */* | *[!A-Za-z0-9._-]*) echo "the dump is a file name in the backups volume, not a path: $dump" >&2; exit 2 ;;
esac
case "$db" in
  floorspec) echo "refusing to restore over the live database; name a new one" >&2; exit 2 ;;
  [a-z_]*) ;;
  *) echo "a database name is lowercase letters, digits and underscores: $db" >&2; exit 2 ;;
esac
case "$db" in
  *[!a-z0-9_]*) echo "a database name is lowercase letters, digits and underscores: $db" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="${COMPOSE:-docker compose -p floorspec -f $here/compose.yml -f $here/compose.tunnel.yml}"

echo "creating database $db"
$COMPOSE exec -T postgres psql -U floorspec -d postgres -v ON_ERROR_STOP=1 -c "create database \"$db\""

echo "restoring /backups/$dump into $db"
$COMPOSE run --rm --no-deps -T --entrypoint sh api -c \
  "pg_restore --no-owner --no-privileges --exit-on-error --dbname \"\${DATABASE_URL%/*}/$db\" \"/backups/$dump\""

echo "restored rows:"
$COMPOSE exec -T postgres psql -U floorspec -d "$db" -v ON_ERROR_STOP=1 -tA -F ' ' -c "
  select 'accounts', count(*) from accounts union all
  select 'projects', count(*) from projects union all
  select 'versions', count(*) from versions union all
  select 'heads', count(*) from heads union all
  select 'op_log', count(*) from op_log union all
  select 'changesets', count(*) from changesets union all
  select 'audit_log', count(*) from audit_log"

manifest="${dump%.dump}.manifest.json"
echo "the manifest's rowCounts (a pre-deploy or pre-migration dump has no manifest):"
$COMPOSE run --rm --no-deps -T --entrypoint sh api -c \
  "test -f \"/backups/$manifest\" && node -e 'console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).rowCounts)' \"/backups/$manifest\" || echo '(none)'"

echo "done. Check it, then switch to it as docs/runbooks/restore.md says. The live database was not touched."
