/**
 * /settings — edit UserSettings + change password.
 */

import * as React from 'react';
import { getSettings } from '@vantage/db';
import { FrostedPanel } from '@/components/FrostedPanel';
import { SettingsForm } from './SettingsForm';
import type { DiscoveryWeightsForm } from './actions';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

/** Discovery defaults mirror packages/core/src/discover/signals.ts DEFAULT_WEIGHTS. */
const DISCOVERY_DEFAULTS: DiscoveryWeightsForm = {
  // fundamentals — 55%
  epsGrowth: 0.12,
  revenueGrowth: 0.1,
  margins: 0.1,
  valuation: 0.1,
  profitability: 0.08,
  balanceSheet: 0.05,
  // quality — 10%
  liquidity: 0.05,
  size: 0.05,
  // attention/momentum — 35%
  news: 0.08,
  earnings: 0.08,
  momentum: 0.07,
  insider: 0.07,
  filings: 0.03,
  sentiment: 0.02,
};

function readDiscoveryWeights(raw: unknown): DiscoveryWeightsForm {
  if (typeof raw !== 'object' || raw === null) return { ...DISCOVERY_DEFAULTS };
  const obj = raw as Record<string, unknown>;
  // Legacy migration: a saved blob that lacks the Phase-18 fundamentals key
  // (`epsGrowth`) is from the old 6-key schema where weights summed to 1.0.
  // Merging recommended fundamentals defaults on top would push the sum to
  // ~1.65. Hand back a clean DEFAULT_WEIGHTS so the user re-tunes from the
  // new canonical baseline rather than inheriting a broken total.
  if (!('epsGrowth' in obj)) return { ...DISCOVERY_DEFAULTS };
  const out: DiscoveryWeightsForm = { ...DISCOVERY_DEFAULTS };
  for (const k of Object.keys(DISCOVERY_DEFAULTS) as (keyof DiscoveryWeightsForm)[]) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function readExchanges(raw: unknown): ('US' | 'TO' | 'NE' | 'V')[] {
  const DEFAULT: ('US' | 'TO' | 'NE' | 'V')[] = ['US', 'TO'];
  if (!Array.isArray(raw)) return DEFAULT;
  const out = raw.filter(
    (x): x is 'US' | 'TO' | 'NE' | 'V' => x === 'US' || x === 'TO' || x === 'NE' || x === 'V',
  );
  return out.length > 0 ? out : DEFAULT;
}

export default async function SettingsPage(): Promise<React.ReactElement> {
  let settings: Awaited<ReturnType<typeof getSettings>> = null;
  let dbError: string | null = null;
  try {
    settings = await getSettings();
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  return (
    <div className="cc-page-narrow max-w-4xl">
      <header className="mb-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          settings
        </div>
        <h1 className="cc-page-title">Knobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything the worker consults on each tick.
        </p>
      </header>

      <DbErrorBanner message={dbError} />

      {settings ? (
        <FrostedPanel padding="lg">
          <SettingsForm
            initial={{
              monthlyBudget: Number(settings.monthlyBudget),
              singlePositionCapPct: settings.singlePositionCapPct,
              sectorCapPct: settings.sectorCapPct,
              intradayMoveThresholdPct: settings.intradayMoveThresholdPct,
              passCooldownDays: settings.passCooldownDays,
              perTickerDailyAlertCap: settings.perTickerDailyAlertCap,
              dailySpendCapUsd: Number(settings.dailySpendCapUsd),
              monthlySpendCapUsd: Number(settings.monthlySpendCapUsd),
              timezone: settings.timezone,
              killSwitch: settings.killSwitch,
              discoveryWeights: readDiscoveryWeights(settings.discoveryWeights),
              discoveryMinMcapUsd: Number(settings.discoveryMinMcapUsd),
              exchangesEnabled: readExchanges(settings.exchangesEnabled),
              catalystEnabled: settings.catalystEnabled,
              catalystMaxPerDay: settings.catalystMaxPerDay,
              catalystRequireConjunction: settings.catalystRequireConjunction,
              catalystDailySpendCapUsd: Number(settings.catalystDailySpendCapUsd),
            }}
          />
        </FrostedPanel>
      ) : (
        <FrostedPanel padding="lg">
          <p className="text-sm text-muted-foreground">
            Settings row not found. Run the DB seed (
            <code className="font-mono text-xs">
              ADMIN_PASSWORD=… pnpm --filter @vantage/db prisma db seed
            </code>
            ).
          </p>
        </FrostedPanel>
      )}
    </div>
  );
}
