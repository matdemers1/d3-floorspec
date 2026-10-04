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
ENV NODE_ENV=production PORT=3400 WEB_DIST=/app/public
WORKDIR /app
# Code stays root-owned so the service user cannot modify it.
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./public
USER node
EXPOSE 3400
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3400)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
