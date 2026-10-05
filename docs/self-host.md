# Self-hosting D3 Floorspec

This guide takes a machine with nothing but Docker on it to a running D3 Floorspec: the editor and
api, PostgreSQL, the job worker and the IFC worker, under Docker Compose. Then it creates the
operator account, and connects Claude Code over MCP. It is the same stack that runs
floorspec.d3cloud.io, built from source on your machine.

D3 Floorspec sends no telemetry: it connects to your PostgreSQL and, if you turn it on, to your
D3 Auth. That is all. Every project can be exported as a Floorspec document at any time (see the
README's *Your house, your data*).

## 1. What you need

- **macOS or Linux** with **Docker** — Docker Desktop, OrbStack, or Docker Engine — and **Compose
  2.24 or newer** (`docker compose version`). The overlay uses Compose's `!override` tag, which older
  versions do not understand.
- **git**, to get the source.
- About **4 GB of disk** for the images and their build cache, and **2 GB of memory** for the build.
- For a machine others reach over the network: a **domain name** and a **reverse proxy with TLS**
  (section 6). On a laptop you can skip that.
- Optional: **Node 22** on the computer you run Claude Code on, for the MCP shim (section 9).

## 2. Get the source

```bash
git clone https://github.com/matdemers1/d3-floorspec.git
cd d3-floorspec
```

Every command below runs from this directory. To run a fixed version rather than whatever `main`
is today, check out a commit or tag: `git checkout <commit>`.

## 3. Configure

The stack reads two env files in `deploy/`. Both are ignored by git; keep them out of backups that
leave the machine, because they hold the instance's secrets.

### Generate the secrets

The api needs two keys of 32 random bytes, base64: **KEK** (it encrypts two-factor secrets at
rest) and **PEPPER** (it is mixed into every password hash). It refuses to start without them, or
with anything shorter. Generate each one with any of these — they are equivalent:

```bash
openssl rand -base64 32
head -c 32 /dev/urandom | base64                    # no openssl
docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Also choose a **database password** (any long random string without `@`, `:` or `/`, since it goes
into a URL — `openssl rand -hex 24` or `head -c 24 /dev/urandom | xxd -p | tr -d '\n'` will do) and a
**setup token** of at least 24 characters, generated the same way.

> **Keep KEK and PEPPER forever.** They are not recoverable. Without PEPPER no password works; without
> KEK no two-factor code does. Store them where you store the database backups.

### Write the env files

`deploy/.env.postgres.dev` — the database container's own settings:

```bash
umask 077
cat > deploy/.env.postgres.dev <<'ENV'
POSTGRES_USER=floorspec
POSTGRES_PASSWORD=<the database password>
POSTGRES_DB=floorspec
ENV
```

`deploy/.env.dev` — the api's and the worker's settings:

```bash
umask 077
cat > deploy/.env.dev <<'ENV'
# The address people open, exactly: scheme, host and port, no path. It decides whether cookies are
# Secure (https) and the Sign in with D3 Auth redirect URI.
PUBLIC_URL=http://127.0.0.1:3400
DATABASE_URL=postgresql://floorspec:<the database password>@postgres:5432/floorspec
KEK=<a 32-byte base64 secret>
PEPPER=<another 32-byte base64 secret>
# First-run setup asks for this, so only you can create the operator account. Required on any
# machine others can reach; on a laptop you may leave it out.
SETUP_TOKEN=<your setup token>
ENV
```

On a laptop that only you use, `./deploy/dev-env.sh` writes both files for you, with fresh secrets
from `openssl`, `PUBLIC_URL=http://127.0.0.1:3400`, no setup token and a fixed local database
password. It never overwrites a file that exists, so you can run it and then edit the result.

The other settings, all optional, are listed in [`.env.example`](../.env.example) and in
`apps/server/src/config.ts`: Sign in with D3 Auth (section 7), rule packs (section 8),
`INVITE_TTL_HOURS` (how long an invite link lasts, default 168), and `ASSET_MAX_BYTES` (the largest
texture upload, default 20 MiB). Uploaded textures are kept in the `assets` volume at `/assets`,
which the image sets as `ASSET_DIR`; a JPEG's EXIF (a phone photo's GPS position among it), XMP and
comments, a PNG's text chunks and a WebP's EXIF and XMP are removed losslessly before a file is
stored — no pixel is re-encoded, and its colour profile stays. An EXIF orientation goes with the rest,
so rotate a sideways photo before you upload it.

## 4. Build and start

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --build --wait
```

`compose.yml` is the stack as it runs in production; `compose.dev.yml` builds its images from this
checkout instead of pulling them, reads the env files above, and publishes the api on
**127.0.0.1:3400** only — loopback, not the network. The first build takes a few minutes;
`--wait` returns when every container is healthy. On its first boot the api creates the schema
(it migrates on every boot, after a `pg_dump` into the `backups` volume whenever a migration is
pending).

Check it:

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml ps    # all healthy
curl -fsS http://127.0.0.1:3400/readyz                              # {"ok":true}
```

To save typing, `export COMPOSE_FILE=deploy/compose.yml:deploy/compose.dev.yml` and then plain
`docker compose ps`, `docker compose logs api`, and so on work from this directory.

**Another port.** If 3400 is taken, add a third file, `deploy/compose.local.yml`:

```yaml
services:
  api:
    ports: !override
      - "127.0.0.1:8080:3400"
```

and pass it last: `-f deploy/compose.yml -f deploy/compose.dev.yml -f deploy/compose.local.yml`
(or append `:deploy/compose.local.yml` to `COMPOSE_FILE`). Set `PUBLIC_URL` to match.

## 5. First-run setup

Open `PUBLIC_URL` in a browser. With no account yet, it shows **Set up D3 Floorspec**: your name,
email, a password of at least 12 characters, and the setup token. That account is the
**operator**. Setup works exactly once; afterwards the route is gone. Everyone else joins by an
invite link the operator creates under **Invites**: there is no public sign-up.

The same, without a browser:

```bash
curl -fsS -c cookies.txt -H 'content-type: application/json' \
  -d '{"email":"you@example.com","displayName":"You","password":"<12+ characters>","setupToken":"<your setup token>"}' \
  http://127.0.0.1:3400/auth/setup
# {"status":"signed_in"}
```

Turn on two-factor sign-in under **Account** afterwards.

## 6. Reach it from other machines

Keep the api on loopback and put a reverse proxy with TLS in front of it on the same host. Set
`PUBLIC_URL` to the https address, restart the api
(`docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --wait`), and the session
cookie becomes `Secure`. With [Caddy](https://caddyserver.com), which gets its own certificate:

```caddyfile
floorspec.example.com {
	reverse_proxy 127.0.0.1:3400
}
```

Any proxy works if it passes the `Host` and `Authorization` headers through and does not buffer
`text/event-stream` responses (the editor's live updates). A Cloudflare Tunnel needs no open port at
all: `deploy/compose.tunnel.yml` is the overlay floorspec.d3cloud.io uses, with the token in an env
file. Set `SETUP_TOKEN` *before* the instance is first reachable.

## 7. Optional: Sign in with D3 Auth

D3 Floorspec has its own password sign-in, which always works. It can also offer **Sign in with
D3 Auth** — or any OpenID Connect provider that issues the same tokens. A D3 Auth sign-in never
creates an account: people link it to their existing account under **Account**, and the operator
still invites everyone.

Register a client at your provider:

| | |
|---|---|
| Client type | confidential web client (it has a secret) |
| Token endpoint authentication | `client_secret_basic` |
| PKCE | required, `S256` |
| ID token signing | `ES256` (D3 Auth's default) |
| Redirect URI | `<PUBLIC_URL>/auth/oidc/callback` — e.g. `https://floorspec.example.com/auth/oidc/callback` |
| Post-logout redirect URI | `<PUBLIC_URL>/` |
| Scopes | `openid profile email d3:roles` |

With D3 Auth, `deploy/floorspec.d3auth.json` is the manifest floorspec.d3cloud.io registered —
change the URIs to yours and import it. Then add the three settings to `deploy/.env.dev`, all
three or none:

```bash
D3AUTH_ISSUER=https://auth.example.com
D3AUTH_CLIENT_ID=floorspec
D3AUTH_CLIENT_SECRET=<the client secret your provider showed you>
```

and restart the api. The api runs discovery at boot; if the provider cannot be reached, the
sign-in screen simply shows one button, and the api logs why. The same issuer's access tokens are
accepted at `/mcp` for Claude's own connector (a separate **public** client with PKCE and no
secret — `deploy/floorspec-mcp.d3auth.json` — whose redirect URI is Claude's); its key set is read
from `<issuer>/oidc/jwks` unless `D3AUTH_JWKS_URI` says otherwise.

## 8. Optional: rule packs

Advisory building-code findings come from **Floorspec Rules** packs, read from a directory at
boot. Without one, findings say no pack is installed. Mount a directory of built packs (each
`*.json`, or each `<name>/generated/pack.json`) into the api with `deploy/compose.local.yml`:

```yaml
services:
  api:
    volumes:
      - /srv/floorspec/rule-packs:/rule-packs:ro
```

and set `RULE_PACKS_DIR=/rule-packs` in `deploy/.env.dev` (and `RULE_PROFILE=/rule-packs/<profile>.json`
to evaluate them under a jurisdiction profile). A pack that does not validate stops the boot with
its name, so a broken pack is never silently ignored. Findings are advice, never a plan review: the
authority having jurisdiction decides.

## 9. Connect Claude Code over MCP

D3 Floorspec is an MCP server at `<PUBLIC_URL>/mcp`. Claude reads your projects and proposes
changes; with an **agent** token its edits land in a named changeset that you accept or reject on
the project page, never straight on the plan.

1. In the editor, open **Account › API tokens**, pick the project, set **Access** to **Agent —
   proposes changesets**, and create the token. It is shown once: copy it (`fls_…`). A **Read
   only** token reads, renders and exports; a **Write** token commits to the plan as you.
2. Connect Claude Code — directly over HTTP:

   ```bash
   claude mcp add --transport http floorspec http://127.0.0.1:3400/mcp \
     --header "Authorization: Bearer fls_…"
   ```

   or with the **Floorspec plugin**, which carries the stdio shim `floorspec-mcp` and the design
   partner skill, from this checkout:

   ```bash
   export FLOORSPEC_URL=http://127.0.0.1:3400   # your PUBLIC_URL
   export FLOORSPEC_TOKEN=fls_…
   claude --plugin-dir ./plugin
   ```

   The shim is one file with no dependencies (`plugin/bin/floorspec-mcp.mjs`, Node 22); it
   forwards Claude Code's messages to `FLOORSPEC_URL`'s `/mcp` with your token and nowhere else.

Check the connection without Claude:

```bash
curl -fsS -H "Authorization: Bearer fls_…" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:3400/mcp
```

or through the shim, as Claude Code would run it:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' |
  FLOORSPEC_URL=http://127.0.0.1:3400 FLOORSPEC_TOKEN=fls_… node plugin/bin/floorspec-mcp.mjs
```

Either answers with the tools: `floorspec_describe`, `floorspec_apply`, `floorspec_propose`,
`floorspec_render`, `floorspec_export` and the rest.

## 10. Backups

Everything is in PostgreSQL (the `pgdata` volume), except uploaded textures, which are files in
the `assets` volume named by the SHA-256 of their bytes (`ASSET_DIR`, `/assets` in the image). The
nightly backup mirrors that volume into `backups/assets`. The api takes a `pg_dump` into the `backups`
volume before every migration, takes a nightly backup there (`floorspec-<time>.dump` with a
manifest, kept `BACKUP_RETENTION_DAYS`), and once a week restores the newest into a scratch database
and opens a project from it — the restore drill. `docs/runbooks/restore.md` has both, a real
restore step by step, and the alert email (`MAIL_RELAY_URL`, `MAIL_RELAY_TOKEN`, `ALERT_TO`) that
tells you when either fails. Run them now with
`… exec api node dist/cli/run-job.js backup` or `… restore-drill`. They are all on this machine's
disk, so keep copies off it:

```bash
# A dump file, with the api's own pinned pg_dump, into the backups volume; prints its path
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml exec api node dist/cli/backup.js
# Copy the volume's dumps out
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml cp api:/backups ./floorspec-backups
# Or straight from the database container, to a file here
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml exec -T postgres \
  pg_dump -U floorspec --format=custom floorspec > floorspec-$(date +%F).dump
```

To restore into a fresh instance, start only the database, restore, then start the rest:

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --wait postgres
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml exec -T postgres \
  pg_restore -U floorspec -d floorspec --clean --if-exists < floorspec-YYYY-MM-DD.dump
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --build --wait
```

A restore needs the same `KEK` and `PEPPER` as the instance that made the dump. Each project's
`model.json` (the editor's **Download model.json**) is a second, portable copy of its plan.

## 11. Upgrading

```bash
git pull                     # or: git fetch && git checkout <newer commit or tag>
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml up -d --build --wait
```

The new api dumps the database into the `backups` volume, applies any pending migrations, and
starts; a migration that fails stops the boot with the dump already taken. Migrations only move
forward: to go back to an older version after a schema change, restore the dump taken before it
(section 10) and check out the older commit. Read the commit log for anything that needs a new
setting.

## 12. Stopping and removing

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml down      # stop; data stays
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml down -v   # stop and DELETE the database and backups
```

## Troubleshooting

- **`d3-floorspec api refused to start`** in `docker compose logs api` names the setting: an unset
  or short `KEK`/`PEPPER`, a `SETUP_TOKEN` under 24 characters, D3 Auth settings that are not all
  three, a rule pack that does not validate.
- **An error about the `!override` tag** — Compose is older than 2.24; update Docker.
- **The setup screen says the token is wrong** — it is `SETUP_TOKEN` in `deploy/.env.dev`, as the
  api read it when it last started; restart the api after changing it.
- **Signed in, then signed straight out** — `PUBLIC_URL` is https but you opened http (or the
  other way round): the cookie's `Secure` flag follows `PUBLIC_URL`.
- **Claude Code's tools answer 401** — the token was revoked, or is for another project; a token
  reaches exactly one project.
