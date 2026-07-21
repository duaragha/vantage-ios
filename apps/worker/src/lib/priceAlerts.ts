import type { QueueTelegramDeliveryInput } from '@vantage/db';

export interface PriceAlertState {
  price: number;
  stopLoss: number | null;
  priceTarget: number | null;
  stopLossAlerted: boolean;
  priceTargetAlerted: boolean;
}

export interface PriceAlertDecision {
  triggerStopLoss: boolean;
  triggerPriceTarget: boolean;
  rearmStopLoss: boolean;
  rearmPriceTarget: boolean;
}

const REARM_BUFFER = 0.02;
const PRICE_ALERT_TTL_MS = 24 * 60 * 60 * 1000;

export type PriceAlertKind = 'stop-loss' | 'price-target';

export interface PriceAlertDeliveryInput {
  kind: PriceAlertKind;
  positionId: number;
  ticker: string;
  accountName: string;
  currency: string;
  threshold: number;
  price: number;
  observedAt: Date;
  queuedAt?: Date;
}

/** Build one durable, replay-safe delivery for a threshold crossing. */
export function buildPriceAlertDelivery(
  input: PriceAlertDeliveryInput,
): QueueTelegramDeliveryInput {
  const queuedAt = input.queuedAt ?? new Date();
  const label = input.kind === 'stop-loss' ? 'Stop loss' : 'Price target';
  const verb = input.kind === 'stop-loss' ? 'crossed' : 'reached';

  return {
    dedupeKey: [
      'price-alert',
      input.kind,
      input.positionId,
      input.threshold,
      input.observedAt.getTime(),
    ].join(':'),
    text: [
      'Vantage price alert',
      `${input.ticker} in ${input.accountName}`,
      `${label} ${input.currency} ${input.threshold.toFixed(2)} ${verb} at ${input.price.toFixed(2)}.`,
    ].join('\n'),
    disableWebPagePreview: true,
    expiresAt: new Date(queuedAt.getTime() + PRICE_ALERT_TTL_MS),
  };
}

export function evaluatePriceAlerts(state: PriceAlertState): PriceAlertDecision {
  const validPrice = Number.isFinite(state.price) && state.price > 0;
  const stop = state.stopLoss;
  const target = state.priceTarget;

  return {
    triggerStopLoss: validPrice && stop !== null && state.price <= stop && !state.stopLossAlerted,
    triggerPriceTarget:
      validPrice && target !== null && state.price >= target && !state.priceTargetAlerted,
    rearmStopLoss:
      state.stopLossAlerted &&
      (stop === null || (validPrice && state.price > stop * (1 + REARM_BUFFER))),
    rearmPriceTarget:
      state.priceTargetAlerted &&
      (target === null || (validPrice && state.price < target * (1 - REARM_BUFFER))),
  };
}
