/**
 * Adaptive sweep interval.
 *
 * The embed and relevance-filter background sweeps exist only for crash
 * recovery — the hot path enqueues work directly. Polling the database every
 * few seconds around the clock is wasted work when the queue has been empty
 * for hours, so the sweep interval doubles after every empty sweep up to a
 * cap, and snaps back to the base the moment any work shows up (either a
 * sweep hit or a direct enqueue).
 *
 * Delivery guarantees are unchanged: direct enqueues process immediately; the
 * worst case for crash-recovery pickup moves from `base` to `max` — still
 * bounded and self-healing.
 */
export class AdaptiveInterval {
  readonly #baseMs: number;
  readonly #maxMs: number;
  #currentMs: number;

  constructor(baseMs: number, maxMs: number) {
    if (baseMs <= 0 || maxMs < baseMs) {
      throw new Error('AdaptiveInterval requires 0 < baseMs <= maxMs');
    }
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
    this.#currentMs = baseMs;
  }

  /** Current delay to wait before the next sweep. */
  get currentMs(): number {
    return this.#currentMs;
  }

  /** Report a sweep outcome; returns the delay for the next sweep. */
  observe(foundWork: boolean): number {
    this.#currentMs = foundWork ? this.#baseMs : Math.min(this.#maxMs, this.#currentMs * 2);
    return this.#currentMs;
  }

  /** Snap back to the base cadence (call when work arrives out-of-band). */
  reset(): void {
    this.#currentMs = this.#baseMs;
  }
}
