export const MAX_CHAT_MESSAGE_CHARS = 12_000;

export type NormalizedChatMessage =
  | { ok: true; message: string }
  | { ok: false; error: 'message required' | 'message too long'; status: 400 | 413 };

export function normalizeChatMessage(value: unknown): NormalizedChatMessage {
  if (typeof value !== 'string') {
    return { ok: false, error: 'message required', status: 400 };
  }
  const message = value.trim();
  if (!message) return { ok: false, error: 'message required', status: 400 };
  if (message.length > MAX_CHAT_MESSAGE_CHARS) {
    return { ok: false, error: 'message too long', status: 413 };
  }
  return { ok: true, message };
}
