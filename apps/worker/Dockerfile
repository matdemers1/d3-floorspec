# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/worker/Dockerfile .

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.34.5
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter @d3-floorspec/worker...
RUN pnpm --filter @d3-floorspec/worker... build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @d3-floorspec/worker deploy --prod --config.minimum-release-age=0 --config.inject-workspace-packages=true /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production WORKER_HEARTBEAT_FILE=/tmp/worker-heartbeat
WORKDIR /app
COPY --from=build /out ./
USER node
# Unhealthy when the heartbeat is older than two minutes: a hung worker, not merely a dead one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["sh", "-c", "test -n \"$(find /tmp/worker-heartbeat -mmin -2 2>/dev/null)\""]
CMD ["node", "dist/index.js"]
