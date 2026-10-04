import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

describe('the app', () => {
  it('answers liveness', async () => {
    const server = createApp().listen(0);
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    server.close();
    expect(await res.json()).toEqual({ ok: true });
  });
});
