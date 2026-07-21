/**
 * Telegram formatters for Insights.
 *
 * Produces the final Markdown string handed to @vantage/notify. The icon
 * map and "Not investment advice." footer are stripped out here rather than
 * baked into the alert builder so the digest pipeline can reuse this for
 * non-Alert insight kinds too.
 *
 * Icon map (see spec ### LLM strategy + Phase 7 spec):
 *   Alert         → 🚨
 *   Rebalance     → ⚖️
 *   BuySuggestion → 💰
 *   ThesisUpdate  → 📋
 */

import type { Insight, InsightKind, Confidence } from '@vantage/db';
import { escapeForParseMode } from '@vantage/notify';

export interface FormatOptions {
  /**
   * Base URL for the dashboard. Appended with `/insights/<id>` to build the
   * deep link. Defaults to `http://localhost:3000`.
   */
  deepLinkBase?: string;
  /** Include the "Not investment advice." footer. Defaults true. */
  includeDisclaimer?: boolean;
}

export const INSIGHT_ICONS: Record<InsightKind, string> = {
  Alert: '🚨',
  Rebalance: '⚖️',
  BuySuggestion: '💰',
  ThesisUpdate: '📋',
};

/**
 * Rotation-specific icon — Rebalance Insights whose `actionJson.type` is
 * `'rotation'` render with 🔀 instead of ⚖️. Callers detect via the
 * `actionJson` shape before picking an icon.
 */
export const ROTATION_ICON = '🔀';

const DEFAULT_BASE = 'http://localhost:3000';

/**
 * Format an Insight as a Markdown (legacy) string for Telegram.
 *
 *   🚨 *<title>*
 *
 *   <body>
 *
 *   _Confidence: <Level>_
 *
 *   [View details](<deepLinkBase>/insights/<id>)
 *
 *   _Not investment advice._
 */
export function formatInsightForTelegram(
  insight: Pick<Insight, 'id' | 'kind' | 'title' | 'body' | 'confidence'>,
  opts: FormatOptions = {},
): string {
  const base = (opts.deepLinkBase ?? DEFAULT_BASE).replace(/\/+$/, '');
  const icon = INSIGHT_ICONS[insight.kind];
  const title = escapeForParseMode(insight.title, 'Markdown');
  // Body is prose — preserve newlines, but escape the four markdown markers
  // so user content can't smuggle bold/italic/link syntax into the payload.
  const body = escapeForParseMode(insight.body, 'Markdown');
  const confidenceLine = `_Confidence: ${confidenceLabel(insight.confidence)}_`;
  const deepLink = `[View details](${base}/insights/${insight.id})`;

  const parts: string[] = [`${icon} *${title}*`, '', body, '', confidenceLine, '', deepLink];

  if (opts.includeDisclaimer !== false) {
    parts.push('', '_Not investment advice._');
  }
  return parts.join('\n');
}

/**
 * Convenience wrapper — semantically identical to formatInsightForTelegram,
 * used by the alert dispatch pipeline where the caller has an Alert-kind
 * insight in hand. Name matches the Phase 7 spec.
 */
export function formatAlertForTelegram(
  insight: Pick<Insight, 'id' | 'kind' | 'title' | 'body' | 'confidence'>,
  deepLinkBase?: string,
): string {
  return formatInsightForTelegram(insight, {
    ...(deepLinkBase !== undefined ? { deepLinkBase } : {}),
  });
}

function confidenceLabel(c: Confidence): string {
  // Confidence enum values are already human-readable ("Low" | "Medium" |
  // "High") — we pass through. Kept as a function to centralize any future
  // locale/style tweaks.
  return c;
}

// ---------------------------------------------------------------------------
// Digest formatter
// ---------------------------------------------------------------------------

export type DigestKindLabel = 'morning' | 'evening' | 'monthly' | 'weekly';

const DIGEST_HEADERS: Record<DigestKindLabel, { emoji: string; title: string }> = {
  morning: { emoji: '🌅', title: 'Morning Briefing' },
  evening: { emoji: '🌆', title: 'Evening Wrap' },
  monthly: { emoji: '📆', title: 'Monthly Allocation Plan' },
  weekly: { emoji: '🔭', title: 'Weekly Deep-Dive' },
};

export interface FormatDigestOptions extends FormatOptions {
  /**
   * Sources that failed or returned nothing during this digest window.
   * Rendered as a "[sources failed: X, Y]" footer line.
   */
  failedSources?: ReadonlyArray<string>;
}

/**
 * Format a digest as a Telegram Markdown (legacy) string.
 *
 *   🌅 *Morning Briefing*
 *
 *   <summary prose>
 *
 *   *1.* 🚨 *<title>* — _Low/Medium/High_
 *   <body>
 *   [View](<url>)
 *
 *   *2.* ⚖️ *<title>* — _High_
 *   …
 *
 *   _[sources failed: provider-name]_  (only if any failed)
 *   _Not investment advice._
 */
export function formatDigestForTelegram(
  kind: DigestKindLabel,
  summary: string,
  insights: ReadonlyArray<Pick<Insight, 'id' | 'kind' | 'title' | 'body' | 'confidence'>>,
  opts: FormatDigestOptions = {},
): string {
  const base = (opts.deepLinkBase ?? DEFAULT_BASE).replace(/\/+$/, '');
  const header = DIGEST_HEADERS[kind];
  const parts: string[] = [`${header.emoji} *${escapeForParseMode(header.title, 'Markdown')}*`, ''];

  if (summary && summary.length > 0) {
    parts.push(escapeForParseMode(summary, 'Markdown'));
    parts.push('');
  }

  if (insights.length === 0) {
    parts.push('_No actionable items in this digest._');
  } else {
    insights.forEach((insight, idx) => {
      const icon = INSIGHT_ICONS[insight.kind];
      const title = escapeForParseMode(insight.title, 'Markdown');
      const body = escapeForParseMode(insight.body, 'Markdown');
      const url = `${base}/insights/${insight.id}`;
      parts.push(
        `*${idx + 1}.* ${icon} *${title}* — _${confidenceLabel(insight.confidence)}_`,
        body,
        `[View details](${url})`,
        '',
      );
    });
    // Trim trailing blank from last item.
    if (parts[parts.length - 1] === '') parts.pop();
  }

  const failed = opts.failedSources ?? [];
  if (failed.length > 0) {
    const list = failed.map((s) => escapeForParseMode(s, 'Markdown')).join(', ');
    parts.push('', `_\\[sources failed: ${list}\\]_`);
  }

  if (opts.includeDisclaimer !== false) {
    parts.push('', '_Not investment advice._');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Discovery digest formatter — Phase 15
// ---------------------------------------------------------------------------

/**
 * Pick the right icon for an Insight — Rebalance rows whose actionJson.type
 * is 'rotation' get 🔀 (dual-ticker visual); everything else follows
 * INSIGHT_ICONS.
 */
export function iconForInsight(insight: Pick<Insight, 'kind'> & { actionJson?: unknown }): string {
  if (insight.kind === 'Rebalance' && isRotationAction(insight.actionJson)) {
    return ROTATION_ICON;
  }
  return INSIGHT_ICONS[insight.kind];
}

function isRotationAction(actionJson: unknown): boolean {
  if (typeof actionJson !== 'object' || actionJson === null) return false;
  const obj = actionJson as Record<string, unknown>;
  return obj['type'] === 'rotation';
}

/**
 * Telegram formatter for the Saturday discovery digest.
 *
 * Header: 🛰️ *Market Discovery*
 * Summary line from the digest runner.
 * Per-insight cards:
 *   - rotations: dual-ticker card "TRIM ↔ BUY · Δ 0.74"
 *   - buys: 💰 standard buy card (same as formatDigestForTelegram)
 *
 * Pure function of the supplied summary + insights — callers persist first
 * then call this.
 */
export function formatDiscoveryDigestForTelegram(
  summary: string,
  insights: ReadonlyArray<
    Pick<Insight, 'id' | 'kind' | 'title' | 'body' | 'confidence'> & {
      actionJson?: unknown;
    }
  >,
  opts: FormatDigestOptions = {},
): string {
  const base = (opts.deepLinkBase ?? DEFAULT_BASE).replace(/\/+$/, '');
  const parts: string[] = [`🛰️ *${escapeForParseMode('Market Discovery', 'Markdown')}*`, ''];

  if (summary && summary.length > 0) {
    parts.push(escapeForParseMode(summary, 'Markdown'));
    parts.push('');
  }

  if (insights.length === 0) {
    parts.push('_Quiet week — no rotations or buys worth flagging._');
  } else {
    insights.forEach((insight, idx) => {
      const icon = iconForInsight(insight);
      const title = escapeForParseMode(insight.title, 'Markdown');
      const body = escapeForParseMode(insight.body, 'Markdown');
      const url = `${base}/insights/${insight.id}`;
      const isRotation = insight.kind === 'Rebalance' && isRotationAction(insight.actionJson);

      if (isRotation) {
        const rotMeta = extractRotationMeta(insight.actionJson);
        const rotHeader = rotMeta
          ? `*${idx + 1}.* ${icon} *${escapeForParseMode(rotMeta.trimTicker, 'Markdown')} ↔ ${escapeForParseMode(rotMeta.buyTicker, 'Markdown')}* — _Δ ${rotMeta.scoreDelta.toFixed(2)}_ · _${confidenceLabel(insight.confidence)}_`
          : `*${idx + 1}.* ${icon} *${title}* — _${confidenceLabel(insight.confidence)}_`;
        parts.push(rotHeader);
        parts.push(`_${title}_`);
        parts.push(body);
        parts.push(`[View details](${url})`);
        parts.push('');
      } else {
        parts.push(
          `*${idx + 1}.* ${icon} *${title}* — _${confidenceLabel(insight.confidence)}_`,
          body,
          `[View details](${url})`,
          '',
        );
      }
    });
    if (parts[parts.length - 1] === '') parts.pop();
  }

  const failed = opts.failedSources ?? [];
  if (failed.length > 0) {
    const list = failed.map((s) => escapeForParseMode(s, 'Markdown')).join(', ');
    parts.push('', `_\\[sources failed: ${list}\\]_`);
  }

  if (opts.includeDisclaimer !== false) {
    parts.push('', '_Not investment advice._');
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Catalyst formatter — Phase 17.11
// ---------------------------------------------------------------------------

const CATALYST_KIND_ICONS: Record<string, string> = {
  InsiderCluster: '🔬',
  EarningsBeat: '📈',
  Material8K: '📋',
  AnalystUpgrade: '⭐',
  mixed: '🧪',
};

const CATALYST_KIND_LABELS: Record<string, string> = {
  InsiderCluster: 'INSIDER CLUSTER',
  EarningsBeat: 'EARNINGS BEAT',
  Material8K: 'MATERIAL 8-K',
  AnalystUpgrade: 'ANALYST UPGRADE',
  mixed: 'MIXED CATALYSTS',
};

function conjunctionDots(level: number): string {
  const filled = Math.max(1, Math.min(3, Math.round(level)));
  return '●'.repeat(filled) + '○'.repeat(3 - filled);
}

interface CatalystActionMeta {
  catalystKind: string;
  conjunctionLevel: number;
  urgencyHours: number;
  urgencyExpiresAt: string | null;
}

function readCatalystMeta(actionJson: unknown): CatalystActionMeta | null {
  if (typeof actionJson !== 'object' || actionJson === null) return null;
  const obj = actionJson as Record<string, unknown>;
  const kind = obj['catalystKind'];
  if (typeof kind !== 'string' || kind.length === 0) return null;
  const level =
    typeof obj['conjunctionLevel'] === 'number' ? (obj['conjunctionLevel'] as number) : 1;
  const urgency = typeof obj['urgencyHours'] === 'number' ? (obj['urgencyHours'] as number) : 48;
  const expires =
    typeof obj['urgencyExpiresAt'] === 'string' ? (obj['urgencyExpiresAt'] as string) : null;
  return {
    catalystKind: kind,
    conjunctionLevel: level,
    urgencyHours: urgency,
    urgencyExpiresAt: expires,
  };
}

/**
 * Telegram formatter for a catalyst-driven BuySuggestion. Hooked from the
 * worker's catalyst dispatch path when `triggeredBy` starts with `catalyst:`.
 *
 *   🔬 *INSIDER CLUSTER · ●●○*
 *   *Buy 25 NBIS (~$612) — InsiderCluster*
 *
 *   <body>
 *
 *   _Confidence: High · Window: 48h · expires 2026-04-30T18:00Z_
 *
 *   [View](url)
 *
 *   _Not investment advice._
 */
export function formatCatalystAlertForTelegram(
  insight: Pick<Insight, 'id' | 'kind' | 'title' | 'body' | 'confidence'> & {
    actionJson?: unknown;
  },
  opts: FormatOptions = {},
): string {
  const base = (opts.deepLinkBase ?? DEFAULT_BASE).replace(/\/+$/, '');
  const meta = readCatalystMeta(insight.actionJson);
  const icon = meta ? (CATALYST_KIND_ICONS[meta.catalystKind] ?? '⚡') : '⚡';
  const label = meta ? (CATALYST_KIND_LABELS[meta.catalystKind] ?? 'CATALYST') : 'CATALYST';
  const dots = meta ? conjunctionDots(meta.conjunctionLevel) : '';
  const title = escapeForParseMode(insight.title, 'Markdown');
  const body = escapeForParseMode(insight.body, 'Markdown');

  const parts: string[] = [];
  parts.push(`${icon} *${label}${dots ? ` · ${dots}` : ''}*`);
  parts.push(`*${title}*`);
  parts.push('');
  parts.push(body);
  parts.push('');

  const detailBits: string[] = [`Confidence: ${insight.confidence}`];
  if (meta) {
    detailBits.push(`Window: ${meta.urgencyHours}h`);
    if (meta.urgencyExpiresAt) {
      const exp = new Date(meta.urgencyExpiresAt);
      if (!Number.isNaN(exp.getTime())) {
        detailBits.push(`expires ${exp.toISOString().slice(0, 16).replace('T', ' ')}Z`);
      }
    }
  }
  parts.push(`_${escapeForParseMode(detailBits.join(' · '), 'Markdown')}_`);
  parts.push('');
  parts.push(`[View details](${base}/insights/${insight.id})`);

  if (opts.includeDisclaimer !== false) {
    parts.push('', '_Not investment advice._');
  }
  return parts.join('\n');
}

interface RotationMeta {
  trimTicker: string;
  buyTicker: string;
  scoreDelta: number;
}

function extractRotationMeta(actionJson: unknown): RotationMeta | null {
  if (typeof actionJson !== 'object' || actionJson === null) return null;
  const obj = actionJson as Record<string, unknown>;
  if (obj['type'] !== 'rotation') return null;
  const trimTicker = typeof obj['trimTicker'] === 'string' ? (obj['trimTicker'] as string) : null;
  const buyTicker = typeof obj['buyTicker'] === 'string' ? (obj['buyTicker'] as string) : null;
  const scoreDelta = typeof obj['scoreDelta'] === 'number' ? (obj['scoreDelta'] as number) : null;
  if (!trimTicker || !buyTicker || scoreDelta === null) return null;
  return { trimTicker, buyTicker, scoreDelta };
}
