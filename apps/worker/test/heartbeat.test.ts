import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { beat } from '../src/heartbeat.js';

describe('heartbeat', () => {
  it('writes the time of the beat', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'flr-worker-')), 'beat');
    const now = new Date('2026-10-04T12:00:00.000Z');
    await beat(path, now);
    expect(await readFile(path, 'utf8')).toBe(now.toISOString());
  });
});
