import { useEffect, useSyncExternalStore } from 'react';
import { api, messageOf } from '../lib/api';
import { patch, type CommentsEndpoint, type CommentView, type Thread } from './api';

/**
 * Comments, read and written (FLR-T-9.6): one store per place they are shown — a share link's
 * viewer, or the owner's editor — kept live by that place's stream. The stream says only *that* a
 * comment changed; the store fetches the threads again, so what it shows is always what the server
 * answers to this reader.
 */

export interface PinTarget {
  element: string;
  level: string;
  /** Base units; null when the comment was started from the 3D view or the keyboard. */
  point: [number, number] | null;
}

export interface CommentsState {
  status: 'loading' | 'ready' | 'failed';
  threads: Thread[];
  error: string | null;
  /** The thread in focus: drawn strongest, scrolled to, and what a reply answers. */
  focus: string | null;
  busy: boolean;
}

/** What the stream says besides comments: the shared model moved, its findings changed, or the link was revoked. */
export type StreamNews = { type: 'model'; hash: string } | { type: 'findings' } | { type: 'revoked' } | { type: 'share' };

type Listener = () => void;

export class CommentsStore {
  state: CommentsState = { status: 'loading', threads: [], error: null, focus: null, busy: false };
  private readonly listeners = new Set<Listener>();
  private users = 0;
  private stop: (() => void) | null = null;
  private generation = 0;
  /** Told of everything else the stream carries. */
  onNews: ((news: StreamNews) => void) | null = null;
  /** False for a link that takes no comments: the store is then only its stream. */
  readsThreads = true;

  constructor(readonly endpoint: CommentsEndpoint) {}

  get = (): CommentsState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set(patch: Partial<CommentsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  load(): Promise<void> {
    const generation = ++this.generation;
    if (!this.readsThreads) {
      this.set({ status: 'ready', threads: [] });
      return Promise.resolve();
    }
    return api
      .get<{ threads: Thread[] }>(this.endpoint.list)
      .then(({ threads }) => {
        if (generation !== this.generation) return;
        const focus = this.state.focus !== null && threads.some((t) => t.id === this.state.focus) ? this.state.focus : null;
        this.set({ status: 'ready', threads, error: null, focus });
      })
      .catch((caught: unknown) => {
        if (generation !== this.generation) return;
        this.set({ status: this.state.threads.length === 0 ? 'failed' : 'ready', error: messageOf(caught) });
      });
  }

  /** Join: the first user loads and opens the stream; the last to leave closes it. */
  join(): () => void {
    this.users += 1;
    if (this.users === 1) {
      void this.load();
      this.stop = this.connect();
    }
    return () => {
      this.users -= 1;
      if (this.users === 0) {
        this.stop?.();
        this.stop = null;
      }
    };
  }

  private connect(): () => void {
    if (typeof EventSource === 'undefined') return () => undefined;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let backoff = 1_000;
    const open = () => {
      if (stopped) return;
      const current = new EventSource(this.endpoint.events);
      source = current;
      current.addEventListener('open', () => { backoff = 1_000; });
      current.addEventListener('ready', (e: MessageEvent<string>) => {
        // A fresh stream after a gap the server could not replay: read again what is shown.
        if (!(JSON.parse(e.data) as { resumed?: boolean }).resumed && this.state.status !== 'loading') void this.load();
      });
      current.addEventListener('resync', () => { void this.load(); });
      current.addEventListener('comment', () => { void this.load(); });
      current.addEventListener('share', () => { this.onNews?.({ type: 'share' }); });
      current.addEventListener('findings', () => { this.onNews?.({ type: 'findings' }); });
      current.addEventListener('model', (e: MessageEvent<string>) => {
        const { hash } = JSON.parse(e.data) as { hash: string };
        this.onNews?.({ type: 'model', hash });
      });
      current.addEventListener('revoked', () => {
        stopped = true;
        current.close();
        this.onNews?.({ type: 'revoked' });
      });
      current.addEventListener('error', () => {
        if (stopped || source !== current || current.readyState !== EventSource.CLOSED) return;
        current.close();
        timer = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      });
    };
    open();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
    };
  }

  private async write<T>(run: () => Promise<T>): Promise<T | null> {
    this.set({ busy: true, error: null });
    try {
      const result = await run();
      await this.load();
      return result;
    } catch (caught) {
      this.set({ error: messageOf(caught) });
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Start a thread pinned to an element (FLR-REQ-167). */
  async create(body: string, target: PinTarget): Promise<string | null> {
    const create = this.endpoint.create;
    if (create === undefined) return null;
    const made = await this.write(() => api.post<{ comment: CommentView }>(create, { body, element: target.element, level: target.level, ...(target.point === null ? {} : { point: target.point }) }));
    if (made !== null) this.set({ focus: made.comment.id });
    return made?.comment.id ?? null;
  }

  async reply(thread: string, body: string): Promise<boolean> {
    return (await this.write(() => api.post(this.endpoint.replies(thread), { body }))) !== null;
  }

  async edit(id: string, body: string): Promise<boolean> {
    return (await this.write(() => patch(this.endpoint.comment(id), { body }))) !== null;
  }

  async remove(id: string): Promise<boolean> {
    return (await this.write(async () => { await api.del(this.endpoint.comment(id)); return true; })) !== null;
  }

  async resolve(id: string, verb: 'resolve' | 'reopen'): Promise<boolean> {
    const resolve = this.endpoint.resolve;
    if (resolve === undefined) return false;
    return (await this.write(() => api.post(resolve(id, verb), {}))) !== null;
  }
}

const stores = new Map<string, CommentsStore>();

/** One store per endpoint, so the panel, the pins and the top bar's count share it. */
export function commentsAt(endpoint: CommentsEndpoint): CommentsStore {
  let store = stores.get(endpoint.list);
  if (store === undefined) {
    store = new CommentsStore(endpoint);
    stores.set(endpoint.list, store);
  }
  return store;
}

/** The store's state, with the store joined (loaded and live) while the component is mounted. */
export function useComments(store: CommentsStore): CommentsState {
  useEffect(() => store.join(), [store]);
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Threads still open, then resolved ones; numbered by when they were started, as their pins are. */
export function numbered(threads: readonly Thread[]): { thread: Thread; n: number }[] {
  return threads.map((thread, i) => ({ thread, n: i + 1 }));
}
