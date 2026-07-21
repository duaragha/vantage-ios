/**
 * @vantage/notify — Telegram adapter + shared observability primitives.
 *
 * Phase 7: send + retry + chat_id verification. Graceful degradation when
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset (returns structured failure,
 * never throws).
 *
 * Phase 13: shared pino logger (getLogger / componentLogger / log* helpers)
 * and sendSelfAlert. Kept in @vantage/notify so @vantage/llm can
 * consume them without creating a dep cycle against @vantage/core.
 */

export const NOTIFY_PACKAGE = '@vantage/notify' as const;

export {
  sendMessage,
  sendInsight,
  verifyChatId,
  escapeForParseMode,
  isTelegramConfigured,
  __resetNotifyWarningFlag,
  type TelegramResult,
  type TelegramSuccess,
  type TelegramFailure,
  type TelegramFailureReason,
  type SendMessageOptions,
  type InsightPayload,
} from './telegram.js';

export {
  getLogger,
  componentLogger,
  logInfo,
  logWarn,
  logError,
  logDebug,
  __resetLogger,
  type Logger,
} from './logger.js';

export {
  sendSelfAlert,
  selfAlertDedupeKey,
  __resetSelfAlertState,
  type SelfAlertLevel,
  type SendSelfAlertDependencies,
  type SendSelfAlertResult,
} from './selfAlert.js';
