#!/usr/bin/env sh
# Writes the local env files compose.dev.yml reads, with fresh random secrets, if they are absent.
# Never overwrites. Local development and CI only.
set -eu
cd "$(dirname "$0")"
if [ ! -f .env.postgres.dev ]; then
  umask 077
  cat > .env.postgres.dev <<ENV
POSTGRES_USER=floorspec
POSTGRES_PASSWORD=floorspec-dev
POSTGRES_DB=floorspec
ENV
  echo "wrote deploy/.env.postgres.dev"
fi
if [ ! -f .env.dev ]; then
  umask 077
  cat > .env.dev <<ENV
PUBLIC_URL=http://127.0.0.1:3400
DATABASE_URL=postgresql://floorspec:floorspec-dev@postgres:5432/floorspec
KEK=$(openssl rand -base64 32)
PEPPER=$(openssl rand -base64 32)
ENV
  echo "wrote deploy/.env.dev"
fi
