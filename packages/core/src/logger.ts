/**
 * Shared logger re-export.
 *
 * The actual implementation lives in @vantage/notify so that the LLM
 * wrapper (which can't import from core without a cycle) can use it too. This
 * module re-exports the logger surface under the `core` namespace so callers
 * following the spec can write:
 *
 *   import { getLogger, logInfo, componentLogger } from '@vantage/core';
 */

export {
  getLogger,
  componentLogger,
  logInfo,
  logWarn,
  logError,
  logDebug,
  __resetLogger,
  type Logger,
} from '@vantage/notify';
