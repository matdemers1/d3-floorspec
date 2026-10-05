/**
 * A fixed-window counter per key, in memory (FLR-T-9.6). The share routes are the first public reads
 * beyond first-run setup, so each client gets a budget: of reads, of guesses at tokens that do not
 * exist, and — per account — of comments. One api process serves the Zima, so memory is the right
 * place; a restart forgets, which errs towards letting a person in.
 */
export class Limiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Keys held before the stale ones are swept, so a flood of addresses cannot grow it forever. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Count one against `key`. False once the window's budget is spent. */
  take(key: string, now = Date.now()): boolean {
    const window = this.current(key, now);
    window.count += 1;
    return window.count <= this.limit;
  }

  /** Whether `key` has budget left, without spending any. */
  allows(key: string, now = Date.now()): boolean {
    return this.current(key, now).count < this.limit;
  }

  /** Seconds until `key`'s window starts again. */
  retryAfter(key: string, now = Date.now()): number {
    const window = this.windows.get(key);
    if (window === undefined) return 0;
    return Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
  }

  private current(key: string, now: number): { start: number; count: number } {
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      if (window === undefined && this.windows.size >= this.maxKeys) this.sweep(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    return window;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
    // Still full: every key is live. Drop the oldest rather than refuse to count a new client.
    while (this.windows.size >= this.maxKeys) {
      const first = this.windows.keys().next();
      if (first.done === true) break;
      this.windows.delete(first.value);
    }
  }
}

export interface ShareLimits {
  /** Requests to the share routes, per client address. */
  readonly reads: Limiter;
  /** Tokens that are malformed or match no link, per client address. */
  readonly misses: Limiter;
  /** Comments written (created, replied, edited, deleted), per account. */
  readonly writes: Limiter;
}

export function shareLimits(overrides: Partial<Record<keyof ShareLimits, { limit: number; windowMs: number }>> = {}): ShareLimits {
  const make = (key: keyof ShareLimits, limit: number, windowMs: number) => new Limiter(overrides[key]?.limit ?? limit, overrides[key]?.windowMs ?? windowMs);
  return {
    // A viewer opening a link makes a handful of requests; walking around the 3D view makes none.
    reads: make('reads', 600, 5 * 60_000),
    misses: make('misses', 30, 10 * 60_000),
    writes: make('writes', 60, 10 * 60_000),
  };
}
