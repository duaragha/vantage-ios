/**
 * /backtest — minimal Phase 11 UI for the deterministic backtest harness.
 *
 * Form → POST /api/backtest → render summary cards + equity curve + trades
 * table. Styled as a frosted-glass command-center panel on a dark base with
 * Geist Mono numbers. Phase 12 will wrap this in the global sidebar/nav.
 */

'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { StatusDot } from '@/components/StatusDot';

// ---------------------------------------------------------------------------
// Types (mirror the engine's BacktestResult shape; duplicated here to avoid
// a client-side import of @vantage/core)
// ---------------------------------------------------------------------------

type Strategy = 'monthly-allocation' | 'rebalance-only' | 'catalyst-driven';

interface BacktestTrade {
  date: string;
  ticker: string;
  kind: 'buy' | 'trim' | 'exit';
  shares: number;
  price: number;
  dollars: number;
  rationale: string;
}

interface EquityPoint {
  date: string;
  valueUsd: number;
  spyValueUsd: number;
}

interface BacktestResultPayload {
  backtestRunId: number | null;
  entries: BacktestTrade[];
  exits: BacktestTrade[];
  monthlySnapshots: Array<{
    date: string;
    cashUsd: number;
    totalValueUsd: number;
    positions: Array<{ ticker: string; shares: number; valueUsd: number }>;
  }>;
  finalValueUsd: number;
  totalReturnPct: number;
  spyReturnPct: number;
  maxDrawdownPct: number;
  cagr: number;
  sharpeApprox?: number;
  equityCurve: EquityPoint[];
}

// Shape returned by worker's runJob wrapper.
interface RunOutcome {
  ran: boolean;
  jobRunId: number | null;
  result: {
    backtestRunId: number | null;
    finalValueUsd: number;
    totalReturnPct: number;
    spyReturnPct: number;
    cagr: number;
    maxDrawdownPct: number;
    sharpeApprox: number;
    entriesCount: number;
    exitsCount: number;
    snapshotsCount: number;
    equityCurveCount: number;
    result: BacktestResultPayload;
  } | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BacktestPage(): React.ReactElement {
  const [startDate, setStartDate] = React.useState('2025-01-01');
  const [endDate, setEndDate] = React.useState('2025-12-31');
  const [strategy, setStrategy] = React.useState<Strategy>('monthly-allocation');
  const [initialCash, setInitialCash] = React.useState('10000');
  const [monthlyBudget, setMonthlyBudget] = React.useState('500');
  const [singleCap, setSingleCap] = React.useState('25');
  const [sectorCap, setSectorCap] = React.useState('60');
  const [candidates, setCandidates] = React.useState('AAPL, MSFT, GOOGL, NVDA');

  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<BacktestResultPayload | null>(null);
  const [holdingDays, setHoldingDays] = React.useState<string>('30');
  const [catalystMaxPerDay, setCatalystMaxPerDay] = React.useState<string>('2');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setError(null);

    const candidateUniverse = candidates
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    try {
      const requestBody: Record<string, unknown> = {
        startDate,
        endDate,
        strategy,
        initialCashUsd: Number(initialCash),
        monthlyBudgetUsd: Number(monthlyBudget),
        caps: {
          singlePositionCapPct: Number(singleCap),
          sectorCapPct: Number(sectorCap),
        },
        candidateUniverse,
      };
      if (strategy === 'catalyst-driven') {
        requestBody['holdingDays'] = Number(holdingDays);
        requestBody['catalystMaxPerDay'] = Number(catalystMaxPerDay);
      }
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const body = (await res.json()) as RunOutcome | { error?: string };
      if (!res.ok) {
        setError((body as { error?: string }).error ?? `request failed with status ${res.status}`);
        return;
      }
      const outcome = body as RunOutcome;
      if (outcome.error) {
        setError(outcome.error);
        return;
      }
      if (!outcome.result?.result) {
        setError('worker returned no result payload');
        return;
      }
      setData(outcome.result.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="cc-page">
      <div className="mx-auto max-w-6xl">
        <header className="cc-page-header">
          <div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              <StatusDot status="fresh" />
              backtest harness
            </div>
            <h1 className="cc-page-title">Backtest</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Deterministic equal-weight replay over Tiingo EOD prices. No LLM in the loop —
              re-running with the same config returns the same trades.
            </p>
          </div>
        </header>

        <section className="mb-8">
          <FrostedPanel>
            <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field label="Start date">
                <Input
                  type="date"
                  className="min-h-11 text-base sm:text-sm"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  required
                />
              </Field>
              <Field label="End date">
                <Input
                  type="date"
                  className="min-h-11 text-base sm:text-sm"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                />
              </Field>
              <Field label="Strategy">
                <Select value={strategy} onValueChange={(v) => setStrategy(v as Strategy)}>
                  <SelectTrigger className="min-h-11 w-full text-base sm:text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly-allocation" className="min-h-11">
                      Monthly allocation
                    </SelectItem>
                    <SelectItem value="rebalance-only" className="min-h-11">
                      Rebalance only
                    </SelectItem>
                    <SelectItem value="catalyst-driven" className="min-h-11">
                      Catalyst-driven
                    </SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {strategy === 'catalyst-driven' && (
                <>
                  <Field label="Holding period (trading days)">
                    <Select value={holdingDays} onValueChange={(v) => setHoldingDays(v)}>
                      <SelectTrigger className="min-h-11 w-full text-base sm:text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="5" className="min-h-11">
                          5 days
                        </SelectItem>
                        <SelectItem value="10" className="min-h-11">
                          10 days
                        </SelectItem>
                        <SelectItem value="30" className="min-h-11">
                          30 days
                        </SelectItem>
                        <SelectItem value="60" className="min-h-11">
                          60 days
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    label="Catalyst max per day"
                    hint="Equal-weight allocation across at most this many catalyst events per day."
                  >
                    <Input
                      type="number"
                      className="min-h-11 text-base sm:text-sm"
                      inputMode="numeric"
                      min={1}
                      max={5}
                      step={1}
                      value={catalystMaxPerDay}
                      onChange={(e) => setCatalystMaxPerDay(e.target.value)}
                    />
                  </Field>
                </>
              )}
              <Field label="Initial cash (USD)">
                <Input
                  type="number"
                  className="min-h-11 text-base sm:text-sm"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={initialCash}
                  onChange={(e) => setInitialCash(e.target.value)}
                  required
                />
              </Field>
              <Field label="Monthly budget (USD)">
                <Input
                  type="number"
                  className="min-h-11 text-base sm:text-sm"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={monthlyBudget}
                  onChange={(e) => setMonthlyBudget(e.target.value)}
                  required
                />
              </Field>
              <Field label="Single position cap (%)">
                <Input
                  type="number"
                  className="min-h-11 text-base sm:text-sm"
                  inputMode="decimal"
                  min={0.01}
                  max={100}
                  step="0.01"
                  value={singleCap}
                  onChange={(e) => setSingleCap(e.target.value)}
                  required
                />
              </Field>
              <Field label="Sector cap (%)">
                <Input
                  type="number"
                  className="min-h-11 text-base sm:text-sm"
                  inputMode="decimal"
                  min={0.01}
                  max={100}
                  step="0.01"
                  value={sectorCap}
                  onChange={(e) => setSectorCap(e.target.value)}
                  required
                />
              </Field>
              <Field
                label="Candidate tickers"
                className="md:col-span-2"
                hint="Comma-separated. Must have Tiingo EOD data for the window."
              >
                <Input
                  className="min-h-11 text-base sm:text-sm"
                  value={candidates}
                  onChange={(e) => setCandidates(e.target.value)}
                  placeholder="AAPL, MSFT, GOOGL, NVDA"
                  required
                />
              </Field>
              <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between md:col-span-3">
                <div className="font-mono text-xs text-muted-foreground">
                  {data?.backtestRunId
                    ? `Last run persisted as BacktestRun #${data.backtestRunId}`
                    : 'Run a backtest to see results.'}
                </div>
                <Button type="submit" disabled={running} className="min-h-11 w-full sm:w-auto">
                  {running ? 'Running…' : 'Run backtest'}
                </Button>
              </div>
              {error && (
                <div className="md:col-span-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                  {error}
                </div>
              )}
            </form>
          </FrostedPanel>
        </section>

        {data && (
          <>
            <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
              <MetricCard
                label="Final value"
                value={fmtUsd(data.finalValueUsd)}
                tone={data.finalValueUsd >= 0 ? 'neutral' : 'bad'}
              />
              <MetricCard
                label="Total return"
                value={fmtPct(data.totalReturnPct)}
                tone={data.totalReturnPct >= 0 ? 'good' : 'bad'}
              />
              <MetricCard
                label="SPY return"
                value={fmtPct(data.spyReturnPct)}
                tone={data.spyReturnPct >= 0 ? 'good' : 'bad'}
              />
              <MetricCard
                label="CAGR"
                value={fmtPct(data.cagr)}
                tone={data.cagr >= 0 ? 'good' : 'bad'}
              />
              <MetricCard
                label="Max drawdown"
                value={fmtPct(-Math.abs(data.maxDrawdownPct))}
                tone="bad"
              />
            </section>

            <section className="mb-8">
              <FrostedPanel>
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Equity curve
                    </div>
                    <div className="text-sm text-foreground/80">
                      Portfolio vs. SPY buy-and-hold, normalized to initial cash.
                    </div>
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {data.equityCurve.length} daily points
                  </div>
                </div>
                <div className="h-64 w-full min-w-0 sm:h-80">
                  <ResponsiveContainer
                    width="100%"
                    height="100%"
                    minWidth={0}
                    minHeight={0}
                    initialDimension={{ width: 640, height: 256 }}
                  >
                    <LineChart
                      data={data.equityCurve.map((p) => ({
                        date: p.date.slice(0, 10),
                        portfolio: p.valueUsd,
                        spy: p.spyValueUsd,
                      }))}
                      margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                    >
                      <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="date"
                        stroke="rgba(255,255,255,0.4)"
                        fontSize={10}
                        minTickGap={40}
                      />
                      <YAxis
                        stroke="rgba(255,255,255,0.4)"
                        fontSize={10}
                        tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(10,10,11,0.92)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                        }}
                        formatter={(v, name) => [
                          fmtUsd(typeof v === 'number' ? v : Number(v)),
                          String(name ?? ''),
                        ]}
                      />
                      <Legend wrapperStyle={{ fontSize: 12, fontFamily: 'var(--font-mono)' }} />
                      <Line
                        type="monotone"
                        dataKey="portfolio"
                        name="Portfolio"
                        stroke="#34d399"
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="spy"
                        name="SPY"
                        stroke="#60a5fa"
                        strokeWidth={2}
                        dot={false}
                        strokeDasharray="4 4"
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </FrostedPanel>
            </section>

            <section className="mb-8">
              <FrostedPanel>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Trades
                    </div>
                    <div className="text-sm text-foreground/80">
                      {data.entries.length} entries · {data.exits.length} exits
                    </div>
                  </div>
                </div>
                <TradesTable
                  trades={[...data.entries, ...data.exits].sort(
                    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
                  )}
                />
              </FrostedPanel>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function FrostedPanel({
  children,
  className,
}: React.PropsWithChildren<{ className?: string }>): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-xl border border-white/10 bg-card/60 p-4 shadow-lg sm:p-6',
        'backdrop-blur-xl ring-1 ring-inset ring-white/5',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
  className,
}: React.PropsWithChildren<{
  label: string;
  hint?: string;
  className?: string;
}>): React.ReactElement {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <span className="font-mono text-[10px] text-muted-foreground/60">{hint}</span>}
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'bad' | 'neutral';
}): React.ReactElement {
  const toneClass =
    tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-foreground';
  return (
    <Card className="min-w-0 border-white/10 bg-card/60 backdrop-blur-xl">
      <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
        <CardTitle className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
        <div
          className={cn(
            'break-words font-mono text-base font-medium tabular-nums sm:text-xl',
            toneClass,
          )}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function TradesTable({ trades }: { trades: BacktestTrade[] }): React.ReactElement {
  if (trades.length === 0) {
    return (
      <div className="rounded-md border border-white/5 bg-black/20 p-4 text-center font-mono text-xs text-muted-foreground">
        No trades in this run.
      </div>
    );
  }
  return (
    <div>
      <div className="space-y-3 md:hidden">
        {trades.map((t, i) => (
          <article
            key={`${t.date}-${t.ticker}-${i}`}
            className="rounded-md border border-white/5 bg-black/20 p-4"
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-base font-semibold break-words">{t.ticker}</div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  {t.date.slice(0, 10)}
                </div>
              </div>
              <span
                className={cn(
                  'shrink-0 inline-flex items-center rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-widest',
                  t.kind === 'buy'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                    : t.kind === 'exit'
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-400',
                )}
              >
                {t.kind}
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Shares
                </dt>
                <dd className="mt-1 font-mono tabular-nums">{t.shares.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Price
                </dt>
                <dd className="mt-1 break-words font-mono tabular-nums">{fmtUsd(t.price)}</dd>
              </div>
              <div>
                <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Dollars
                </dt>
                <dd className="mt-1 break-words font-mono tabular-nums">{fmtUsd(t.dollars)}</dd>
              </div>
            </dl>
            <div className="mt-4 border-t border-white/5 pt-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Rationale
              </div>
              <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                {t.rationale}
              </p>
            </div>
          </article>
        ))}
      </div>
      <div className="hidden overflow-hidden rounded-md border border-white/5 md:block">
        <Table>
          <TableHeader>
            <TableRow className="border-white/5 hover:bg-transparent">
              <TableHead className="font-mono text-[10px] uppercase tracking-widest">
                Date
              </TableHead>
              <TableHead className="font-mono text-[10px] uppercase tracking-widest">
                Ticker
              </TableHead>
              <TableHead className="font-mono text-[10px] uppercase tracking-widest">
                Action
              </TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-widest">
                Shares
              </TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-widest">
                Price
              </TableHead>
              <TableHead className="text-right font-mono text-[10px] uppercase tracking-widest">
                Dollars
              </TableHead>
              <TableHead className="font-mono text-[10px] uppercase tracking-widest">
                Rationale
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trades.map((t, i) => (
              <TableRow key={`${t.date}-${t.ticker}-${i}`} className="border-white/5">
                <TableCell className="font-mono text-xs">{t.date.slice(0, 10)}</TableCell>
                <TableCell className="font-mono text-xs font-semibold">{t.ticker}</TableCell>
                <TableCell>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest',
                      t.kind === 'buy'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                        : t.kind === 'exit'
                          ? 'border-rose-500/40 bg-rose-500/10 text-rose-400'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-400',
                    )}
                  >
                    {t.kind}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {t.shares.toFixed(2)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {fmtUsd(t.price)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {fmtUsd(t.dollars)}
                </TableCell>
                <TableCell className="max-w-[32ch] truncate font-mono text-[11px] text-muted-foreground">
                  {t.rationale}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '0.00%';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
