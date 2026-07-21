const RETRY_IMMEDIATELY_AT_MS = 0;

export function buildTickerMetricsCreate<T extends Record<string, unknown>>(
  data: T,
  providerAvailable: boolean,
): T {
  if (providerAvailable) return { ...data };
  return {
    ...data,
    fetchedAt: new Date(RETRY_IMMEDIATELY_AT_MS),
  };
}

/**
 * Build a null-safe update for a provider snapshot.
 *
 * A partial provider response must not erase the last known value. When the
 * provider is entirely unavailable, only newly computed liquidity is safe to
 * refresh and fetchedAt stays unchanged so the ticker remains retryable.
 */
export function buildTickerMetricsUpdate(
  data: Record<string, unknown>,
  providerAvailable: boolean,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const allowed = providerAvailable
    ? Object.keys(data).filter((key) => key !== 'ticker')
    : ['avgVolume30d', 'avgDollarVolume30d'];

  for (const key of allowed) {
    const value = data[key];
    if (value !== null && value !== undefined) update[key] = value;
  }
  return update;
}
