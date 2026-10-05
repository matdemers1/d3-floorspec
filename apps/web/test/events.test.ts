import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventsUrl, subscribe, type EventSourceLike, type FloorspecEvent, type StreamState } from '../src/lib/events';

/** An EventSource the test drives by hand. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, data?: unknown, lastEventId = ''): void {
    const event = { data: JSON.stringify(data ?? {}), lastEventId } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  /** The browser gave up (an error answer) or is retrying on its own. */
  fail(giveUp: boolean): void {
    this.readyState = giveUp ? 2 : 0;
    this.emit('error');
  }
}

const P = '01a10000-0000-7000-8000-000000000001';

describe('subscribe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness() {
    const sources: FakeSource[] = [];
    const events: FloorspecEvent[] = [];
    const states: StreamState[] = [];
    const unsubscribe = subscribe(P, (event) => events.push(event), {
      createEventSource: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      onState: (state) => states.push(state),
      minBackoffMs: 100,
      maxBackoffMs: 400,
    });
    const last = () => sources.at(-1) as FakeSource;
    return { sources, events, states, unsubscribe, last };
  }

  it('hands typed events to the handler', () => {
    const { events, last } = harness();
    expect(last().url).toBe(`/api/projects/${P}/events`);
    last().open();
    last().emit('ready', { resumed: false, replayed: 0 }, 'e-1');
    last().emit('head', { head: 'main', hash: 'h', seq: 2 }, 'e-2');
    expect(events).toEqual([
      { type: 'ready', id: 'e-1', data: { resumed: false, replayed: 0 } },
      { type: 'head', id: 'e-2', data: { head: 'main', hash: 'h', seq: 2 } },
    ]);
  });

  it('leaves a browser-side retry alone, and reconnects with the last ID when the browser gives up', () => {
    vi.useFakeTimers();
    const { sources, states, last } = harness();
    last().open();
    last().emit('head', {}, 'e-7');
    last().fail(false);
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(1);
    last().fail(true);
    expect(sources[0]?.closed).toBe(true);
    vi.advanceTimersByTime(99);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    expect(last().url).toBe(eventsUrl(P, 'e-7'));
    expect(last().url).toBe(`/api/projects/${P}/events?lastEventId=e-7`);
    // Backoff doubles while it keeps failing, and resets once open.
    last().fail(true);
    vi.advanceTimersByTime(199);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    last().open();
    expect(states).toEqual(['live', 'reconnecting', 'live']);
  });

  it('stops for good when unsubscribed', () => {
    vi.useFakeTimers();
    const { sources, events, unsubscribe, last } = harness();
    const first = last();
    first.fail(true);
    unsubscribe();
    vi.advanceTimersByTime(10_000);
    expect(sources).toHaveLength(1);
    first.emit('head', {}, 'e-1');
    expect(events).toEqual([]);
  });
});
