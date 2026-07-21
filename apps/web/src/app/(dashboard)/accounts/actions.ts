/**
 * Account server actions — CRUD + tax-aware placement suggestion.
 *
 * Auth: every dashboard route is gated by `src/middleware.ts` (iron-session),
 * which redirects to /login when a session is missing. Server actions invoked
 * from those routes inherit the same protection — they aren't reachable
 * without a valid cookie. Existing actions in this codebase don't double-check
 * the session inside the action body, so we match that convention.
 */

'use server';

import { revalidatePath } from 'next/cache';
import type { AccountType } from '@prisma/client';
import { Prisma, prisma } from '@vantage/db';
import {
  decidePlacement,
  type AccountSummary,
  type AccountType as PlacementAccountType,
  type StockProfile,
} from '@vantage/core/accounts';
import { getUsdCadRate } from '@vantage/core/fx';
import { auditPortfolio } from '@vantage/core/portfolio';
import { percentagePointsToRatio } from '@vantage/core/units';
import { componentLogger } from '@vantage/notify';
import { exchangeFromSymbol, isCaExchange } from '@vantage/sources';

const log = componentLogger('web/actions/accounts');

const ALLOWED_TYPES: readonly AccountType[] = [
  'TFSA',
  'RRSP',
  'SpousalRRSP',
  'RESP',
  'LIRA',
  'RRIF',
  'Personal',
  'Margin',
  'Corporate',
];

const ALLOWED_CURRENCIES: readonly ('CAD' | 'USD')[] = ['CAD', 'USD'];
const DEFAULT_BROKER = 'Wealthsimple';

export interface AccountInput {
  name: string;
  type: AccountType;
  currency: 'CAD' | 'USD';
  contributionRoomCad?: number | null;
  broker?: string;
}

type Err = { ok: false; error: string };

export type CreateAccountResult = { ok: true; id: number } | Err;
export type MutationResult = { ok: true } | Err;

function revalidateAccountPaths(): void {
  revalidatePath('/accounts');
  revalidatePath('/portfolio');
}

function validateInput(
  input: AccountInput,
  partial: boolean,
): { ok: true; data: AccountInput } | { ok: false; error: string } {
  let next = input;
  if (!partial || next.name !== undefined) {
    if (typeof next.name !== 'string') {
      return { ok: false, error: 'name is required' };
    }
    const trimmed = next.name.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: 'name must not be empty' };
    }
    if (trimmed.length > 80) {
      return { ok: false, error: 'name must be ≤ 80 characters' };
    }
    next = { ...next, name: trimmed };
  }
  if (!partial || next.type !== undefined) {
    if (!ALLOWED_TYPES.includes(next.type)) {
      return {
        ok: false,
        error: `type must be one of ${ALLOWED_TYPES.join(', ')}`,
      };
    }
  }
  if (!partial || next.currency !== undefined) {
    if (!ALLOWED_CURRENCIES.includes(next.currency)) {
      return { ok: false, error: 'currency must be CAD or USD' };
    }
  }
  if (next.contributionRoomCad !== undefined && next.contributionRoomCad !== null) {
    const v = Number(next.contributionRoomCad);
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, error: 'contributionRoomCad must be ≥ 0' };
    }
    next = { ...next, contributionRoomCad: v };
  }
  if (next.broker !== undefined) {
    if (typeof next.broker !== 'string' || next.broker.trim().length === 0) {
      return { ok: false, error: 'broker must be a non-empty string' };
    }
    next = { ...next, broker: next.broker.trim() };
  }
  return { ok: true, data: next };
}

export async function createAccount(input: AccountInput): Promise<CreateAccountResult> {
  const v = validateInput(input, false);
  if (!v.ok) return { ok: false, error: v.error };
  const data = v.data;

  try {
    const created = await prisma.account.create({
      data: {
        name: data.name,
        type: data.type,
        currency: data.currency,
        broker: data.broker ?? DEFAULT_BROKER,
        contributionRoomCad:
          data.contributionRoomCad !== undefined && data.contributionRoomCad !== null
            ? new Prisma.Decimal(data.contributionRoomCad)
            : null,
      },
    });
    revalidateAccountPaths();
    return { ok: true, id: created.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { ok: false, error: 'Name already in use.' };
    }
    log.error({ err }, 'create account failed');
    return { ok: false, error: 'account could not be created' };
  }
}

export async function updateAccount(
  id: number,
  input: Partial<AccountInput>,
): Promise<MutationResult> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'invalid account id' };
  }
  const v = validateInput(input as AccountInput, true);
  if (!v.ok) return { ok: false, error: v.error };
  const data = v.data;

  const patch: Prisma.AccountUpdateInput = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.type !== undefined) patch.type = data.type;
  if (data.currency !== undefined) patch.currency = data.currency;
  if (data.broker !== undefined) patch.broker = data.broker;
  if (data.contributionRoomCad !== undefined) {
    patch.contributionRoomCad =
      data.contributionRoomCad === null ? null : new Prisma.Decimal(data.contributionRoomCad);
  }

  try {
    await prisma.account.update({ where: { id }, data: patch });
    revalidateAccountPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        return { ok: false, error: 'Name already in use.' };
      }
      if (err.code === 'P2025') {
        return { ok: false, error: 'Account not found.' };
      }
    }
    log.error({ err, accountId: id }, 'update account failed');
    return { ok: false, error: 'account could not be updated' };
  }
}

export async function archiveAccount(id: number): Promise<MutationResult> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'invalid account id' };
  }
  try {
    await prisma.account.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    revalidateAccountPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { ok: false, error: 'Account not found.' };
    }
    log.error({ err, accountId: id }, 'archive account failed');
    return { ok: false, error: 'account could not be archived' };
  }
}

export async function unarchiveAccount(id: number): Promise<MutationResult> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'invalid account id' };
  }
  try {
    await prisma.account.update({
      where: { id },
      data: { archivedAt: null },
    });
    revalidateAccountPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { ok: false, error: 'Account not found.' };
    }
    log.error({ err, accountId: id }, 'unarchive account failed');
    return { ok: false, error: 'account could not be restored' };
  }
}

export async function deleteAccount(id: number): Promise<MutationResult> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'invalid account id' };
  }
  try {
    // Pre-flight: refuse deletion when any (open OR closed) position is still
    // attached. The DB enforces this too via onDelete: Restrict, but the
    // pre-flight gives a friendlier error.
    const count = await prisma.position.count({ where: { accountId: id } });
    if (count > 0) {
      return {
        ok: false,
        error: 'Account has positions — archive instead of delete.',
      };
    }
    await prisma.account.delete({ where: { id } });
    revalidateAccountPaths();
    return { ok: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        return { ok: false, error: 'Account not found.' };
      }
      if (err.code === 'P2003') {
        return {
          ok: false,
          error: 'Account has positions — archive instead of delete.',
        };
      }
    }
    log.error({ err, accountId: id }, 'delete account failed');
    return { ok: false, error: 'account could not be deleted' };
  }
}

// ---------------------------------------------------------------------------
// Placement suggestion (consumed by /discovery and /portfolio add CTAs).
// ---------------------------------------------------------------------------

/**
 * Build a StockProfile for `ticker` from TickerUniverse + TickerMetrics so the
 * placement engine has enough signal. Missing rows degrade to conservative
 * defaults (treat unknown as low-growth, no-dividend, not speculative) so the
 * caller still gets a verdict.
 */
async function loadStockProfile(ticker: string): Promise<StockProfile> {
  const [universe, metrics] = await Promise.all([
    prisma.tickerUniverse.findUnique({
      where: { symbol: ticker },
      select: { exchange: true, isLottery: true, marketCapUsd: true },
    }),
    prisma.tickerMetrics.findUnique({
      where: { ticker },
      select: {
        dividendYieldTtm: true,
        epsGrowth5y: true,
        revenueGrowth5y: true,
        beta: true,
        marketCapUsd: true,
      },
    }),
  ]);
  const suffixExchange = exchangeFromSymbol(ticker);
  const exchange = suffixExchange !== 'US' ? suffixExchange : (universe?.exchange ?? 'US');
  const listingCountry: 'US' | 'CA' = isCaExchange(exchange) ? 'CA' : 'US';

  // Prefer epsGrowth5y; fall back to revenueGrowth5y when EPS is missing.
  const growth = percentagePointsToRatio(metrics?.epsGrowth5y ?? metrics?.revenueGrowth5y);

  const marketCap = metrics?.marketCapUsd
    ? Number(metrics.marketCapUsd)
    : universe?.marketCapUsd
      ? Number(universe.marketCapUsd)
      : null;

  return {
    ticker,
    listingCountry,
    dividendYieldTtm: percentagePointsToRatio(metrics?.dividendYieldTtm),
    growth5y: growth,
    beta: metrics?.beta ?? null,
    isSpeculative: universe?.isLottery ?? false,
    marketCapUsd: marketCap,
  };
}

async function loadAccountSummaries(): Promise<AccountSummary[]> {
  const [accounts, usdCadRate] = await Promise.all([
    prisma.account.findMany({
      include: {
        positions: {
          select: { ticker: true, shares: true, avgCost: true, currency: true, closedAt: true },
        },
      },
    }),
    getUsdCadRate(),
  ]);

  // currentValueCad here is approximate: it uses avgCost x shares for speed.
  // Conversion is still per position because account denomination does not
  // determine a listing's quote currency.
  return accounts
    .filter((a) => (a.type as string) !== 'Corporate') // not modelled in core
    .map((a) => {
      const open = a.positions.filter((p) => p.closedAt === null);
      const audit = auditPortfolio({ positions: open, usdCadRate });
      const currency: 'CAD' | 'USD' = a.currency === 'USD' ? 'USD' : 'CAD';
      const summary: AccountSummary = {
        id: a.id,
        type: a.type as PlacementAccountType,
        currency,
        contributionRoomCad: a.contributionRoomCad !== null ? Number(a.contributionRoomCad) : null,
        currentValueCad: audit.totalValueCad,
        archived: a.archivedAt !== null,
      };
      return summary;
    });
}

export interface AccountSuggestion {
  accountId: number | null;
  rationale: string;
}

/**
 * Suggest the best account for `ticker` using the tax-aware placement engine
 * in @vantage/core. Returns `accountId: null` when no eligible open
 * account exists; callers should fall back to a manual picker.
 */
export async function suggestAccountForTicker(ticker: string): Promise<AccountSuggestion> {
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(normalized)) {
    return { accountId: null, rationale: 'Invalid ticker.' };
  }
  try {
    const [profile, accounts] = await Promise.all([
      loadStockProfile(normalized),
      loadAccountSummaries(),
    ]);
    const decision = decidePlacement(profile, accounts);
    return { accountId: decision.bestAccountId, rationale: decision.rationale };
  } catch (err) {
    log.error({ err, ticker: normalized }, 'account suggestion failed');
    return {
      accountId: null,
      rationale: 'Suggestion unavailable.',
    };
  }
}
