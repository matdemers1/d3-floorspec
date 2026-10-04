import { writeFile } from 'node:fs/promises';

/**
 * The worker's liveness signal: a file touched on every tick. The compose healthcheck reads its
 * age, so a worker that hangs is reported unhealthy even though its process is still alive.
 */
export const HEARTBEAT_FILE = process.env['WORKER_HEARTBEAT_FILE'] ?? '/tmp/worker-heartbeat';

export async function beat(path: string = HEARTBEAT_FILE, now: Date = new Date()): Promise<void> {
  await writeFile(path, now.toISOString());
}
