import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db.js';

const config = loadConfig({
  PUBLIC_URL: 'http://localhost:3400',
  DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none',
  KEK: Buffer.alloc(32, 1).toString('base64'),
  PEPPER: Buffer.alloc(32, 2).toString('base64'),
});

describe('the app', () => {
  it('answers liveness without touching the database', async () => {
    const server = createApp({ config, db: createDb(config.DATABASE_URL) }).listen(0);
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    const api = await fetch(`http://127.0.0.1:${String(port)}/api/nothing-here`);
    server.close();
    expect(await res.json()).toEqual({ ok: true });
    expect(api.status).toBe(404);
  });
});
