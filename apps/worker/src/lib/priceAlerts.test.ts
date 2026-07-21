import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPriceAlertDelivery, evaluatePriceAlerts } from './priceAlerts.js';

describe('position price alerts', () => {
  it('fires each threshold once while price remains beyond it', () => {
    assert.deepEqual(
      evaluatePriceAlerts({
        price: 89,
        stopLoss: 90,
        priceTarget: 130,
        stopLossAlerted: false,
        priceTargetAlerted: false,
      }),
      {
        triggerStopLoss: true,
        triggerPriceTarget: false,
        rearmStopLoss: false,
        rearmPriceTarget: false,
      },
    );
    assert.equal(
      evaluatePriceAlerts({
        price: 88,
        stopLoss: 90,
        priceTarget: null,
        stopLossAlerted: true,
        priceTargetAlerted: false,
      }).triggerStopLoss,
      false,
    );
  });

  it('rearms only after price clears a two percent buffer', () => {
    assert.equal(
      evaluatePriceAlerts({
        price: 91,
        stopLoss: 90,
        priceTarget: null,
        stopLossAlerted: true,
        priceTargetAlerted: false,
      }).rearmStopLoss,
      false,
    );
    assert.equal(
      evaluatePriceAlerts({
        price: 92,
        stopLoss: 90,
        priceTarget: null,
        stopLossAlerted: true,
        priceTargetAlerted: false,
      }).rearmStopLoss,
      true,
    );
  });

  it('fires and rearms a target in the opposite direction', () => {
    assert.equal(
      evaluatePriceAlerts({
        price: 130,
        stopLoss: null,
        priceTarget: 130,
        stopLossAlerted: false,
        priceTargetAlerted: false,
      }).triggerPriceTarget,
      true,
    );
    assert.equal(
      evaluatePriceAlerts({
        price: 126,
        stopLoss: null,
        priceTarget: 130,
        stopLossAlerted: false,
        priceTargetAlerted: true,
      }).rearmPriceTarget,
      true,
    );
  });
});

describe('durable price alert deliveries', () => {
  const base = {
    positionId: 42,
    ticker: 'VDY.TO',
    accountName: 'TFSA',
    currency: 'CAD',
    threshold: 50,
    price: 49.5,
    observedAt: new Date('2026-07-17T15:00:00.000Z'),
    queuedAt: new Date('2026-07-17T15:00:05.000Z'),
  } as const;

  it('builds a replay-safe stop-loss delivery when Telegram is not configured', () => {
    const delivery = buildPriceAlertDelivery({ ...base, kind: 'stop-loss' });

    assert.equal(delivery.dedupeKey, 'price-alert:stop-loss:42:50:1784300400000');
    assert.match(delivery.text, /Stop loss CAD 50\.00 crossed at 49\.50/);
    assert.equal(delivery.expiresAt?.toISOString(), '2026-07-18T15:00:05.000Z');
  });

  it('uses a new dedupe key after a later re-armed crossing', () => {
    const first = buildPriceAlertDelivery({ ...base, kind: 'price-target' });
    const replay = buildPriceAlertDelivery({ ...base, kind: 'price-target' });
    const later = buildPriceAlertDelivery({
      ...base,
      kind: 'price-target',
      observedAt: new Date('2026-07-18T15:00:00.000Z'),
    });

    assert.equal(first.dedupeKey, replay.dedupeKey);
    assert.notEqual(first.dedupeKey, later.dedupeKey);
  });
});
