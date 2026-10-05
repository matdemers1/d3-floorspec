/**
 * The editor's live view of a project (FLR-T-3.5): `GET /api/projects/:id/events` as server-sent
 * events. Same origin, so the session cookie travels on its own.
 *
 * Events say **that** something moved, never carry the model: on `head`, fetch main's new version
 * by hash; on `changeset`, fetch the scratch head's model for the ghosted overlay; on `resync`,
 * re-fetch everything you show — events were missed that cannot be replayed. Subscribe first and
 * load on `ready`, so nothing committed in between is missed; a re-fetch by hash is idempotent.
 *
 * The browser's EventSource reconnects on its own after a dropped connection, sending
 * `Last-Event-ID`, and the server replays what was missed. When it gives up instead (an error
 * answer, a proxy's 502 during a deploy), this reconnects with backoff and passes the last ID as
 * `?lastEventId=`, which an EventSource cannot send as a header.
 */

export interface HeadEvent {
  head: 'main';
  hash: string;
  seq: number;
  kind: 'create' | 'apply' | 'undo' | 'redo' | 'merge';
  authorKind: 'account' | 'agent' | 'token';
  /** The agent's name, `token:<id>`, or the account ID. */
  author: string;
  /** The changeset whose accept moved main, when one did. */
  changeset: string | null;
}

export interface ChangesetEvent {
  id: string;
  name: string;
  status: 'pending' | 'accepted' | 'rejected';
  change: 'opened' | 'appended' | 'accepted' | 'rejected' | 'replay-failed';
  /** `cs/<id>`. */
  head: string;
  /** Pending: the scratch head's version. Accepted: main's after the merge. Rejected: null. */
  hash: string | null;
  base: string;
  ops: number;
  createdBy: string;
  mergeMode: 'fast-forward' | 'replay' | null;
}

/** The jurisdiction profile the project's findings are evaluated under changed (FLR-T-6.8): fetch them again. */
export interface ProfileEvent {
  /** The profile now in use; null for the default. */
  id: string | null;
  name: string;
  change: 'chosen' | 'edited' | 'deleted';
}

export type FloorspecEvent =
  | { type: 'ready'; id: string; data: { resumed: boolean; replayed: number } }
  | { type: 'profile'; id: string; data: ProfileEvent }
  | { type: 'head'; id: string; data: HeadEvent }
  | { type: 'changeset'; id: string; data: ChangesetEvent }
  | { type: 'resync'; id: string; data: { reason: string } };

export type EventHandler = (event: FloorspecEvent) => void;

/** `live` once the stream is open; `reconnecting` while it is not. */
export type StreamState = 'live' | 'reconnecting';

/** The slice of EventSource this uses; injectable for tests. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface SubscribeOptions {
  onState?: (state: StreamState) => void;
  /** First delay before reconnecting after the browser gave up; doubles up to `maxBackoffMs`. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  createEventSource?: EventSourceFactory;
}

const TYPES = ['ready', 'head', 'changeset', 'profile', 'resync'] as const;
const CLOSED = 2;

export function eventsUrl(projectId: string, lastEventId: string | null): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/events`;
  return lastEventId === null ? base : `${base}?lastEventId=${encodeURIComponent(lastEventId)}`;
}

/** Subscribe to a project's events. Returns the unsubscribe. */
export function subscribe(projectId: string, handler: EventHandler, options: SubscribeOptions = {}): () => void {
  const create: EventSourceFactory = options.createEventSource ?? ((url) => new EventSource(url));
  const minBackoff = options.minBackoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;

  let source: EventSourceLike | null = null;
  let lastEventId: string | null = null;
  let backoff = minBackoff;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let state: StreamState | null = null;

  const setState = (next: StreamState) => {
    if (state === next) return;
    state = next;
    options.onState?.(next);
  };

  const connect = () => {
    if (stopped) return;
    const current = create(eventsUrl(projectId, lastEventId));
    source = current;
    current.addEventListener('open', () => {
      backoff = minBackoff;
      setState('live');
    });
    for (const type of TYPES) {
      current.addEventListener(type, (message) => {
        if (stopped || source !== current) return;
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        if (message.lastEventId !== '') lastEventId = message.lastEventId;
        handler({ type, id: message.lastEventId, data } as FloorspecEvent);
      });
    }
    current.addEventListener('error', () => {
      if (stopped || source !== current) return;
      setState('reconnecting');
      // CONNECTING: the browser is already retrying, with Last-Event-ID. CLOSED: it gave up.
      if (current.readyState !== CLOSED) return;
      current.close();
      source = null;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
  };

  connect();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
  };
}
