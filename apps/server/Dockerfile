# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/server/Dockerfile .
# The api image also carries the editor's static build: one origin, one cookie, no CORS — the same
# shape as Foreman, whose server serves its console.

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.34.5
WORKDIR /repo

# Fetch from the lockfile alone so dependency layers survive source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @d3-floorspec/server... --filter @d3-floorspec/web...
RUN pnpm --filter @d3-floorspec/server... build && pnpm --filter @d3-floorspec/web build
# The release-age policy gates *resolving* new versions, which happens at `pnpm install` on a
# developer's machine. This step reproduces a lockfile that already passed it, so the check is off
# here and only here.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @d3-floorspec/server deploy --prod --config.minimum-release-age=0 --config.inject-workspace-packages=true /out

FROM ${NODE_IMAGE} AS runtime
# pg_dump takes the pre-migration dump at boot (ported from Foreman, FRM-REQ-007). The client must
# match the server's major version: a newer pg_restore writes settings Postgres 16 refuses. Debian's
# package follows the distribution, so this comes from PGDG, whose signing key ships inside Debian's
# postgresql-common: no key is fetched over the network.
ARG POSTGRES_MAJOR=16
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-client-${POSTGRES_MAJOR} \
    && rm -rf /var/lib/apt/lists/* \
    && pg_dump --version | grep -q " ${POSTGRES_MAJOR}\." \
    && pg_restore --version | grep -q " ${POSTGRES_MAJOR}\."
ENV NODE_ENV=production PORT=3400 WEB_DIST=/app/public BACKUP_DIR=/backups PREMIGRATION_DUMP=true
WORKDIR /app
# Code stays root-owned so the service user cannot modify it; only /backups is writable.
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./public
RUN mkdir -p /backups && chown node:node /backups
USER node
EXPOSE 3400
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
