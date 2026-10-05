import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { logger } from '../logger.js';
import { CHANNEL, type ProjectEventType } from './types.js';
import type { Envelope } from './publish.js';

/**
 * The fan-out side of the live stream (FLR-T-3.5): one LISTEN connection per api process, a ring of
 * recent events per project for resumption, and the subscribers it delivers to.
 *
 * **Event IDs** are `<epoch>-<n>`: `epoch` is this hub's, fresh on every start, and `n` counts every
 * event this process has received, across all projects — so it increases within each project too,
 * and "the subscriber has seen up to n" holds for every project at once. A `Last-Event-ID` from
 * another epoch (a restart, or another process behind a balancer) cannot be resumed from here: the
 * subscriber is told to resync, which is always correct and costs one re-fetch.
 *
 * **Resumption** is possible when nothing the subscriber missed has been forgotten: every event for
 * the project after `n` is still in its ring. A ring forgets when it overflows (its `floor` rises to
 * the newest event it dropped), when a project's ring is evicted, or when the listener lost its
 * connection — notifications sent while nobody was listening are gone, so every ID issued before
 * then becomes unresumable.
 */

export type StreamEventType = ProjectEventType | 'resync' | 'ready';

export interface StreamEvent {
  readonly id: string;
  readonly type: StreamEventType;
  readonly data: unknown;
}

export type Subscriber = (event: StreamEvent) => void;

export interface HubOptions {
  /** Events kept per project for resumption. */
  readonly ringSize?: number;
  /** Projects with a ring; the least recently used is evicted past this. */
  readonly maxProjects?: number;
  /** First reconnect delay after the listener loses its connection; doubles to `maxBackoffMs`. */
  readonly backoffMs?: number;
  readonly maxBackoffMs?: number;
}

interface Ring {
  /** The newest event ID (its `n`) this ring no longer holds; resumption needs `n >= floor`. */
  floor: number;
  readonly events: { n: number; event: StreamEvent }[];
}

/** What a subscriber gets on connecting: either the events it missed, or an instruction to resync. */
export type Resumption =
  | { readonly resumed: true; readonly missed: readonly StreamEvent[] }
  | { readonly resumed: false; readonly reason: 'unknown-id' | 'expired' };

export class EventHub {
  readonly epoch = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  private counter = 0;
  /** No ID at or below this can be resumed from, in any project (eviction, a lost listener). */
  private globalFloor = 0;
  private readonly rings = new Map<string, Ring>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly ringSize: number;
  private readonly maxProjects: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;

  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoff: number;
  private everConnected = false;
  private closed = false;
  /** Every stream's teardown, so `close` can end them all and let the HTTP server stop. */
  private readonly closers = new Set<() => void>();

  constructor(
    private readonly databaseUrl: string,
    options: HubOptions = {},
  ) {
    this.ringSize = options.ringSize ?? 512;
    this.maxProjects = options.maxProjects ?? 256;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.backoff = this.backoffMs;
  }

  /** The ID of the newest event this process has issued: what a fresh subscriber has "seen". */
  get latestId(): string {
    return this.idOf(this.counter);
  }

  get listening(): boolean {
    return this.client !== null;
  }

  /**
   * Listen, if not already. Resolves once LISTEN is in effect, so a subscriber attached after it
   * cannot miss a commit. Connects lazily: an api that never streams never holds the connection.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the event hub is closed'));
    if (this.client !== null) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl, application_name: 'd3-floorspec events' });
    client.on('notification', (message) => {
      if (message.channel === CHANNEL && message.payload !== undefined) this.receive(message.payload);
    });
    client.on('error', (error) => {
      this.lost(client, error);
    });
    client.on('end', () => {
      this.lost(client, null);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (error) {
      client.removeAllListeners('end');
      await client.end().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await client.end().catch(() => undefined);
      throw new Error('the event hub is closed');
    }
    this.client = client;
    this.backoff = this.backoffMs;
    if (this.everConnected) this.forget();
    this.everConnected = true;
  }

  /**
   * The listener's connection went away. Anything notified until it is back is lost, so once it is
   * back every subscriber is told to resync, and no earlier ID can be resumed from.
   */
  private lost(client: pg.Client, error: Error | null): void {
    if (this.client !== client) return;
    this.client = null;
    client.removeAllListeners();
    client.on('error', () => undefined);
    if (this.closed) return;
    logger.warn({ err: error?.message }, 'event listener lost its connection; reconnecting');
    // Bump the counter now, so even a reconnect that issues no event leaves pre-loss IDs unresumable.
    this.counter += 1;
    this.globalFloor = this.counter;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start().catch((error: unknown) => {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'event listener reconnect failed');
        this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
        this.scheduleReconnect();
      });
    }, this.backoff);
    this.retryTimer.unref();
  }

  /** After a reconnect: drop every ring and tell every subscriber to re-fetch. */
  private forget(): void {
    this.counter += 1;
    this.globalFloor = this.counter;
    this.rings.clear();
    const resync: StreamEvent = { id: this.idOf(this.counter), type: 'resync', data: { reason: 'listener-reconnected' } };
    for (const set of this.subscribers.values()) for (const subscriber of set) subscriber(resync);
  }

  /** A notification arrived: number it, keep it, deliver it. */
  receive(payload: string): void {
    let parsed: Partial<Record<keyof Envelope, unknown>> | null;
    try {
      parsed = JSON.parse(payload) as Partial<Record<keyof Envelope, unknown>> | null;
    } catch {
      logger.warn('ignored an event that is not JSON');
      return;
    }
    if (parsed?.v !== 1 || typeof parsed.p !== 'string' || (parsed.t !== 'head' && parsed.t !== 'changeset')) {
      logger.warn('ignored an event in an unknown shape');
      return;
    }
    const envelope = parsed as Envelope;
    this.counter += 1;
    const n = this.counter;
    const event: StreamEvent = { id: this.idOf(n), type: envelope.t, data: envelope.d };
    const ring = this.ringFor(envelope.p);
    ring.events.push({ n, event });
    while (ring.events.length > this.ringSize) {
      const dropped = ring.events.shift();
      if (dropped !== undefined) ring.floor = dropped.n;
    }
    const set = this.subscribers.get(envelope.p);
    if (set !== undefined) for (const subscriber of set) subscriber(event);
  }

  private ringFor(projectId: string): Ring {
    let ring = this.rings.get(projectId);
    if (ring !== undefined) {
      // Most recently used last, so the first key is the one to evict.
      this.rings.delete(projectId);
      this.rings.set(projectId, ring);
      return ring;
    }
    ring = { floor: this.globalFloor, events: [] };
    this.rings.set(projectId, ring);
    while (this.rings.size > this.maxProjects) {
      const [oldest, evicted] = this.rings.entries().next().value as [string, Ring];
      this.rings.delete(oldest);
      const newest = evicted.events.at(-1)?.n ?? evicted.floor;
      this.globalFloor = Math.max(this.globalFloor, newest);
    }
    return ring;
  }

  /**
   * Attach a subscriber to a project and work out what it missed since `lastEventId`, atomically:
   * nothing can arrive between the two, because nothing here awaits.
   */
  subscribe(projectId: string, subscriber: Subscriber, lastEventId: string | null): { resumption: Resumption | null; unsubscribe: () => void } {
    const resumption = lastEventId === null ? null : this.resume(projectId, lastEventId);
    let set = this.subscribers.get(projectId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(projectId, set);
    }
    set.add(subscriber);
    return {
      resumption,
      unsubscribe: () => {
        const current = this.subscribers.get(projectId);
        if (current === undefined) return;
        current.delete(subscriber);
        if (current.size === 0) this.subscribers.delete(projectId);
      },
    };
  }

  private resume(projectId: string, lastEventId: string): Resumption {
    const n = this.parse(lastEventId);
    if (n === null) return { resumed: false, reason: 'unknown-id' };
    const ring = this.rings.get(projectId);
    const floor = Math.max(this.globalFloor, ring?.floor ?? this.globalFloor);
    if (n < floor) return { resumed: false, reason: 'expired' };
    return { resumed: true, missed: (ring?.events ?? []).filter((e) => e.n > n).map((e) => e.event) };
  }

  /** `n` from an ID of this epoch that this process could have issued; null for anything else. */
  private parse(id: string): number | null {
    const match = /^([0-9a-z]+)-(\d{1,15})$/.exec(id.trim());
    if (match === null || match[1] !== this.epoch) return null;
    const n = Number(match[2]);
    return Number.isSafeInteger(n) && n <= this.counter ? n : null;
  }

  idOf(n: number): string {
    return `${this.epoch}-${String(n)}`;
  }

  /** How many subscribers a project has; for tests and diagnostics. */
  subscriberCount(projectId?: string): number {
    if (projectId !== undefined) return this.subscribers.get(projectId)?.size ?? 0;
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }

  /** Register a stream's teardown, so `close` can end it. Returns the unregister. */
  track(close: () => void): () => void {
    this.closers.add(close);
    return () => this.closers.delete(close);
  }

  /** End every stream and the listener. The HTTP server can then close: no response is left open. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const close of [...this.closers]) close();
    this.closers.clear();
    await this.connecting?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    if (client !== null) {
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
    }
  }
}
