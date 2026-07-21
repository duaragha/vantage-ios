import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_CHAT_MESSAGE_CHARS, normalizeChatMessage } from './chatInput.ts';

describe('chat input', () => {
  it('trims a valid message', () => {
    assert.deepEqual(normalizeChatMessage('  compare VDY and XEI  '), {
      ok: true,
      message: 'compare VDY and XEI',
    });
  });

  it('rejects missing, non-string, and blank messages', () => {
    for (const value of [undefined, null, 42, {}, '   ']) {
      assert.deepEqual(normalizeChatMessage(value), {
        ok: false,
        error: 'message required',
        status: 400,
      });
    }
  });

  it('rejects a message above the bounded context size', () => {
    assert.deepEqual(normalizeChatMessage('x'.repeat(MAX_CHAT_MESSAGE_CHARS + 1)), {
      ok: false,
      error: 'message too long',
      status: 413,
    });
  });
});
