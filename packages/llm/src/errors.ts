/**
 * Typed error classes for the LLM wrapper.
 *
 * Surface these up from callClaude() so upstream code (digest/alert pipelines,
 * /ops page, self-alert) can distinguish operator-controlled stop conditions
 * (kill switch, spend caps, per-ticker caps) from genuine API failures.
 */

export class LlmWrapperError extends Error {
  public override readonly name: string = 'LlmWrapperError';
  constructor(message: string) {
    super(message);
  }
}

export class KillSwitchError extends LlmWrapperError {
  public override readonly name = 'KillSwitchError';
  constructor(message = 'killSwitch is enabled; LLM calls are blocked') {
    super(message);
  }
}

export class SpendCapError extends LlmWrapperError {
  public override readonly name = 'SpendCapError';
  public readonly scope: 'daily' | 'monthly';
  public readonly spentUsd: number;
  public readonly capUsd: number;

  constructor(
    scope: 'daily' | 'monthly',
    spentUsd: number,
    capUsd: number,
    message?: string,
  ) {
    super(
      message ??
        `${scope} spend cap breached: $${spentUsd.toFixed(4)} >= $${capUsd.toFixed(2)}`,
    );
    this.scope = scope;
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

export class TickerCapError extends LlmWrapperError {
  public override readonly name = 'TickerCapError';
  public readonly ticker: string;
  public readonly alertsToday: number;
  public readonly cap: number;

  constructor(ticker: string, alertsToday: number, cap: number) {
    super(
      `per-ticker alert cap reached for ${ticker}: ${alertsToday} >= ${cap} alerts today`,
    );
    this.ticker = ticker;
    this.alertsToday = alertsToday;
    this.cap = cap;
  }
}
