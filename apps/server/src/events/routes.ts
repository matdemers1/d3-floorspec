import type { Request, Response } from 'express';
import type { Db } from '../db.js';
import { Routes } from '../http/routes.js';
import { HttpError } from '../http/errors.js';
import type { EventHub, StreamEvent } from './hub.js';

/**
 * `GET /api/projects/:projectId/events` (FLR-T-3.5): the editor's live view of a project, as
 * server-sent events. Authorised like every other project read — a session, or a token with the
 * `read` scope, and 404 for a project the caller does not own — by the same route builder.
 *
 * Events:
 *   - `ready`     `{ resumed, replayed }` — the stream is live; sent once, after any replay.
 *   - `head`      main moved (see `HeadEventData`).
 *   - `changeset` a changeset opened, took more ops, was accepted or rejected, or failed to replay.
 *   - `resync`    `{ reason }` — what was missed cannot be replayed: re-fetch, then carry on.
 * Every event has an ID; reconnecting with `Last-Event-ID` (or `?lastEventId=`, for a client that
 * cannot set headers) replays what was missed, or answers `resync`.
 *
 * A comment line every `heartbeatMs` keeps the Cloudflare Tunnel (100 s idle limit) and any proxy
 * from closing a quiet stream, and the stream ends itself after `maxAgeMs` so the client reconnects
 * and is authorised afresh — a revoked token or an expired session stops receiving within that.
 */

export interface EventRouteOptions {
  readonly heartbeatMs?: number;
  readonly maxAgeMs?: number;
  /** What the client waits before reconnecting, sent as the stream's `retry:`. */
  readonly retryMs?: number;
  /** A subscriber this far behind is cut off; it reconnects and resumes or resyncs. */
  readonly maxBufferedBytes?: number;
}

export function eventRoutes(db: Db, hub: EventHub, options: EventRouteOptions = {}): Routes {
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  const retryMs = options.retryMs ?? 3_000;
  const maxBuffered = options.maxBufferedBytes ?? 1024 * 1024;
  const routes = new Routes(db);

  routes.read(
    '/:projectId/events',
    async (req, res) => {
      const project = req.project;
      if (project === undefined) throw new HttpError(404, 'project not found');
      // LISTEN is in effect before anything is attached, so nothing committed from here on is missed.
      try {
        await hub.start();
      } catch {
        throw new HttpError(503, 'live updates are unavailable; try again shortly');
      }
      if (res.writableEnded || req.socket.destroyed) return;

      open(res);
      res.write(`retry: ${String(retryMs)}\n\n`);

      let ended = false;
      const send = (event: StreamEvent): void => {
        if (ended) return;
        res.write(frame(event));
        if (res.writableLength > maxBuffered) end();
      };
      const { resumption, unsubscribe } = hub.subscribe(project.id, send, lastEventIdOf(req));
      const heartbeat = setInterval(() => {
        if (!ended) res.write(': heartbeat\n\n');
      }, heartbeatMs);
      const expiry = setTimeout(() => {
        end();
      }, maxAgeMs);
      heartbeat.unref();
      expiry.unref();
      const untrack = hub.track(() => {
        end();
      });
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
        send({ id: hub.latestId, type: 'resync', data: { reason: resumption.reason } });
        return;
      }
      const missed = resumption?.missed ?? [];
      for (const event of missed) send(event);
      send({ id: hub.latestId, type: 'ready', data: { resumed: resumption !== null, replayed: missed.length } });
    },
    { token: 'read' },
  );

  return routes;
}

/** Headers for a stream nothing between here and the browser may buffer, cache or transform. */
function open(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx and its kin (and some tunnels) hold a response until it is complete without this.
  res.setHeader('X-Accel-Buffering', 'no');
  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  res.flushHeaders();
}

export function frame(event: StreamEvent): string {
  // JSON.stringify never emits a raw newline, so one `data:` line carries the whole payload.
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function lastEventIdOf(req: Request): string | null {
  const header = req.get('last-event-id');
  if (header !== undefined && header.trim() !== '') return header.trim().slice(0, 100);
  const query = req.query['lastEventId'];
  return typeof query === 'string' && query.trim() !== '' ? query.trim().slice(0, 100) : null;
}
