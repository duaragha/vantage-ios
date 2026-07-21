/** Convert a stored percentage-point value (12.5 means 12.5%) to a ratio. */
export function percentagePointsToRatio(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value / 100 : null;
}
