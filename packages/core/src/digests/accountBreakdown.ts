/**
 * Shared per-account breakdown renderers used by morning + evening digests.
 *
 * Output is plain markdown that lands inside the LLM user prompt. Totals are
 * normalized to CAD per position so mixed listing currencies cannot be added
 * together as though they were the same unit.
 */

import { prisma, getLatestBarsForTickers } from '@vantage/db';
import type { RotationCandidate } from '../discover/rotation.js';
import { getUsdCadRate } from '../fx.js';
import { auditPortfolio } from '../portfolio/valuation.js';

interface AccountBreakdownRow {
  id: number;
  name: string;
  type: string;
  currency: 'CAD' | 'USD';
  positionCount: number;
  totalCad: number;
}

/**
 * Build a per-account portfolio breakdown, then render it as markdown bullets.
 * Returns an empty string when no non-archived accounts exist — caller can
 * skip the section header.
 */
export async function renderAccountBreakdown(): Promise<string> {
  const accounts = await prisma.account.findMany({
    where: { archivedAt: null },
    include: {
      positions: {
        select: {
          ticker: true,
          shares: true,
          avgCost: true,
          currency: true,
          closedAt: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  if (accounts.length === 0) return '';

  const allTickers = Array.from(
    new Set(
      accounts.flatMap((a) =>
        a.positions.filter((p) => p.closedAt === null).map((p) => p.ticker.toUpperCase()),
      ),
    ),
  );
  const [bars, usdCadRate] = await Promise.all([
    allTickers.length > 0 ? getLatestBarsForTickers(allTickers) : Promise.resolve(new Map()),
    getUsdCadRate(),
  ]);

  const rows: AccountBreakdownRow[] = [];
  for (const a of accounts) {
    const open = a.positions.filter((p) => p.closedAt === null);
    const prices = Object.fromEntries(
      open.flatMap((p) => {
        const bar = bars.get(p.ticker.toUpperCase());
        const close = bar ? Number(bar.close) : Number(p.avgCost);
        return Number.isFinite(close) && close > 0 ? [[p.ticker.toUpperCase(), close]] : [];
      }),
    );
    const audit = auditPortfolio({ positions: open, prices, usdCadRate });
    rows.push({
      id: a.id,
      name: a.name,
      type: a.type as string,
      currency: a.currency === 'USD' ? 'USD' : 'CAD',
      positionCount: open.length,
      totalCad: Math.round(audit.totalValueCad * 100) / 100,
    });
  }

  const parts: string[] = ['# Account breakdown', ''];
  for (const r of rows) {
    parts.push(
      `- **${r.name}** (${r.type}, ${r.currency} account) - C$${r.totalCad.toFixed(2)} across ${r.positionCount} position${r.positionCount === 1 ? '' : 's'}`,
    );
  }
  parts.push('');
  return parts.join('\n');
}

/**
 * One-line placement annotation for a rotation candidate. Returns an empty
 * string when neither side has guidance — caller drops the line.
 *
 * The 📍 prefix matches the catalyst Telegram footer style.
 */
export function renderRotationPlacement(c: RotationCandidate): string {
  const bits: string[] = [];
  if (c.buyPlacement && c.buyPlacement.bestAccountId !== null) {
    const acctType = c.buyPlacement.rankedAccountTypes[0] ?? 'preferred account';
    bits.push(`Buy ${c.buyTicker} in your ${acctType} — ${c.buyPlacement.rationale}`);
  } else if (c.buyPlacement) {
    bits.push(`Buy ${c.buyTicker}: ${c.buyPlacement.rationale}`);
  }
  if (c.trimAccount) {
    bits.push(`Trim ${c.trimTicker} from your ${c.trimAccount.name} (${c.trimAccount.type})`);
  }
  if (bits.length === 0) return '';
  return `   📍 ${bits.join(' · ')}`;
}
