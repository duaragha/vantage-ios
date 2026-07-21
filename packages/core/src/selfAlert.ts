/**
 * Self-alert re-export.
 *
 * The implementation lives in @vantage/notify so the LLM wrapper can emit
 * spend-cap alerts without dragging core into a dep cycle. This module lets
 * callers import per the spec:
 *
 *   import { sendSelfAlert } from '@vantage/core';
 */

export {
  sendSelfAlert,
  __resetSelfAlertState,
  type SelfAlertLevel,
  type SendSelfAlertResult,
} from '@vantage/notify';
