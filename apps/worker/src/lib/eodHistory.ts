export interface BarCoverage {
  oldest: Date | null;
  count: number;
}

/**
 * A full backfill is needed until at least one trading year is present and the
 * first stored bar lands near the requested calendar boundary. The tolerance
 * accounts for weekends and market holidays at the start of the window.
 */
export function requiresFullHistory(
  coverage: BarCoverage | undefined,
  oldestNeeded: Date,
  toleranceDays: number,
  minimumBars: number,
): boolean {
  if (!coverage?.oldest || coverage.count < minimumBars) return true;
  const latestAcceptableStart = new Date(
    oldestNeeded.getTime() + toleranceDays * 24 * 60 * 60 * 1000,
  );
  return coverage.oldest > latestAcceptableStart;
}
