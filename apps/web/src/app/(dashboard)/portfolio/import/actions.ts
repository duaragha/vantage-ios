/**
 * Server action for bulk-importing positions.
 *
 * Multi-account aware: each call writes every row into ONE account, since the
 * Wealthsimple CSV export is per sub-account. The caller posts that
 * `accountId` alongside the file. For backward compatibility when the
 * pre-multi-account form hasn't been re-wired yet, missing accountId falls
 * back to the seed default account (id=1).
 */

'use server';

import { revalidatePath } from 'next/cache';
import { Prisma, prisma } from '@vantage/db';
import { deriveCurrency, exchangeFromSymbol } from '@vantage/sources';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/actions/portfolio-import');

export interface BulkRow {
  ticker: string;
  shares: number;
  avgCost: number;
  category: string;
  /** Optional per-row currency override. When omitted, inferred from the
   * ticker suffix (.TO/.NE/.V → CAD, else USD). */
  currency?: string | null;
}

function normalizeCurrency(raw: string | null | undefined): 'CAD' | 'USD' | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  if (c === 'CAD') return 'CAD';
  if (c === 'USD') return 'USD';
  return null;
}

export interface BulkImportResult {
  ok: boolean;
  created: string[];
  updated: string[];
  skipped: string[];
  error?: string;
}

const DEFAULT_ACCOUNT_ID = 1;

export async function bulkImportPositions(
  rows: BulkRow[],
  accountId?: number,
  /** Per-import currency selector. Applied to every row that doesn't carry its
   * own override and whose ticker suffix doesn't already imply a currency. */
  defaultCurrency?: string | null,
): Promise<BulkImportResult> {
  const importCurrency = normalizeCurrency(defaultCurrency);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  const targetAccountId =
    typeof accountId === 'number' && Number.isInteger(accountId) && accountId > 0
      ? accountId
      : DEFAULT_ACCOUNT_ID;

  try {
    const account = await prisma.account.findUnique({
      where: { id: targetAccountId },
      select: { id: true, archivedAt: true },
    });
    if (!account) {
      return {
        ok: false,
        created,
        updated,
        skipped,
        error: 'Account not found.',
      };
    }
    if (account.archivedAt) {
      return {
        ok: false,
        created,
        updated,
        skipped,
        error: 'Account is archived — unarchive it before importing.',
      };
    }

    for (const row of rows) {
      const ticker = row.ticker.toUpperCase();
      if (!/^[A-Z.-]{1,8}$/.test(ticker)) {
        skipped.push(ticker);
        continue;
      }
      if (!Number.isFinite(row.shares) || row.shares <= 0) {
        skipped.push(ticker);
        continue;
      }
      if (!Number.isFinite(row.avgCost) || row.avgCost < 0) {
        skipped.push(ticker);
        continue;
      }
      // Currency resolution per row: explicit row override → ticker suffix
      // (a .TO ticker is always CAD regardless of the import selector) →
      // per-import selector → 'USD'.
      const suffixCurrency = deriveCurrency(exchangeFromSymbol(ticker));
      const rowCurrency: 'CAD' | 'USD' =
        normalizeCurrency(row.currency) ??
        (suffixCurrency === 'CAD' ? 'CAD' : (importCurrency ?? suffixCurrency));

      const existing = await prisma.position.findUnique({
        where: {
          accountId_ticker: { accountId: targetAccountId, ticker },
        },
      });
      if (existing) {
        await prisma.position.update({
          where: { id: existing.id },
          data: {
            shares: new Prisma.Decimal(row.shares),
            avgCost: new Prisma.Decimal(row.avgCost),
            currency: rowCurrency,
            category: row.category,
            // Re-open if a previously-closed lot is being re-imported.
            closedAt: null,
            ...(existing.closedAt !== null
              ? { stopLossAlertedAt: null, priceTargetAlertedAt: null }
              : {}),
          },
        });
        updated.push(ticker);
      } else {
        await prisma.position.create({
          data: {
            ticker,
            shares: new Prisma.Decimal(row.shares),
            avgCost: new Prisma.Decimal(row.avgCost),
            currency: rowCurrency,
            category: row.category,
            accountId: targetAccountId,
          },
        });
        created.push(ticker);
      }
    }
    revalidatePath('/portfolio');
    revalidatePath('/accounts');
    return { ok: true, created, updated, skipped };
  } catch (err) {
    log.error({ err, accountId: targetAccountId }, 'portfolio import failed');
    return {
      ok: false,
      created,
      updated,
      skipped,
      error: 'portfolio import could not be completed',
    };
  }
}
