import type { Request, Response } from 'express';
import { HttpError } from '../http/errors.js';
import type { EventHub, StreamEvent } from '../events/hub.js';
import { frame } from '../events/routes.js';

/**
 * A filtered view of a project's live stream (FLR-T-9.6), as server-sent events: the owner's
 * comments stream passes every comment event; a share link's passes only its own link's comments,
 * the head moving (for a link that follows main) and nothing that names who did it. Each event is
 * re-made by `pick` — what a viewer receives is chosen, field by field, not passed through.
 *
 * Like the project stream, a comment line keeps quiet streams open through the tunnel, and the
 * stream ends after `maxAgeMs` so the client reconnects and is authorised afresh: an expired link,
 * or a signed-out owner, stops receiving within that. A revoked link's streams end at once
 * (`end: true`).
 */

export interface StreamOptions {
  readonly heartbeatMs?: number;
  readonly maxAgeMs?: number;
  readonly retryMs?: number;
  readonly maxBufferedBytes?: number;
}

/** What to send for an event: an event (re-made), nothing, or an event and then the end of the stream. */
export type Pick = (event: StreamEvent) => { type: string; data: unknown; end?: boolean } | null;

export async function openFilteredStream(req: Request, res: Response, hub: EventHub, projectId: string, pick: Pick, options: StreamOptions = {}): Promise<void> {
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  const retryMs = options.retryMs ?? 3_000;
  const maxBuffered = options.maxBufferedBytes ?? 256 * 1024;
  try {
    await hub.start();
  } catch {
    throw new HttpError(503, 'live updates are unavailable; try again shortly');
  }
  if (res.writableEnded || req.socket.destroyed) return;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  res.flushHeaders();
  res.write(`retry: ${String(retryMs)}\n\n`);

  let ended = false;
  const write = (event: StreamEvent): void => {
    if (ended) return;
    res.write(frame(event));
    if (res.writableLength > maxBuffered) end();
  };
  const send = (event: StreamEvent): void => {
    const picked = pick(event);
    if (picked === null) return;
    write({ id: event.id, type: picked.type as StreamEvent['type'], data: picked.data });
    if (picked.end === true) end();
  };
  const { resumption, unsubscribe } = hub.subscribe(projectId, send, lastEventIdOf(req));
  const heartbeat = setInterval(() => {
    if (!ended) res.write(': heartbeat\n\n');
  }, heartbeatMs);
  const expiry = setTimeout(() => { end(); }, maxAgeMs);
  heartbeat.unref();
  expiry.unref();
  const untrack = hub.track(() => { end(); });
  function end(): void {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe();
    untrack();
    if (!res.writableEnded) res.end();
  }
  res.on('close', end);

  if (resumption !== null && !resumption.resumed) {
    write({ id: hub.latestId, type: 'resync', data: { reason: resumption.reason } });
    return;
  }
  const missed = resumption?.missed ?? [];
  for (const event of missed) send(event);
  write({ id: hub.latestId, type: 'ready', data: { resumed: resumption !== null } });
}

function lastEventIdOf(req: Request): string | null {
  const header = req.get('last-event-id');
  if (header !== undefined && header.trim() !== '') return header.trim().slice(0, 100);
  const query = req.query['lastEventId'];
  return typeof query === 'string' && query.trim() !== '' ? query.trim().slice(0, 100) : null;
}
