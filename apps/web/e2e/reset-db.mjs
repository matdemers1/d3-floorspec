// Drop and create the e2e database, so every run starts from first-run setup. Refuses any database
// whose name does not end in `_test`, the same guard the integration suite keeps.
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
const name = url.pathname.replace(/^\//, '');
if (!/^[a-z0-9_]+_test$/.test(name)) {
  console.error(`reset-db: refusing to reset "${name}": the e2e database's name must end in _test`);
  process.exit(1);
}
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await client.query(`CREATE DATABASE "${name}"`);
await client.end();
console.log(`reset-db: ${name} is empty`);
