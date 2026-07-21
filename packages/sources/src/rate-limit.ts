/**
 * Shared token-bucket rate limiter.
 *
 * Each adapter owns an instance configured with `perMinute` (and optional
 * `perDay`). Call `await limiter.acquire()` before issuing a request; it blocks
 * until a token is free.
 *
 * Algorithm: classic leaky-bucket / token-bucket hybrid.
 *   - minute-bucket: capacity = perMinute, refills at perMinute/60_000 per ms
 *   - day-bucket (optional): capacity = perDay, refills linearly over 24h
 *   - Both must have >=1 token before a request is released.
 *   - Burst behavior: full capacity available on a cold bucket. Sustained rate
 *     is bounded by refill rate, so bursts don't starve later callers — the
 *     first N burst through, then subsequent callers wait for refill.
 *
 * Waiters are served FIFO so no caller is indefinitely starved.
 */

interface Bucket {
  /** current tokens (float) */
  tokens: number;
  /** max tokens */
  capacity: number;
  /** tokens added per ms */
  refillPerMs: number;
  /** last time we refilled (ms since epoch) */
  lastRefill: number;
}

export interface RateLimiterOptions {
  perMinute: number;
  perDay?: number;
  /** injectable clock for tests; defaults to Date.now */
  now?: () => number;
}

export class RateLimiter {
  private readonly minute: Bucket;
  private readonly day: Bucket | null;
  private readonly now: () => number;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(opts: RateLimiterOptions) {
    if (opts.perMinute <= 0) {
      throw new Error('perMinute must be > 0');
    }
    if (opts.perDay !== undefined && opts.perDay <= 0) {
      throw new Error('perDay must be > 0 when provided');
    }
    this.now = opts.now ?? Date.now;
    const startedAt = this.now();
    this.minute = {
      tokens: opts.perMinute,
      capacity: opts.perMinute,
      refillPerMs: opts.perMinute / 60_000,
      lastRefill: startedAt,
    };
    this.day = opts.perDay
      ? {
          tokens: opts.perDay,
          capacity: opts.perDay,
          refillPerMs: opts.perDay / 86_400_000,
          lastRefill: startedAt,
        }
      : null;
  }

  /** Refill a bucket in-place based on elapsed time since last refill. */
  private refill(b: Bucket, ts: number): void {
    const elapsed = ts - b.lastRefill;
    if (elapsed <= 0) return;
    b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
    b.lastRefill = ts;
  }

  /** How many ms until the given bucket has >=1 token? */
  private msUntilOne(b: Bucket): number {
    if (b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / b.refillPerMs);
  }

  /** Try to consume 1 token from both buckets. Returns 0 if granted, else ms to wait. */
  private tryConsume(): number {
    const ts = this.now();
    this.refill(this.minute, ts);
    if (this.day) this.refill(this.day, ts);
    const minuteWait = this.msUntilOne(this.minute);
    const dayWait = this.day ? this.msUntilOne(this.day) : 0;
    const wait = Math.max(minuteWait, dayWait);
    if (wait === 0) {
      this.minute.tokens -= 1;
      if (this.day) this.day.tokens -= 1;
      return 0;
    }
    return wait;
  }

  /**
   * Block until a token is available, then consume it. Waiters are served FIFO.
   */
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.tryConsume();
        if (wait === 0) {
          const next = this.queue.shift();
          if (next) next();
          continue;
        }
        await sleep(wait);
      }
    } finally {
      this.draining = false;
    }
  }

  /** For tests / diagnostics. */
  snapshot(): { minuteTokens: number; dayTokens: number | null; queued: number } {
    const ts = this.now();
    this.refill(this.minute, ts);
    if (this.day) this.refill(this.day, ts);
    return {
      minuteTokens: this.minute.tokens,
      dayTokens: this.day ? this.day.tokens : null,
      queued: this.queue.length,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
