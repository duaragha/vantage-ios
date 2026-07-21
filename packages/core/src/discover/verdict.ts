/**
 * Verdict — translate a DiscoveryScore + thesis status into a plain-English
 * action label for the /compare unified table.
 *
 * Pure, deterministic, no LLM. The /compare page needs to answer the "so what
 * do I DO about this ticker?" question without sending the user back to read
 * the raw score bar. We express that as a small enum + a color tone + a
 * one-line rationale.
 *
 * Two verdict families:
 *   - HELD verdicts: driven by Thesis.status, 30-day return, and position
 *     sizing relative to singlePositionCapPct.
 *   - UNHELD verdicts: driven by the discovery score + signal-breakdown
 *     quality checks (tier-1 news, earnings surprise, insider buys).
 *
 * The /discovery page intentionally still renders raw scores; verdicts only
 * live on /compare where the user is actively choosing between holdings.
 */

import type { ThesisStatus } from '@vantage/db';
import type { SignalBreakdown } from './signals.js';

const STRONG_DISCOVERY_SCORE = 6;
const WATCH_DISCOVERY_SCORE = 3;

/**
 * Canonical verdict label. Stable string union so UI code can switch on it.
 */
export type VerdictKind =
  | 'EXIT'
  | 'TRIM'
  | 'WATCH'
  | 'ADD'
  | 'HOLD+'
  | 'HOLD'
  | 'NEEDS THESIS'
  | 'BUY'
  | 'MONITOR'
  | 'AVOID';

/**
 * Color tone key — matches the palette used across the dashboard. Components
 * map these to concrete Tailwind classes so the verdict logic stays DOM-free.
 */
export type VerdictTone = 'emerald' | 'amber' | 'rose' | 'zinc';

export interface Verdict {
  kind: VerdictKind;
  tone: VerdictTone;
  /** Short one-line rationale for tooltips / legends. */
  rationale: string;
}

export interface VerdictInputHeld {
  held: true;
  score: number;
  thesisStatus: ThesisStatus | null;
  /** 30-day total return in percent (e.g. -12.3 for -12.3%). Null when unknown. */
  recentReturnPct: number | null;
  /** Current position weight as a percent of portfolio value (0-100). */
  positionWeightPct: number | null;
  /** Single-position cap in percent from UserSettings (e.g. 15). */
  singlePositionCapPct: number | null;
}

export interface VerdictInputUnheld {
  held: false;
  score: number;
  // Verdict only inspects news/earnings/insider, so callers (e.g. the compare
  // page) may pass a narrower view than the full SignalBreakdown.
  breakdown: Partial<SignalBreakdown> | null;
}

export type VerdictInput = VerdictInputHeld | VerdictInputUnheld;

/**
 * Compute the verdict for a row. See module doc for branch semantics.
 */
export function computeVerdict(input: VerdictInput): Verdict {
  return input.held ? computeHeldVerdict(input) : computeUnheldVerdict(input);
}

function computeHeldVerdict(input: VerdictInputHeld): Verdict {
  const { thesisStatus, recentReturnPct, positionWeightPct, singlePositionCapPct } = input;

  if (thesisStatus === null) {
    return {
      kind: 'NEEDS THESIS',
      tone: 'zinc',
      rationale: 'No thesis on file. Write one (or run Bootstrap) so we can evaluate it.',
    };
  }

  if (thesisStatus === 'Broken') {
    return {
      kind: 'EXIT',
      tone: 'rose',
      rationale: 'Thesis is Broken. Close the position.',
    };
  }

  if (thesisStatus === 'Weakening') {
    if (recentReturnPct !== null && recentReturnPct < -10) {
      return {
        kind: 'TRIM',
        tone: 'amber',
        rationale: 'Thesis is Weakening and price is down >10% in 30d; trim to reduce exposure.',
      };
    }
    return {
      kind: 'WATCH',
      tone: 'amber',
      rationale: 'Thesis is Weakening. Hold but watch the next catalyst.',
    };
  }

  if (thesisStatus === 'Strengthening') {
    // Room to grow = current weight < 80% of the single-position cap.
    const capHasData =
      positionWeightPct !== null && singlePositionCapPct !== null && singlePositionCapPct > 0;
    const roomToGrow =
      capHasData && (positionWeightPct as number) < (singlePositionCapPct as number) * 0.8;
    if (roomToGrow) {
      return {
        kind: 'ADD',
        tone: 'emerald',
        rationale:
          'Thesis is Strengthening and you are below 80% of the position cap — room to add.',
      };
    }
    return {
      kind: 'HOLD+',
      tone: 'emerald',
      rationale: 'Thesis is Strengthening but you are already near the position cap — hold.',
    };
  }

  // Intact.
  return {
    kind: 'HOLD',
    tone: 'zinc',
    rationale: 'Thesis is Intact. No action.',
  };
}

function computeUnheldVerdict(input: VerdictInputUnheld): Verdict {
  const { score, breakdown } = input;

  if (score < 0) {
    return {
      kind: 'AVOID',
      tone: 'rose',
      rationale: 'Negative composite score — active negative catalysts.',
    };
  }

  if (score >= STRONG_DISCOVERY_SCORE) {
    const hasNewsCoverage = breakdown !== null && (breakdown.news ?? 0) > 0;
    const hasEarningsBeat = breakdown !== null && (breakdown.earnings ?? 0) > 0;
    const hasInsiderBuys = breakdown !== null && (breakdown.insider ?? 0) > 0;
    if (hasNewsCoverage && (hasEarningsBeat || hasInsiderBuys)) {
      return {
        kind: 'BUY',
        tone: 'emerald',
        rationale: 'High composite score with news coverage plus earnings or insider confirmation.',
      };
    }
    // Score is high but signal quality is thin — park in watchlist.
    return {
      kind: 'WATCH',
      tone: 'amber',
      rationale:
        'Score is strong but confirming signals are thin — add to watchlist, verify before buying.',
    };
  }

  if (score >= WATCH_DISCOVERY_SCORE) {
    return {
      kind: 'WATCH',
      tone: 'amber',
      rationale: 'Moderate score — add to watchlist and re-check next week.',
    };
  }

  return {
    kind: 'MONITOR',
    tone: 'zinc',
    rationale: 'Low positive score — monitor but no action.',
  };
}

/**
 * Human-readable legend entries for each verdict. Keyed by kind so UI can
 * render them in order without duplicating the copy. Order matches the
 * mental model: held decisions first, then unheld.
 */
export interface VerdictLegendEntry {
  kind: VerdictKind;
  tone: VerdictTone;
  scope: 'held' | 'unheld';
  description: string;
}

export const VERDICT_LEGEND: readonly VerdictLegendEntry[] = Object.freeze([
  {
    kind: 'EXIT',
    tone: 'rose',
    scope: 'held',
    description: 'Thesis is Broken — close the position.',
  },
  {
    kind: 'TRIM',
    tone: 'amber',
    scope: 'held',
    description: 'Thesis Weakening + price down >10% in 30d; reduce exposure.',
  },
  {
    kind: 'WATCH',
    tone: 'amber',
    scope: 'held',
    description:
      'Thesis Weakening, price holding up — or moderate-score candidate for the watchlist.',
  },
  {
    kind: 'ADD',
    tone: 'emerald',
    scope: 'held',
    description: 'Thesis Strengthening with room below the position cap — add to the position.',
  },
  {
    kind: 'HOLD+',
    tone: 'emerald',
    scope: 'held',
    description: 'Thesis Strengthening but you are already near the cap — hold.',
  },
  {
    kind: 'HOLD',
    tone: 'zinc',
    scope: 'held',
    description: 'Thesis Intact — no action needed.',
  },
  {
    kind: 'NEEDS THESIS',
    tone: 'zinc',
    scope: 'held',
    description: 'No thesis on file — write one or run Bootstrap.',
  },
  {
    kind: 'BUY',
    tone: 'emerald',
    scope: 'unheld',
    description: 'Score ≥ 6.0 with tier-1 news plus earnings beat or insider buying.',
  },
  {
    kind: 'WATCH',
    tone: 'amber',
    scope: 'unheld',
    description: 'Moderate score (≥ 3.0); add to the watchlist.',
  },
  {
    kind: 'MONITOR',
    tone: 'zinc',
    scope: 'unheld',
    description: 'Low positive score — monitor only.',
  },
  {
    kind: 'AVOID',
    tone: 'rose',
    scope: 'unheld',
    description: 'Negative composite score — active negative catalysts.',
  },
]);
