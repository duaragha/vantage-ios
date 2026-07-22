/**
 * Settings server actions — update UserSettings, toggle kill switch,
 * change password.
 */

'use server';

import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { getSettings, Prisma, updateSettings } from '@vantage/db';
import { verifyPassword } from '@/lib/auth';
import { callWorker } from '@/lib/worker';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/actions/settings');

export interface DiscoveryWeightsForm {
  news: number;
  earnings: number;
  insider: number;
  filings: number;
  momentum: number;
  sentiment: number;
  // Phase 18 — fundamentals + quality factors.
  epsGrowth: number;
  revenueGrowth: number;
  margins: number;
  valuation: number;
  profitability: number;
  balanceSheet: number;
  liquidity: number;
  size: number;
}

export type ExchangeCode = 'US' | 'TO' | 'NE' | 'V';

export interface NotificationDeliveryStatus {
  state: 'ready' | 'setup-required' | 'unavailable';
  pending: number;
  dead: number;
}

export interface SettingsFormPayload {
  monthlyBudget: number;
  singlePositionCapPct: number;
  sectorCapPct: number;
  intradayMoveThresholdPct: number;
  passCooldownDays: number;
  perTickerDailyAlertCap: number;
  dailySpendCapUsd: number;
  monthlySpendCapUsd: number;
  timezone: string;
  killSwitch: boolean;
  // Phase 15 — discovery engine tuning.
  discoveryWeights: DiscoveryWeightsForm;
  discoveryMinMcapUsd: number;
  // Phase 16 — exchanges the universe refresh iterates.
  exchangesEnabled: ExchangeCode[];
  // Phase 17 — catalyst engine knobs.
  catalystEnabled: boolean;
  catalystMaxPerDay: number;
  catalystRequireConjunction: boolean;
  catalystDailySpendCapUsd: number;
  notifyBuySuggestions: boolean;
  notifyRebalances: boolean;
  notifyExceptionalOpportunities: boolean;
  notifyScheduledDigests: boolean;
}

export async function saveSettings(
  input: SettingsFormPayload,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(input.monthlyBudget) || input.monthlyBudget < 0)
    return { ok: false, error: 'monthlyBudget must be a finite number ≥ 0' };
  if (
    !Number.isFinite(input.singlePositionCapPct) ||
    input.singlePositionCapPct < 0 ||
    input.singlePositionCapPct > 100
  )
    return { ok: false, error: 'singlePositionCapPct must be 0-100' };
  if (!Number.isFinite(input.sectorCapPct) || input.sectorCapPct < 0 || input.sectorCapPct > 100)
    return { ok: false, error: 'sectorCapPct must be 0-100' };
  if (
    !Number.isFinite(input.intradayMoveThresholdPct) ||
    input.intradayMoveThresholdPct <= 0 ||
    input.intradayMoveThresholdPct > 100
  )
    return { ok: false, error: 'intradayMoveThresholdPct must be above 0 and at most 100' };
  if (!Number.isInteger(input.passCooldownDays) || input.passCooldownDays < 0)
    return { ok: false, error: 'passCooldownDays must be a whole number ≥ 0' };
  if (
    !Number.isInteger(input.perTickerDailyAlertCap) ||
    input.perTickerDailyAlertCap < 0 ||
    input.perTickerDailyAlertCap > 100
  )
    return { ok: false, error: 'perTickerDailyAlertCap must be a whole number from 0-100' };
  if (
    !Number.isFinite(input.dailySpendCapUsd) ||
    !Number.isFinite(input.monthlySpendCapUsd) ||
    input.dailySpendCapUsd < 0 ||
    input.monthlySpendCapUsd < 0
  )
    return { ok: false, error: 'spend caps must be ≥ 0' };
  if (!Number.isFinite(input.discoveryMinMcapUsd) || input.discoveryMinMcapUsd < 0)
    return { ok: false, error: 'discoveryMinMcapUsd must be ≥ 0' };
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone }).format();
  } catch {
    return { ok: false, error: 'timezone must be a valid IANA timezone' };
  }
  if (
    !Number.isFinite(input.catalystMaxPerDay) ||
    input.catalystMaxPerDay < 1 ||
    input.catalystMaxPerDay > 5
  ) {
    return { ok: false, error: 'catalystMaxPerDay must be between 1 and 5' };
  }
  if (
    !Number.isFinite(input.catalystDailySpendCapUsd) ||
    input.catalystDailySpendCapUsd < 0.1 ||
    input.catalystDailySpendCapUsd > 5
  ) {
    return {
      ok: false,
      error: 'catalystDailySpendCapUsd must be between $0.10 and $5.00',
    };
  }
  const notificationFlags = [
    input.notifyBuySuggestions,
    input.notifyRebalances,
    input.notifyExceptionalOpportunities,
    input.notifyScheduledDigests,
  ];
  if (notificationFlags.some((value) => typeof value !== 'boolean')) {
    return { ok: false, error: 'notification preferences must be true or false' };
  }

  // Normalize discovery weights at save time — clamp to [0,1] and drop
  // non-finite entries (shouldn't happen post-form, but defense in depth).
  const weightKeys: (keyof DiscoveryWeightsForm)[] = [
    'news',
    'earnings',
    'insider',
    'filings',
    'momentum',
    'sentiment',
    'epsGrowth',
    'revenueGrowth',
    'margins',
    'valuation',
    'profitability',
    'balanceSheet',
    'liquidity',
    'size',
  ];
  const cleanedWeights: Record<string, number> = {};
  for (const k of weightKeys) {
    const v = Number(input.discoveryWeights[k]);
    if (!Number.isFinite(v)) continue;
    cleanedWeights[k] = Math.max(0, Math.min(1, v));
  }
  // Re-normalize so all weights sum to 1.0 (cosmetic — the scorer
  // tolerates any positive weights, but this makes the saved blob
  // deterministic and human-readable).
  const sum = Object.values(cleanedWeights).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    return { ok: false, error: 'Discovery weights must include at least one positive value' };
  }
  const normalized: Record<string, number> = Object.fromEntries(
    Object.entries(cleanedWeights).map(([k, v]) => [k, Math.round((v / sum) * 10000) / 10000]),
  );

  // Phase 16 — validate exchanges list.
  const ALLOWED_EXCHANGES: ExchangeCode[] = ['US', 'TO', 'NE', 'V'];
  const exchanges = (input.exchangesEnabled ?? []).filter((x): x is ExchangeCode =>
    ALLOWED_EXCHANGES.includes(x),
  );
  if (exchanges.length === 0) {
    return { ok: false, error: 'At least one exchange must be enabled' };
  }

  try {
    await updateSettings({
      monthlyBudget: new Prisma.Decimal(input.monthlyBudget),
      singlePositionCapPct: input.singlePositionCapPct,
      sectorCapPct: input.sectorCapPct,
      intradayMoveThresholdPct: input.intradayMoveThresholdPct,
      passCooldownDays: input.passCooldownDays,
      perTickerDailyAlertCap: input.perTickerDailyAlertCap,
      dailySpendCapUsd: new Prisma.Decimal(input.dailySpendCapUsd),
      monthlySpendCapUsd: new Prisma.Decimal(input.monthlySpendCapUsd),
      timezone: input.timezone,
      killSwitch: input.killSwitch,
      discoveryWeights: normalized as Prisma.InputJsonValue,
      discoveryMinMcapUsd: new Prisma.Decimal(input.discoveryMinMcapUsd),
      exchangesEnabled: exchanges as unknown as Prisma.InputJsonValue,
      catalystEnabled: input.catalystEnabled,
      catalystMaxPerDay: Math.floor(input.catalystMaxPerDay),
      catalystRequireConjunction: input.catalystRequireConjunction,
      catalystDailySpendCapUsd: new Prisma.Decimal(input.catalystDailySpendCapUsd),
      notifyBuySuggestions: input.notifyBuySuggestions,
      notifyRebalances: input.notifyRebalances,
      notifyExceptionalOpportunities: input.notifyExceptionalOpportunities,
      notifyScheduledDigests: input.notifyScheduledDigests,
    });
    revalidatePath('/settings');
    revalidatePath('/portfolio');
    revalidatePath('/discovery');
    return { ok: true };
  } catch (err) {
    log.error({ err }, 'save settings failed');
    return { ok: false, error: 'settings could not be saved' };
  }
}

export async function getNotificationDeliveryStatus(): Promise<NotificationDeliveryStatus> {
  const response = await callWorker<{
    telegram?: { configured?: boolean; pending?: number; dead?: number };
  }>('/health/deep', { includeErrorData: true });
  const telegram = response.data?.telegram;
  if (!telegram) return { state: 'unavailable', pending: 0, dead: 0 };
  return {
    state: telegram.configured ? 'ready' : 'setup-required',
    pending: Number(telegram.pending ?? 0),
    dead: Number(telegram.dead ?? 0),
  };
}

/** Send one real phone notification through the worker's configured bot. */
export async function sendTestNotification(): Promise<{ ok: boolean; error?: string }> {
  const response = await callWorker<{ ok?: boolean; messageId?: number }>('/jobs/telegram/test', {
    method: 'POST',
  });
  if (!response.ok || response.data?.ok !== true) {
    return { ok: false, error: 'Telegram delivery is not configured yet.' };
  }
  return { ok: true };
}

/**
 * Proxy POST /jobs/discover/compute to the worker so the settings page can
 * trigger an on-demand recompute after weights changes.
 */
export async function recomputeDiscoveryNow(): Promise<{
  ok: boolean;
  error?: string;
  detail?: unknown;
}> {
  const { callWorker } = await import('@/lib/worker');
  const res = await callWorker('/jobs/discover/compute', {
    method: 'POST',
    body: {},
  });
  if (!res.ok) {
    log.warn({ status: res.status, workerError: res.error }, 'discovery recompute failed');
    return { ok: false, error: 'discovery recompute unavailable' };
  }
  return { ok: true, detail: res.data };
}

export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!oldPassword || !newPassword) {
    return { ok: false, error: 'both fields required' };
  }
  if (newPassword.length < 8) {
    return { ok: false, error: 'new password must be ≥ 8 chars' };
  }
  const ok = await verifyPassword(oldPassword);
  if (!ok) return { ok: false, error: 'old password incorrect' };

  try {
    const hash = await bcrypt.hash(newPassword, 12);
    // Also persist to DB for when we eventually prefer DB hash over env hash.
    const current = await getSettings();
    if (!current) return { ok: false, error: 'settings are not initialized' };
    await updateSettings({ passwordHash: hash });
    return { ok: true };
  } catch (err) {
    log.error({ err }, 'change password failed');
    return { ok: false, error: 'password could not be changed' };
  }
}
