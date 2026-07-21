/**
 * Model tier selector.
 *
 * Spec tiering:
 * - Haiku 4.5   → per-article relevance filter, satire sanity check
 * - Sonnet 4.6  → digests, alerts, thesis evaluation, rebalance, chat
 * - Opus 4.7    → weekly Sunday deep-dive only
 */

export type LlmTask =
  | 'relevance-filter'
  | 'digest'
  | 'alert'
  | 'thesis-eval'
  | 'rebalance'
  | 'chat'
  | 'weekly-deepdive';

export const HAIKU_MODEL = 'claude-haiku-4-5' as const;
export const SONNET_MODEL = 'claude-sonnet-4-6' as const;
export const OPUS_MODEL = 'claude-opus-4-7' as const;

export type ClaudeModel =
  | typeof HAIKU_MODEL
  | typeof SONNET_MODEL
  | typeof OPUS_MODEL;

export function pickModel(task: LlmTask): ClaudeModel {
  switch (task) {
    case 'relevance-filter':
      return HAIKU_MODEL;
    case 'digest':
    case 'alert':
    case 'thesis-eval':
    case 'rebalance':
    case 'chat':
      return SONNET_MODEL;
    case 'weekly-deepdive':
      return OPUS_MODEL;
  }
}
