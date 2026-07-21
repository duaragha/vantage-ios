/**
 * /positions/[ticker] — per-position thesis detail view.
 */

import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  findArticlesByTicker,
  findPositionsByTicker,
  findThesisByPositionId,
  listEvaluationsForThesis,
  prisma,
  type Article,
  type FundamentalsSnapshot,
  type Thesis,
  type ThesisEvaluation,
  type TickerMetrics,
} from '@vantage/db';
import { FrostedPanel } from '@/components/FrostedPanel';
import { ThesisLabel, type ThesisHealth } from '@/components/ThesisGlow';
import { AccountBadge } from '@/components/AccountBadge';
import { listAccounts } from '@/app/(dashboard)/accounts/data';
import {
  fmtCalendarDate,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtMoneySigned,
  fmtPct,
  fmtTimeAgo,
  pnlTone,
} from '@/lib/format';
import { fetchLivePrice } from '@/lib/prices';
import { cn } from '@/lib/utils';
import { PositionActions } from './PositionActions';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ ticker: string }>;
  searchParams: Promise<{ positionId?: string | string[] }>;
}

interface PillarView {
  statement: string;
  status: string;
  lastEvaluatedAt: string | null;
  evidence: Array<{ articleId?: number | null; quote?: string }>;
}

interface RiskView {
  statement: string;
  triggered: boolean;
  evidence: Array<{ articleId?: number | null; quote?: string }>;
}

async function loadPositionResearch(positionId: number, ticker: string) {
  const thesis = await findThesisByPositionId(positionId);
  const [evaluations, articles, price, accounts, fundamentals, metrics] = await Promise.all([
    thesis ? listEvaluationsForThesis(thesis.id, 10) : Promise.resolve([]),
    findArticlesByTicker({
      ticker,
      since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      limit: 10,
    }),
    fetchLivePrice(ticker),
    listAccounts({ includeArchived: true }),
    prisma.fundamentalsSnapshot.findMany({
      where: { ticker },
      orderBy: { periodEnd: 'desc' },
      take: 4,
    }),
    prisma.tickerMetrics.findUnique({ where: { ticker } }),
  ]);
  return { thesis, evaluations, articles, price, accounts, fundamentals, metrics };
}

function PositionLoadFailure({ ticker, message }: { ticker: string; message: string }) {
  return (
    <div className="cc-page">
      <Link href="/portfolio" className="mb-5 inline-flex text-xs text-muted-foreground">
        Back to portfolio
      </Link>
      <h1 className="cc-page-title mb-4">{ticker || 'Position'} unavailable</h1>
      <DbErrorBanner message={message} />
    </div>
  );
}

function parsePillars(thesis: Thesis | null): PillarView[] {
  if (!thesis) return [];
  const raw = thesis.pillars as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      statement: typeof p['statement'] === 'string' ? (p['statement'] as string) : '',
      status: typeof p['status'] === 'string' ? (p['status'] as string) : 'Intact',
      lastEvaluatedAt:
        typeof p['lastEvaluatedAt'] === 'string' ? (p['lastEvaluatedAt'] as string) : null,
      evidence: Array.isArray(p['evidence'])
        ? (p['evidence'] as Array<Record<string, unknown>>).map((e) => ({
            articleId: typeof e['articleId'] === 'number' ? (e['articleId'] as number) : null,
            quote: typeof e['quote'] === 'string' ? (e['quote'] as string) : '',
          }))
        : [],
    }));
}

function parseRisks(thesis: Thesis | null): RiskView[] {
  if (!thesis) return [];
  const raw = thesis.riskFactors as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      statement: typeof r['statement'] === 'string' ? (r['statement'] as string) : '',
      triggered: Boolean(r['triggered']),
      evidence: Array.isArray(r['evidence'])
        ? (r['evidence'] as Array<Record<string, unknown>>).map((e) => ({
            articleId: typeof e['articleId'] === 'number' ? (e['articleId'] as number) : null,
            quote: typeof e['quote'] === 'string' ? (e['quote'] as string) : '',
          }))
        : [],
    }));
}

export default async function PositionDetailPage({
  params,
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const { ticker: raw } = await params;
  const query = await searchParams;
  const ticker = raw.toUpperCase();
  const rawPositionId = Array.isArray(query.positionId) ? query.positionId[0] : query.positionId;
  const requestedPositionId = rawPositionId ? Number(rawPositionId) : null;
  if (
    requestedPositionId !== null &&
    (!Number.isInteger(requestedPositionId) || requestedPositionId <= 0)
  ) {
    notFound();
  }
  let positions: Awaited<ReturnType<typeof findPositionsByTicker>>;
  try {
    positions = await findPositionsByTicker(ticker);
  } catch (err) {
    return (
      <PositionLoadFailure
        ticker={ticker}
        message={err instanceof Error ? err.message : 'database unreachable'}
      />
    );
  }
  const position =
    requestedPositionId !== null
      ? positions.find((candidate) => candidate.id === requestedPositionId)
      : (positions.find((candidate) => candidate.closedAt === null) ?? positions[0]);
  if (!position) notFound();

  let research: Awaited<ReturnType<typeof loadPositionResearch>>;
  try {
    research = await loadPositionResearch(position.id, ticker);
  } catch (err) {
    return (
      <PositionLoadFailure
        ticker={ticker}
        message={err instanceof Error ? err.message : 'database unreachable'}
      />
    );
  }
  const { thesis, evaluations, articles, price, fundamentals, metrics } = research;
  const accountMatch = research.accounts.find((account) => account.id === position.accountId);
  const positionAccount = accountMatch
    ? { id: accountMatch.id, name: accountMatch.name, type: accountMatch.type as string }
    : null;

  const shares = Number(position.shares);
  const avgCost = Number(position.avgCost);
  const currency = position.currency === 'CAD' ? 'CAD' : 'USD';
  const currentPrice = price?.price ?? avgCost;
  const pnlNative = (currentPrice - avgCost) * shares;
  const pnlPct = avgCost > 0 ? ((currentPrice - avgCost) / avgCost) * 100 : 0;

  const health: ThesisHealth = thesis
    ? (() => {
        const days = (Date.now() - thesis.lastValidatedAt.getTime()) / 86_400_000;
        return days > 30 ? 'Stale' : (thesis.status as ThesisHealth);
      })()
    : 'None';

  const pillars = parsePillars(thesis);
  const risks = parseRisks(thesis);

  return (
    <div className="cc-page">
      <nav className="mb-4 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        <Link href="/portfolio" className="transition hover:text-foreground">
          Portfolio
        </Link>
        <span className="mx-2">/</span>
        <span>{ticker}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-3xl font-semibold tracking-tight sm:text-4xl">
              {ticker}
            </h1>
            <ThesisLabel status={health} />
            {positionAccount && (
              <AccountBadge name={positionAccount.name} type={positionAccount.type} showType />
            )}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {position.sector ?? 'Sector unclassified'} · {position.category}
            {thesis && ` · last evaluated ${fmtTimeAgo(thesis.lastValidatedAt)}`}
          </p>
        </div>
        <PositionActions positionId={position.id} ticker={ticker} />
      </header>

      <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <Mini label="Shares" value={shares.toLocaleString('en-US')} />
        <Mini label="Avg cost" value={fmtMoney(avgCost, currency)} />
        <Mini label="Current" value={price ? fmtMoney(price.price, currency) : '—'} />
        <Mini
          label="P&L"
          value={fmtMoneySigned(pnlNative, currency)}
          className={pnlTone(pnlNative)}
        />
        <Mini label="P&L %" value={fmtPct(pnlPct)} className={pnlTone(pnlNative)} />
        <Mini
          label="Stop loss"
          value={position.stopLoss === null ? '-' : fmtMoney(Number(position.stopLoss), currency)}
          className={
            position.stopLoss !== null && currentPrice <= Number(position.stopLoss)
              ? 'text-rose-300'
              : undefined
          }
        />
        <Mini
          label="Price target"
          value={
            position.priceTarget === null ? '-' : fmtMoney(Number(position.priceTarget), currency)
          }
          className={
            position.priceTarget !== null && currentPrice >= Number(position.priceTarget)
              ? 'text-emerald-300'
              : undefined
          }
        />
      </section>

      <FundamentalsSection snapshots={fundamentals} metrics={metrics} />

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <FrostedPanel padding="lg">
          <SectionTitle>Thesis</SectionTitle>
          {thesis ? (
            <>
              <p className="mt-1 text-sm text-foreground/85">{thesis.summary}</p>
              <div className="mt-5 flex flex-col gap-3">
                {pillars.length === 0 && (
                  <div className="font-mono text-xs text-muted-foreground">No pillars.</div>
                )}
                {pillars.map((p, i) => (
                  <div
                    key={i}
                    className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <ThesisLabel status={p.status as ThesisHealth} />
                      {p.lastEvaluatedAt && (
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {fmtTimeAgo(p.lastEvaluatedAt)}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-foreground/90">{p.statement}</p>
                    {p.evidence.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {p.evidence.map((e, j) => (
                          <details
                            key={j}
                            className="group max-w-full rounded-md border border-white/[0.08] bg-black/30 text-muted-foreground"
                          >
                            <summary className="max-w-[32ch] cursor-pointer list-none truncate px-2 py-1 font-mono text-[10px] marker:hidden">
                              src {e.articleId ?? '?'} · {(e.quote ?? '').slice(0, 48)}
                              {(e.quote?.length ?? 0) > 48 ? '…' : ''}
                            </summary>
                            <p className="max-w-sm border-t border-white/[0.06] px-2 py-2 text-xs leading-relaxed text-foreground/75">
                              {e.quote}
                            </p>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {risks.length > 0 && (
                <>
                  <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Risk factors
                  </div>
                  <ul className="mt-2 flex flex-col gap-2">
                    {risks.map((r, i) => (
                      <li
                        key={i}
                        className={cn(
                          'rounded-md border px-3 py-2 text-sm',
                          r.triggered
                            ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                            : 'border-white/[0.06] bg-white/[0.02] text-foreground/80',
                        )}
                      >
                        <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.2em]">
                          {r.triggered ? 'triggered' : 'quiet'}
                        </span>
                        {r.statement}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <div className="mt-2 flex flex-col gap-2 text-sm text-muted-foreground">
              <p>No thesis yet.</p>
              <p className="text-xs">
                Edit the position to add a summary, pillars, and risk factors — the thesis engine
                runs against this structure.
              </p>
            </div>
          )}
        </FrostedPanel>

        <div className="flex flex-col gap-6">
          <FrostedPanel padding="lg">
            <SectionTitle>Evaluation history</SectionTitle>
            {evaluations.length === 0 ? (
              <div className="mt-2 text-sm text-muted-foreground">
                No evaluations yet. Hit “Re-evaluate now” to trigger one.
              </div>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {evaluations.map((e) => (
                  <EvaluationRow key={e.id} evaluation={e} />
                ))}
              </ul>
            )}
          </FrostedPanel>

          <FrostedPanel padding="lg">
            <SectionTitle>Recent coverage (30d)</SectionTitle>
            {articles.length === 0 ? (
              <div className="mt-2 text-sm text-muted-foreground">
                No articles indexed for {ticker} yet.
              </div>
            ) : (
              <ul className="mt-3 flex flex-col divide-y divide-white/[0.04]">
                {articles.map((a) => (
                  <ArticleRow key={a.id} article={a} />
                ))}
              </ul>
            )}
          </FrostedPanel>
        </div>
      </section>
    </div>
  );
}

function Mini({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}): React.ReactElement {
  return (
    <FrostedPanel className="flex flex-col gap-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div className={cn('font-mono text-lg font-medium tabular-nums text-foreground', className)}>
        {value}
      </div>
    </FrostedPanel>
  );
}

function compactStatementValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return new Intl.NumberFormat('en-CA', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(number);
}

function plainNumber(value: number | null, suffix = 'x'): string {
  return value === null || !Number.isFinite(value) ? '-' : `${value.toFixed(2)}${suffix}`;
}

function percentNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : `${value.toFixed(1)}%`;
}

function StatementTable({
  title,
  rows,
  latestLabel,
  previousLabel,
}: {
  title: string;
  rows: Array<{ label: string; latest: unknown; previous: unknown }>;
  latestLabel: string;
  previousLabel: string;
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-xs font-semibold text-foreground/85">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/[0.07] font-mono text-[9px] uppercase text-muted-foreground">
              <th className="py-2 text-left font-normal">Metric</th>
              <th className="px-2 py-2 text-right font-normal">{latestLabel}</th>
              <th className="py-2 text-right font-normal">{previousLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-white/[0.045] last:border-b-0">
                <td className="py-2 text-muted-foreground">{row.label}</td>
                <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground/90">
                  {compactStatementValue(row.latest)}
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-foreground/60">
                  {compactStatementValue(row.previous)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FundamentalsSection({
  snapshots,
  metrics,
}: {
  snapshots: FundamentalsSnapshot[];
  metrics: TickerMetrics | null;
}): React.ReactElement {
  const latest = snapshots[0] ?? null;
  const previous = latest
    ? (snapshots.find(
        (snapshot) => snapshot.id !== latest.id && snapshot.periodType === latest.periodType,
      ) ?? null)
    : null;
  if (!latest && !metrics) {
    return (
      <section className="mb-6 border-y border-white/[0.06] py-4 text-sm text-muted-foreground">
        No fundamentals snapshot is available yet.
      </section>
    );
  }

  const latestLabel = latest ? fmtCalendarDate(latest.periodEnd) : '-';
  const previousLabel = previous ? fmtCalendarDate(previous.periodEnd) : '-';
  const ratioRows = metrics
    ? [
        ['P/E', plainNumber(metrics.peTtm)],
        ['P/S', plainNumber(metrics.psTtm)],
        ['EV / EBITDA', plainNumber(metrics.evToEbitda)],
        ['ROE', percentNumber(metrics.roeTtm)],
        ['ROIC', percentNumber(metrics.roicTtm)],
        ['Gross margin', percentNumber(metrics.grossMarginTtm)],
        ['Operating margin', percentNumber(metrics.operatingMarginTtm)],
        ['Net margin', percentNumber(metrics.netMarginTtm)],
        ['Debt / equity', plainNumber(metrics.debtToEquity)],
        ['Current ratio', plainNumber(metrics.currentRatio)],
        ['Revenue growth', percentNumber(metrics.revenueGrowthYoy)],
        ['EPS growth', percentNumber(metrics.epsGrowthYoy)],
        ['Dividend yield', percentNumber(metrics.dividendYieldTtm)],
        ['Beta', plainNumber(metrics.beta, '')],
      ]
    : [];

  return (
    <section className="mb-6 border-y border-white/[0.07] py-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Fundamentals</SectionTitle>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {latest ? `${latest.periodType} statements · ${latest.source}` : 'ratios only'}
        </span>
      </div>
      {latest && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <StatementTable
            title="Income"
            latestLabel={latestLabel}
            previousLabel={previousLabel}
            rows={[
              { label: 'Revenue', latest: latest.revenue, previous: previous?.revenue },
              {
                label: 'Gross profit',
                latest: latest.grossProfit,
                previous: previous?.grossProfit,
              },
              {
                label: 'Operating income',
                latest: latest.operatingIncome,
                previous: previous?.operatingIncome,
              },
              { label: 'Net income', latest: latest.netIncome, previous: previous?.netIncome },
              { label: 'Diluted EPS', latest: latest.epsDiluted, previous: previous?.epsDiluted },
            ]}
          />
          <StatementTable
            title="Balance sheet"
            latestLabel={latestLabel}
            previousLabel={previousLabel}
            rows={[
              { label: 'Cash', latest: latest.cash, previous: previous?.cash },
              {
                label: 'Total assets',
                latest: latest.totalAssets,
                previous: previous?.totalAssets,
              },
              {
                label: 'Total liabilities',
                latest: latest.totalLiabilities,
                previous: previous?.totalLiabilities,
              },
              { label: 'Equity', latest: latest.totalEquity, previous: previous?.totalEquity },
              {
                label: 'Long-term debt',
                latest: latest.longTermDebt,
                previous: previous?.longTermDebt,
              },
            ]}
          />
          <StatementTable
            title="Cash flow"
            latestLabel={latestLabel}
            previousLabel={previousLabel}
            rows={[
              {
                label: 'Operating cash flow',
                latest: latest.operatingCashFlow,
                previous: previous?.operatingCashFlow,
              },
              {
                label: 'Free cash flow',
                latest: latest.freeCashFlow,
                previous: previous?.freeCashFlow,
              },
              { label: 'Capex', latest: latest.capex, previous: previous?.capex },
            ]}
          />
        </div>
      )}
      {ratioRows.length > 0 && (
        <div className="mt-5 grid grid-cols-2 border-t border-white/[0.06] pt-4 sm:grid-cols-4 lg:grid-cols-7">
          {ratioRows.map(([label, value]) => (
            <div key={label} className="border-b border-white/[0.045] px-2 py-2 lg:border-b-0">
              <div className="text-[10px] text-muted-foreground">{label}</div>
              <div className="mt-0.5 font-mono text-xs tabular-nums text-foreground/85">
                {value}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
      {children}
    </div>
  );
}

function EvaluationRow({ evaluation }: { evaluation: ThesisEvaluation }): React.ReactElement {
  return (
    <li className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="mb-1 flex items-center gap-2">
        <ThesisLabel status={evaluation.newStatus as ThesisHealth} />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          was {evaluation.prevStatus}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
          {fmtDateTime(evaluation.createdAt)}
        </span>
      </div>
      <p className="text-sm text-foreground/80">{evaluation.rationale}</p>
    </li>
  );
}

function ArticleRow({ article }: { article: Article }): React.ReactElement {
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em]',
            article.sourceTier === 1
              ? 'border-emerald-500/40 text-emerald-300'
              : article.sourceTier === 2
                ? 'border-amber-500/40 text-amber-300'
                : 'border-zinc-500/40 text-zinc-300',
          )}
        >
          T{article.sourceTier}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {article.source} · {fmtDate(article.publishedAt)}
        </span>
      </div>
      <a
        href={article.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1 block text-sm text-foreground/85 transition hover:text-[var(--cc-accent)]"
      >
        {article.headline}
      </a>
    </li>
  );
}
