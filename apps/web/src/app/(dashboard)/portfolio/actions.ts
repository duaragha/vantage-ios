/**
 * Server actions for Position CRUD + Thesis upsert — invoked from the
 * dashboard position form. Multi-account aware: every Position now lives
 * inside an Account, so create/edit/close all key off the new
 * (accountId, ticker) compound unique.
 */

'use server';

import { revalidatePath } from 'next/cache';
import {
  Prisma,
  PositionLotSource,
  closePosition,
  prisma,
  recomputePositionFromLots,
  shouldRefreshUniverseRow,
  upsertFromFinnhubProfile,
  upsertThesis,
  type UpsertThesisInput,
} from '@vantage/db';
import {
  FinnhubAdapter,
  deriveCurrency,
  exchangeFromSymbol,
  type FinnhubProfile,
} from '@vantage/sources';
import { componentLogger } from '@vantage/notify';
import { parsePositionLotInput } from '@/lib/positionLotInput';

const log = componentLogger('web/actions/portfolio');

const DEFAULT_ACCOUNT_ID = 1;

/**
 * Lazily construct a Finnhub adapter so missing env vars don't break the
 * action when the user isn't actually adding a position. The adapter keeps
 * its own rate limiter; sharing an instance across invocations keeps the
 * bucket honest across hot reloads.
 */
let _finnhub: FinnhubAdapter | null = null;
function getFinnhubOrNull(): FinnhubAdapter | null {
  if (_finnhub) return _finnhub;
  if (!process.env['FINNHUB_API_KEY']) return null;
  try {
    _finnhub = new FinnhubAdapter();
    return _finnhub;
  } catch {
    return null;
  }
}

/**
 * Best-effort Finnhub profile fetch. Never throws: 429s, auth errors, network
 * blips all degrade to `null` so the position write path keeps going.
 */
async function fetchProfileSafe(ticker: string): Promise<FinnhubProfile | null> {
  const fn = getFinnhubOrNull();
  if (!fn) return null;
  try {
    return await fn.getCompanyProfile(ticker);
  } catch (err) {
    log.warn(
      { ticker, err: err instanceof Error ? err.message : err },
      'finnhub profile lookup failed — continuing without',
    );
    return null;
  }
}

export interface PositionFormPayload {
  ticker: string;
  name?: string | null;
  shares: number;
  avgCost: number;
  category: string;
  sector?: string | null;
  notes?: string | null;
  stopLoss?: number | null;
  priceTarget?: number | null;
  thesisSummary?: string;
  thesisPillars?: string[];
  thesisRiskFactors?: string[];
  /**
   * Account this lot lives in. Optional for backward compatibility with the
   * pre-multi-account form; missing values fall back to the seed default
   * account (id=1, name="Personal (default)"). The form should always send
   * this once Agent D's account picker ships.
   */
  accountId?: number;
  /**
   * Currency avgCost is denominated in. Optional — when omitted the action
   * infers it: resolved ticker listing currency → account currency → 'USD'.
   * The form sends the detected/overridden currency explicitly.
   */
  currency?: string | null;
  /** Create adds a dated purchase lot; edit changes metadata only. */
  intent?: 'create' | 'edit';
  /** YYYY-MM-DD purchase date. Null is reserved for honest legacy/import gaps. */
  purchaseDate?: string | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  positionId?: number;
  ticker?: string;
}

interface SanitizedPayload {
  ticker: string;
  name: string | null;
  shares: number;
  avgCost: number;
  category: string;
  sector: string | null;
  notes: string | null;
  stopLoss: number | null;
  priceTarget: number | null;
  thesisSummary: string;
  thesisPillars: string[];
  thesisRiskFactors: string[];
  accountId: number;
  /** Null when the form didn't send one — resolved later from ticker/account. */
  currency: 'CAD' | 'USD' | null;
  intent: 'create' | 'edit';
  purchaseDate: Date | null;
}

function normalizeCurrency(raw: string | null | undefined): 'CAD' | 'USD' | null {
  if (!raw) return null;
  const c = raw.trim().toUpperCase();
  if (c === 'CAD') return 'CAD';
  if (c === 'USD') return 'USD';
  return null;
}

function sanitize(payload: PositionFormPayload): SanitizedPayload | string {
  const intent = payload.intent === 'create' ? 'create' : 'edit';
  const ticker = payload.ticker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(ticker)) {
    return 'ticker must be 1-8 chars, A-Z/./- only';
  }
  const shares = Number(payload.shares);
  if (!Number.isFinite(shares) || shares <= 0) {
    return 'shares must be a positive number';
  }
  const avgCost = Number(payload.avgCost);
  if (!Number.isFinite(avgCost) || avgCost < 0) {
    return 'avg cost must be zero or positive';
  }
  const allowedCategory = ['Conviction', 'Speculative', 'Meme', 'Income', 'Other'];
  if (!allowedCategory.includes(payload.category)) {
    return `category must be one of ${allowedCategory.join(', ')}`;
  }
  const accountId =
    typeof payload.accountId === 'number' && Number.isInteger(payload.accountId)
      ? payload.accountId
      : DEFAULT_ACCOUNT_ID;
  if (accountId <= 0) {
    return 'accountId must be a positive integer';
  }
  const stopLoss = payload.stopLoss == null ? null : Number(payload.stopLoss);
  if (stopLoss !== null && (!Number.isFinite(stopLoss) || stopLoss <= 0)) {
    return 'stop loss must be a positive price';
  }
  const priceTarget = payload.priceTarget == null ? null : Number(payload.priceTarget);
  if (priceTarget !== null && (!Number.isFinite(priceTarget) || priceTarget <= 0)) {
    return 'price target must be a positive price';
  }
  if (stopLoss !== null && priceTarget !== null && stopLoss >= priceTarget) {
    return 'stop loss must be below the price target';
  }
  const lotInput = parsePositionLotInput({
    shares,
    costPerShare: avgCost,
    acquiredAt: payload.purchaseDate ?? null,
    note: null,
  });
  if (!lotInput.ok) return lotInput.error;
  if (intent === 'create' && lotInput.value.acquiredAtDate === null) {
    return 'purchase date is required';
  }
  return {
    ticker,
    name: payload.name?.trim() ?? null,
    shares,
    avgCost,
    category: payload.category,
    sector: payload.sector ?? null,
    notes: payload.notes ?? null,
    stopLoss,
    priceTarget,
    thesisSummary: payload.thesisSummary?.trim() ?? '',
    thesisPillars: (payload.thesisPillars ?? []).map((s) => s.trim()).filter(Boolean),
    thesisRiskFactors: (payload.thesisRiskFactors ?? []).map((s) => s.trim()).filter(Boolean),
    accountId,
    currency: normalizeCurrency(payload.currency),
    intent,
    purchaseDate: lotInput.value.acquiredAtDate,
  };
}

/**
 * Upsert a Position scoped to (accountId, ticker) (+ optional Thesis on the
 * same transaction). Rejects when the chosen account is archived or missing.
 * Creating an already-held ticker adds a purchase lot without replacing the
 * holding metadata. Editing changes metadata and leaves the lot ledger alone.
 */
export async function upsertPosition(payload: PositionFormPayload): Promise<ActionResult> {
  const sanitized = sanitize(payload);
  if (typeof sanitized === 'string') {
    return { ok: false, error: sanitized };
  }

  try {
    // Validate the target account.
    const account = await prisma.account.findUnique({
      where: { id: sanitized.accountId },
      select: { id: true, archivedAt: true, currency: true },
    });
    if (!account) {
      return { ok: false, error: 'Account not found.' };
    }
    if (account.archivedAt) {
      return {
        ok: false,
        error: 'Account is archived — unarchive it before adding positions.',
      };
    }

    // Schema enforces one row per (accountId, ticker). When a closed lot
    // exists we re-open it via update below rather than insert a duplicate.
    const existing = await prisma.position.findUnique({
      where: {
        accountId_ticker: {
          accountId: sanitized.accountId,
          ticker: sanitized.ticker,
        },
      },
    });

    // Auto-populate profile from Finnhub:
    //   - On create: always attempt (cheap signal).
    //   - On edit: only if the TickerUniverse row is missing or stale >7d.
    // User-entered sector always wins over Finnhub's industry — only fill when
    // the form left it blank.
    const needsUniverseRefresh = !existing || (await shouldRefreshUniverseRow(sanitized.ticker));
    const profile = needsUniverseRefresh ? await fetchProfileSafe(sanitized.ticker) : null;
    const resolvedSector =
      sanitized.sector && sanitized.sector.length > 0
        ? sanitized.sector
        : (profile?.finnhubIndustry ?? null);

    // Resolve the currency avgCost is denominated in. Priority:
    //   1. Explicit form value (user-detected/overridden).
    //   2. Profile currency from Finnhub (only CAD/USD trusted).
    //   3. Ticker suffix (.TO/.NE/.V → CAD, else USD) — reliable for CA listings.
    //   4. Account currency.
    //   5. 'USD'.
    const profileCurrency = normalizeCurrency(profile?.currency ?? null);
    const suffixCurrency = deriveCurrency(exchangeFromSymbol(sanitized.ticker));
    const accountCurrency = normalizeCurrency(account.currency);
    const resolvedCurrency: 'CAD' | 'USD' =
      sanitized.currency ?? profileCurrency ?? suffixCurrency ?? accountCurrency ?? 'USD';

    const position = await prisma.$transaction(async (tx) => {
      if (!existing) {
        const created = await tx.position.create({
          data: {
            ticker: sanitized.ticker,
            shares: new Prisma.Decimal(sanitized.shares),
            avgCost: new Prisma.Decimal(sanitized.avgCost),
            currency: resolvedCurrency,
            category: sanitized.category,
            sector: resolvedSector,
            notes: sanitized.notes,
            stopLoss: sanitized.stopLoss === null ? null : new Prisma.Decimal(sanitized.stopLoss),
            priceTarget:
              sanitized.priceTarget === null ? null : new Prisma.Decimal(sanitized.priceTarget),
            accountId: sanitized.accountId,
          },
        });
        await tx.positionLot.create({
          data: {
            positionId: created.id,
            acquiredAt: sanitized.purchaseDate,
            shares: new Prisma.Decimal(sanitized.shares),
            costPerShare: new Prisma.Decimal(sanitized.avgCost),
            source: PositionLotSource.Manual,
          },
        });
        return created;
      }

      if (sanitized.intent === 'create') {
        if (existing.closedAt !== null) {
          await tx.position.update({
            where: { id: existing.id },
            data: {
              closedAt: null,
              stopLossAlertedAt: null,
              priceTargetAlertedAt: null,
            },
          });
        }
        await tx.positionLot.create({
          data: {
            positionId: existing.id,
            acquiredAt: sanitized.purchaseDate,
            shares: new Prisma.Decimal(sanitized.shares),
            costPerShare: new Prisma.Decimal(sanitized.avgCost),
            source: PositionLotSource.Manual,
          },
        });
        return recomputePositionFromLots(existing.id, tx);
      }

      const thresholdData = {
        ...(existing.closedAt !== null ||
        (existing.stopLoss === null ? null : Number(existing.stopLoss)) !== sanitized.stopLoss
          ? { stopLossAlertedAt: null }
          : {}),
        ...(existing.closedAt !== null ||
        (existing.priceTarget === null ? null : Number(existing.priceTarget)) !==
          sanitized.priceTarget
          ? { priceTargetAlertedAt: null }
          : {}),
      };
      const updated = await tx.position.update({
        where: { id: existing.id },
        data: {
          currency: resolvedCurrency,
          category: sanitized.category,
          sector: resolvedSector,
          notes: sanitized.notes,
          stopLoss: sanitized.stopLoss === null ? null : new Prisma.Decimal(sanitized.stopLoss),
          priceTarget:
            sanitized.priceTarget === null ? null : new Prisma.Decimal(sanitized.priceTarget),
          ...thresholdData,
        },
      });

      // Migration normally guarantees this row. Keep a defensive opening lot
      // for databases that were created between code and migration deploys.
      const activeLots = await tx.positionLot.count({
        where: { positionId: existing.id, disposedAt: null },
      });
      if (activeLots === 0 && existing.closedAt === null) {
        await tx.positionLot.create({
          data: {
            positionId: existing.id,
            acquiredAt: sanitized.purchaseDate,
            shares: new Prisma.Decimal(sanitized.shares),
            costPerShare: new Prisma.Decimal(sanitized.avgCost),
            source: PositionLotSource.Legacy,
          },
        });
        return recomputePositionFromLots(existing.id, tx);
      }
      return updated;
    });

    // Upsert TickerUniverse from the same profile response if we fetched one.
    // User-typed name (if provided) beats Finnhub's name — lets the user
    // correct obvious misses (e.g. ADRs, ETFs with odd Finnhub labels).
    if (profile) {
      try {
        await upsertFromFinnhubProfile({
          symbol: sanitized.ticker,
          profile,
          fallbackName:
            sanitized.name && sanitized.name.length > 0 ? sanitized.name : sanitized.ticker,
        });
      } catch (err) {
        log.warn(
          {
            ticker: sanitized.ticker,
            err: err instanceof Error ? err.message : err,
          },
          'tickerUniverse upsert failed — position saved anyway',
        );
      }
    } else if (sanitized.name && sanitized.name.length > 0) {
      // No profile but the user typed a name — still record it on TickerUniverse
      // so /compare etc can show something meaningful.
      try {
        const { upsertBulk } = await import('@vantage/db');
        await upsertBulk([
          {
            symbol: sanitized.ticker,
            name: sanitized.name,
            exchange: 'US',
            sector: resolvedSector,
            aliases: [],
          },
        ]);
      } catch (err) {
        log.warn(
          {
            ticker: sanitized.ticker,
            err: err instanceof Error ? err.message : err,
          },
          'tickerUniverse upsertBulk failed — position saved anyway',
        );
      }
    }

    if (sanitized.thesisSummary && sanitized.thesisPillars && sanitized.thesisPillars.length > 0) {
      const pillars = sanitized.thesisPillars.map((statement) => ({
        statement,
        status: 'Intact' as const,
        lastEvaluatedAt: null,
        evidence: [],
      }));
      const riskFactors = (sanitized.thesisRiskFactors ?? []).map((statement) => ({
        statement,
        triggered: false,
        evidence: [],
      }));
      const thesisInput: UpsertThesisInput = {
        positionId: position.id,
        summary: sanitized.thesisSummary,
        pillars,
        riskFactors,
      };
      await upsertThesis(thesisInput);
    }

    revalidatePath('/portfolio');
    revalidatePath('/accounts');
    revalidatePath(`/positions/${position.ticker}`);

    return { ok: true, positionId: position.id, ticker: position.ticker };
  } catch (err) {
    log.error({ err, ticker: sanitized.ticker }, 'upsertPosition failed');
    return { ok: false, error: 'position could not be saved' };
  }
}

/**
 * Close a Position by id. Matches by primary key — callers that previously
 * passed `ticker` should look up the row id first (the `(accountId, ticker)`
 * compound unique is the cleanest path) since the same ticker can now appear
 * across multiple accounts.
 */
export async function closePositionAction(id: number): Promise<ActionResult> {
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'invalid position id' };
  }
  try {
    const row = await closePosition(id);
    revalidatePath('/portfolio');
    revalidatePath('/accounts');
    return { ok: true, positionId: row.id, ticker: row.ticker };
  } catch (err) {
    log.error({ err, positionId: id }, 'closePosition failed');
    return { ok: false, error: 'position could not be closed' };
  }
}
