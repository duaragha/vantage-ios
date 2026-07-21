/**
 * /accounts — server-side data loader.
 *
 * Lists brokerage Accounts with rolled-up open-position counts and current
 * value in CAD. Conversion is per-POSITION, keyed off the position's own
 * currency (the listing currency its price + avgCost are denominated in) —
 * NOT the account currency. A CAD account can hold US (USD) listings, so a
 * USD position is multiplied by the USD→CAD rate while a CAD position passes
 * through, regardless of the account's denomination.
 *
 * Per-position price: latest DailyBar close, falling back to the position's
 * avgCost when no bar has been persisted yet.
 */

import type { Account, AccountType, DailyBar, Position } from '@prisma/client';
import { prisma, getLatestBarsForTickers } from '@vantage/db';
import { getUsdCadRate } from '@vantage/core/fx';

export interface AccountListItem {
  id: number;
  name: string;
  type: AccountType;
  currency: 'CAD' | 'USD';
  broker: string;
  contributionRoomCad: number | null;
  archivedAt: Date | null;
  positionCount: number;
  totalValueCad: number;
}

type PositionForValuation = Pick<
  Position,
  'id' | 'ticker' | 'shares' | 'avgCost' | 'closedAt' | 'currency'
>;

type AccountWithPositions = Account & {
  positions: PositionForValuation[];
};

function toAccountCurrency(raw: string | null | undefined): 'CAD' | 'USD' {
  return raw === 'USD' ? 'USD' : 'CAD';
}

async function valuateAccounts(
  rows: AccountWithPositions[],
): Promise<AccountListItem[]> {
  const allTickers = Array.from(
    new Set(
      rows.flatMap((a) =>
        a.positions
          .filter((p) => p.closedAt === null)
          .map((p) => p.ticker.toUpperCase()),
      ),
    ),
  );

  const [latestBars, usdCadRate] = await Promise.all([
    allTickers.length > 0
      ? getLatestBarsForTickers(allTickers)
      : Promise.resolve(new Map<string, DailyBar>()),
    getUsdCadRate(),
  ]);

  return rows.map((a) => {
    const accountCurrency = toAccountCurrency(a.currency);
    const open = a.positions.filter((p) => p.closedAt === null);
    // Sum directly in CAD, converting each position from its own native
    // currency. The position's price + avgCost are in the listing currency.
    let totalValueCad = 0;
    for (const p of open) {
      const shares = Number(p.shares);
      if (!Number.isFinite(shares) || shares <= 0) continue;
      const bar = latestBars.get(p.ticker.toUpperCase());
      const close = bar ? Number(bar.close) : Number(p.avgCost);
      if (!Number.isFinite(close) || close <= 0) continue;
      const nativeValue = shares * close;
      const positionCurrency = p.currency === 'CAD' ? 'CAD' : 'USD';
      totalValueCad +=
        positionCurrency === 'USD' ? nativeValue * usdCadRate : nativeValue;
    }

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      currency: accountCurrency,
      broker: a.broker,
      contributionRoomCad:
        a.contributionRoomCad !== null ? Number(a.contributionRoomCad) : null,
      archivedAt: a.archivedAt,
      positionCount: open.length,
      totalValueCad: Math.round(totalValueCad * 100) / 100,
    };
  });
}

export async function listAccounts(opts?: {
  includeArchived?: boolean;
}): Promise<AccountListItem[]> {
  const where = opts?.includeArchived ? {} : { archivedAt: null };
  const rows = await prisma.account.findMany({
    where,
    include: {
      positions: {
        select: {
          id: true,
          ticker: true,
          shares: true,
          avgCost: true,
          closedAt: true,
          currency: true,
        },
      },
    },
    // Non-archived first (archivedAt null → first), archived last; tie-break by id.
    orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
  });
  return valuateAccounts(rows);
}

export async function getAccount(id: number): Promise<AccountListItem | null> {
  const row = await prisma.account.findUnique({
    where: { id },
    include: {
      positions: {
        select: {
          id: true,
          ticker: true,
          shares: true,
          avgCost: true,
          closedAt: true,
          currency: true,
        },
      },
    },
  });
  if (!row) return null;
  const [item] = await valuateAccounts([row]);
  return item ?? null;
}
