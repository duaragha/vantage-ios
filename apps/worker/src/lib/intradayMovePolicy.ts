/** Maximum age for a print used to emit a new intraday-move event. */
export const MAX_INTRADAY_PRINT_AGE_MS = 30 * 60 * 1000;

export interface IntradayPrint {
  timestamp: Date;
  size: number | null;
  dayVolume: number | null;
}

/**
 * An event needs a recent, positive market print. Null size/volume remains
 * valid for providers that do not expose those fields; an explicit zero does
 * not. The small future allowance tolerates provider/server clock skew.
 */
export function hasFreshTradablePrint(print: IntradayPrint, now: Date = new Date()): boolean {
  const timestampMs = print.timestamp.getTime();
  if (!Number.isFinite(timestampMs)) return false;
  const ageMs = now.getTime() - timestampMs;
  if (ageMs < -60_000 || ageMs > MAX_INTRADAY_PRINT_AGE_MS) return false;
  if (print.size !== null && (!(print.size > 0) || !Number.isFinite(print.size))) return false;
  if (print.dayVolume !== null && (!(print.dayVolume > 0) || !Number.isFinite(print.dayVolume))) {
    return false;
  }
  return true;
}
