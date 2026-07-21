import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  __resetSelfAlertState,
  formatSelfAlertBody,
  selfAlertDedupeKey,
  sendSelfAlert,
} from './selfAlert.js';
import { telegramBackoffMs } from './telegram.js';

beforeEach(() => {
  __resetSelfAlertState();
});

describe('self-alert formatting', () => {
  it('keeps arbitrary operational context valid as parser-free text', () => {
    const body = formatSelfAlertBody('error', 'query `failed` at C:\\vantage', {
      detail: 'first line\nsecond \\ line',
    });

    assert.match(body, /ERROR/);
    assert.match(body, /query `failed` at C:\\vantage/);
    assert.match(body, /"detail": "first line\\nsecond \\\\ line"/);
    assert.doesNotMatch(body, /```|\*ERROR\*/);
  });
});

describe('Telegram retry backoff', () => {
  it('matches the documented 500, 1500, 3500 millisecond sequence', () => {
    assert.deepEqual([1, 2, 3].map(telegramBackoffMs), [500, 1500, 3500]);
  });
});

describe('durable self-alert delivery', () => {
  it('queues before delivery and does not call Telegram directly', async () => {
    const queued: Array<{ dedupeKey: string; text: string }> = [];
    let directCalled = false;

    const result = await sendSelfAlert(
      'error',
      'Job failed: poll.test',
      { job: 'poll.test' },
      {
        now: () => Date.UTC(2026, 6, 17, 17, 0),
        queueDelivery: async (input) => {
          queued.push({ dedupeKey: input.dedupeKey, text: input.text });
          return { id: 42 };
        },
        sendDirect: async () => {
          directCalled = true;
          return { ok: true, messageId: 99 };
        },
      },
    );

    assert.deepEqual(result, { ok: true, queued: true, deliveryId: 42 });
    assert.equal(directCalled, false);
    assert.equal(queued.length, 1);
    assert.match(queued[0]?.dedupeKey ?? '', /^self-alert:[a-f0-9]{64}:\d+$/);
    assert.match(queued[0]?.text ?? '', /Job failed: poll\.test/);
  });

  it('uses a restart-stable key within each debounce window', () => {
    const windowMs = 30 * 60 * 1000;
    const windowStart = windowMs * 100;
    const key = selfAlertDedupeKey('error', 'job silent: poll.test', windowStart + 1);

    assert.equal(
      key,
      selfAlertDedupeKey('error', 'job silent: poll.test', windowStart + windowMs - 1),
    );
    assert.notEqual(
      key,
      selfAlertDedupeKey('error', 'job silent: poll.test', windowStart + windowMs),
    );
  });

  it('falls back to a direct send only when queue persistence fails', async () => {
    let directBody = '';
    const result = await sendSelfAlert('critical', 'database unavailable', undefined, {
      queueDelivery: async () => {
        throw new Error('database offline');
      },
      sendDirect: async (body) => {
        directBody = body;
        return { ok: true, messageId: 77 };
      },
    });

    assert.deepEqual(result, { ok: true, messageId: 77 });
    assert.match(directBody, /database unavailable/);
  });
});
