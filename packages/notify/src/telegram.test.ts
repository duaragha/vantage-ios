import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prepareTelegramMessage, TELEGRAM_TEXT_MAX_LENGTH } from './telegram.js';

describe('prepareTelegramMessage', () => {
  it('preserves short messages and their parse mode', () => {
    const prepared = prepareTelegramMessage('*Vantage*', 'Markdown');

    assert.deepEqual(prepared, {
      text: '*Vantage*',
      parseMode: 'Markdown',
      truncated: false,
    });
  });

  it('truncates oversized messages and clears parse mode', () => {
    const prepared = prepareTelegramMessage(`*Digest*\n\n${'x'.repeat(5000)}`, 'Markdown');

    assert.equal(prepared.truncated, true);
    assert.equal(prepared.parseMode, undefined);
    assert.ok(Array.from(prepared.text).length <= TELEGRAM_TEXT_MAX_LENGTH);
    assert.match(prepared.text, /\[message truncated; open Vantage for full details\]$/);
  });

  it('measures Unicode characters without splitting an emoji', () => {
    const prepared = prepareTelegramMessage('📈'.repeat(5000), 'Markdown');

    assert.equal(prepared.truncated, true);
    assert.ok(Array.from(prepared.text).length <= TELEGRAM_TEXT_MAX_LENGTH);
    assert.doesNotMatch(prepared.text, /\uFFFD/);
  });
});

it('isTelegramConfigured reflects env presence without side effects', async () => {
  const { isTelegramConfigured } = await import('./telegram.js');
  const savedToken = process.env['TELEGRAM_BOT_TOKEN'];
  const savedChat = process.env['TELEGRAM_CHAT_ID'];
  try {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
    assert.equal(isTelegramConfigured(), false);
    process.env['TELEGRAM_BOT_TOKEN'] = 'token';
    assert.equal(isTelegramConfigured(), false);
    process.env['TELEGRAM_CHAT_ID'] = 'chat';
    assert.equal(isTelegramConfigured(), true);
  } finally {
    if (savedToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
    else process.env['TELEGRAM_BOT_TOKEN'] = savedToken;
    if (savedChat === undefined) delete process.env['TELEGRAM_CHAT_ID'];
    else process.env['TELEGRAM_CHAT_ID'] = savedChat;
  }
});
