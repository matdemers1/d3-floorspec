import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

/**
 * Integration setup: create the test database if it is absent, then migrate it. Ported from
 * Foreman. These tests truncate, so they refuse any database whose name does not end in `_test`.
 */
export default async function setup(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) {
    throw new Error('DATABASE_URL is not set; integration tests need a Postgres 16 database ending in _test');
  }

  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to run integration tests against "${name}": the name must end in _test`);
  }

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (rowCount === 0) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }

  const require_ = createRequire(import.meta.url);
  const cli = join(dirname(require_.resolve('prisma/package.json')), 'build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: join(import.meta.dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stderr}${result.stdout}`);
  }
}
