/**
 * /ops — internal observability dashboard.
 *
 * - JobRun status table (last 50)
 * - LlmCall spend: today / MTD / caches
 * - Source health: last successful run per adapter
 * - Recent errors feed
 */

import * as React from 'react';
import {
  prisma,
  startOfZonedDay,
  startOfZonedMonth,
  TelegramDeliveryStatus,
  type UserSettings,
} from '@vantage/db';
import { WEB_SEARCH_COST_USD } from '@vantage/llm';
import { componentLogger } from '@vantage/notify';
import { DbErrorBanner } from '@/components/DbErrorBanner';
import { FrostedPanel } from '@/components/FrostedPanel';
import { StatusDot } from '@/components/StatusDot';
import { fmtDateTime, fmtTimeAgo, fmtUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import { callWorker } from '@/lib/worker';

export const dynamic = 'force-dynamic';

const log = componentLogger('web/ops');

const CATALYST_PURPOSES = ['catalyst-eval', '8k-classify', 'earnings-guidance'] as const;

interface DeepHealthPayload {
  lastRuns?: Record<
    string,
    {
      lastSuccessAt: string | null;
      status: 'fresh' | 'stale' | 'error' | 'unknown';
    }
  >;
  telegram?: {
    configured: boolean;
    pending: number;
    dead: number;
  };
}

interface CatalystSpendBreakdown {
  today: number;
  monthToDate: number;
  perPurposeToday: Array<{ purpose: string; usd: number }>;
  lastRun: { startedAt: Date; metadata: unknown; status: string } | null;
}

export default async function OpsPage(): Promise<React.ReactElement> {
  let jobs: Awaited<ReturnType<typeof prisma.jobRun.findMany>> = [];
  let llmToday = 0;
  let llmMonth = 0;
  let cachedTokensSum = 0;
  let cacheCreationTokensSum = 0;
  let inputTokensSum = 0;
  let webSearchRequests = 0;
  let recentErrors: Awaited<ReturnType<typeof prisma.jobRun.findMany>> = [];
  let sourceHealth: Array<{ name: string; lastSuccess: Date | null; status: string }> = [];
  let dbErr: string | null = null;
  let workerErr: string | null = null;
  let catalystSpend: CatalystSpendBreakdown = {
    today: 0,
    monthToDate: 0,
    perPurposeToday: [],
    lastRun: null,
  };
  let catalystSpendCap = 1.0;
  let telegramPending = 0;
  let telegramDead = 0;
  let telegramConfigured: boolean | null = null;
  let settings: UserSettings | null = null;

  try {
    settings = await prisma.userSettings.findUnique({ where: { id: 1 } });
  } catch (err) {
    log.error({ err }, 'ops settings load failed');
    dbErr = 'database unavailable';
  }

  try {
    const now = new Date();
    const timezone = settings?.timezone ?? process.env['TZ'] ?? 'America/Toronto';
    const startOfDay = startOfZonedDay(now, timezone);
    const startOfMonth = startOfZonedMonth(now, timezone);

    [jobs, recentErrors] = await Promise.all([
      prisma.jobRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 50,
      }),
      prisma.jobRun.findMany({
        where: { status: 'failed' },
        orderBy: { startedAt: 'desc' },
        take: 20,
      }),
    ]);

    const [todayAgg, monthAgg, cacheAgg] = await Promise.all([
      prisma.llmCall.aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: startOfDay } },
      }),
      prisma.llmCall.aggregate({
        _sum: { costUsd: true },
        where: { createdAt: { gte: startOfMonth } },
      }),
      prisma.llmCall.aggregate({
        _sum: {
          cachedTokens: true,
          cacheCreationTokens: true,
          inputTokens: true,
          webSearchRequests: true,
        },
        where: { createdAt: { gte: startOfMonth } },
      }),
    ]);
    llmToday = Number(todayAgg._sum.costUsd ?? 0);
    llmMonth = Number(monthAgg._sum.costUsd ?? 0);
    cachedTokensSum = Number(cacheAgg._sum.cachedTokens ?? 0);
    cacheCreationTokensSum = Number(cacheAgg._sum.cacheCreationTokens ?? 0);
    inputTokensSum = Number(cacheAgg._sum.inputTokens ?? 0);
    webSearchRequests = Number(cacheAgg._sum.webSearchRequests ?? 0);

    // Phase 17.12 — catalyst engine spend pane.
    const [catalystToday, catalystMonth, catalystByPurpose, lastCatalystRun] = await Promise.all([
      prisma.llmCall.aggregate({
        _sum: { costUsd: true },
        where: {
          createdAt: { gte: startOfDay },
          purpose: { in: [...CATALYST_PURPOSES] },
        },
      }),
      prisma.llmCall.aggregate({
        _sum: { costUsd: true },
        where: {
          createdAt: { gte: startOfMonth },
          purpose: { in: [...CATALYST_PURPOSES] },
        },
      }),
      prisma.llmCall.groupBy({
        by: ['purpose'],
        _sum: { costUsd: true },
        where: {
          createdAt: { gte: startOfDay },
          purpose: { in: [...CATALYST_PURPOSES] },
        },
      }),
      prisma.jobRun.findFirst({
        where: { name: 'catalyst.run' },
        orderBy: { startedAt: 'desc' },
      }),
    ]);
    catalystSpend = {
      today: Number(catalystToday._sum.costUsd ?? 0),
      monthToDate: Number(catalystMonth._sum.costUsd ?? 0),
      perPurposeToday: catalystByPurpose.map((row) => ({
        purpose: row.purpose,
        usd: Number(row._sum.costUsd ?? 0),
      })),
      lastRun: lastCatalystRun
        ? {
            startedAt: lastCatalystRun.startedAt,
            metadata: lastCatalystRun.metadata,
            status: lastCatalystRun.status,
          }
        : null,
    };
  } catch (err) {
    log.error({ err }, 'ops primary data load failed');
    dbErr = 'database unavailable';
  }

  const deepHealth = await callWorker<DeepHealthPayload>('/health/deep', {
    includeErrorData: true,
  });
  if (deepHealth.data?.lastRuns) {
    sourceHealth = Object.entries(deepHealth.data.lastRuns).map(([name, health]) => ({
      name,
      lastSuccess: health.lastSuccessAt ? new Date(health.lastSuccessAt) : null,
      status: health.status,
    }));
    telegramConfigured = deepHealth.data.telegram?.configured ?? null;
  } else {
    workerErr = 'worker health unavailable';
  }

  const dailyCap = settings ? Number(settings.dailySpendCapUsd) : 2.0;
  const monthlyCap = settings ? Number(settings.monthlySpendCapUsd) : 10;
  catalystSpendCap = settings ? Number(settings.catalystDailySpendCapUsd) : 1.0;
  const totalInputTokens = inputTokensSum + cachedTokensSum + cacheCreationTokensSum;
  const cacheRate = totalInputTokens > 0 ? (cachedTokensSum / totalInputTokens) * 100 : 0;

  // Backlog of unprocessed MarketEvents — surfacing this prevents the silent
  // pile-up that burned $5 of LLM budget earlier when the alert dispatcher
  // chewed through 933 stale events. > 50 is amber, > 200 is red.
  let eventBacklog = 0;
  try {
    eventBacklog = await prisma.marketEvent.count({ where: { processedAt: null } });
  } catch (err) {
    log.error({ err }, 'ops event backlog load failed');
    dbErr ??= 'database unavailable';
  }

  try {
    [telegramPending, telegramDead] = await Promise.all([
      prisma.telegramDelivery.count({
        where: { status: TelegramDeliveryStatus.Pending },
      }),
      prisma.telegramDelivery.count({
        where: { status: TelegramDeliveryStatus.Dead },
      }),
    ]);
  } catch (err) {
    log.error({ err }, 'ops Telegram outbox load failed');
    dbErr ??= 'database unavailable';
  }

  return (
    <div className="cc-page">
      <header className="cc-page-header">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
            ops
          </div>
          <h1 className="cc-page-title">Internals</h1>
          <p className="mt-1 text-sm text-muted-foreground">Jobs, spend, sources, errors.</p>
        </div>
      </header>

      <DbErrorBanner message={dbErr} />
      {workerErr ? (
        <div className="mb-6 rounded-md border border-amber-500/35 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-200">
          Worker health is temporarily unavailable. Job history below may be stale.
        </div>
      ) : null}

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Metric
          label="Spend today"
          value={fmtUsd(llmToday)}
          sub={`cap ${fmtUsd(dailyCap)}`}
          tone={llmToday >= dailyCap ? 'bad' : llmToday >= dailyCap * 0.7 ? 'warn' : 'good'}
        />
        <Metric
          label="Spend MTD"
          value={fmtUsd(llmMonth)}
          sub={`cap ${fmtUsd(monthlyCap)}`}
          tone={llmMonth >= monthlyCap ? 'bad' : llmMonth >= monthlyCap * 0.7 ? 'warn' : 'good'}
        />
        <Metric
          label="Cache hit rate"
          value={`${cacheRate.toFixed(1)}%`}
          sub="cache reads / all input (MTD)"
          tone={cacheRate >= 50 ? 'good' : cacheRate >= 25 ? 'warn' : 'bad'}
        />
        <Metric
          label="Web searches MTD"
          value={String(webSearchRequests)}
          sub={`${fmtUsd(webSearchRequests * WEB_SEARCH_COST_USD)} included in spend`}
          tone={webSearchRequests <= 25 ? 'good' : webSearchRequests <= 75 ? 'warn' : 'bad'}
        />
        <Metric
          label="Kill switch"
          value={settings?.killSwitch ? 'ON' : 'OFF'}
          tone={settings?.killSwitch ? 'bad' : 'good'}
        />
        <Metric
          label="Event backlog"
          value={String(eventBacklog)}
          sub="unprocessed MarketEvents"
          tone={eventBacklog > 200 ? 'bad' : eventBacklog > 50 ? 'warn' : 'good'}
        />
        <Metric
          label="Telegram queue"
          value={telegramConfigured === false ? 'disabled' : `${telegramPending} pending`}
          sub={
            telegramConfigured === false ? 'bot token or chat id missing' : `${telegramDead} dead`
          }
          tone={
            telegramConfigured === false || telegramDead > 0
              ? 'bad'
              : telegramPending > 0 || telegramConfigured === null
                ? 'warn'
                : 'good'
          }
        />
      </section>

      <section className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <FrostedPanel padding="none" className="overflow-hidden">
          <div className="border-b border-white/[0.06] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:px-5">
            Recent job runs
          </div>
          {jobs.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No runs yet.</div>
          ) : (
            <>
              <div className="divide-y divide-white/[0.05] md:hidden">
                {jobs.map((j) => {
                  const dur = j.endedAt
                    ? (j.endedAt.getTime() - j.startedAt.getTime()) / 1000
                    : null;
                  return (
                    <article key={j.id} className="p-4">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0 break-all font-mono text-sm font-medium">
                          {j.name}
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em]',
                            j.status === 'succeeded'
                              ? 'border-emerald-500/40 text-emerald-300'
                              : j.status === 'failed'
                                ? 'border-rose-500/40 text-rose-300'
                                : 'border-amber-500/40 text-amber-300',
                          )}
                        >
                          {j.status}
                        </span>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-3">
                        <div>
                          <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                            Started
                          </dt>
                          <dd className="mt-1 break-words font-mono text-xs text-muted-foreground">
                            {fmtDateTime(j.startedAt)}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
                            Duration
                          </dt>
                          <dd className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                            {dur === null ? '—' : `${dur.toFixed(1)}s`}
                          </dd>
                        </div>
                      </dl>
                      {j.error ? (
                        <div className="mt-3 break-words rounded border border-rose-500/20 bg-rose-500/[0.05] p-2 font-mono text-[11px] leading-relaxed text-rose-300/80">
                          {j.error}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
              <table className="hidden w-full text-sm md:table">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    <th className="px-4 py-2">Job</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Started</th>
                    <th className="px-4 py-2">Duration</th>
                    <th className="px-4 py-2">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const dur = j.endedAt
                      ? (j.endedAt.getTime() - j.startedAt.getTime()) / 1000
                      : null;
                    return (
                      <tr key={j.id} className="border-t border-white/[0.04]">
                        <td className="px-4 py-2 font-mono text-xs">{j.name}</td>
                        <td className="px-4 py-2">
                          <span
                            className={cn(
                              'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]',
                              j.status === 'succeeded'
                                ? 'border-emerald-500/40 text-emerald-300'
                                : j.status === 'failed'
                                  ? 'border-rose-500/40 text-rose-300'
                                  : 'border-amber-500/40 text-amber-300',
                            )}
                          >
                            {j.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                          {fmtDateTime(j.startedAt)}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs tabular-nums text-muted-foreground">
                          {dur === null ? '—' : `${dur.toFixed(1)}s`}
                        </td>
                        <td className="px-4 py-2 font-mono text-[10px] text-rose-300/80">
                          {j.error ? j.error.slice(0, 60) : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </FrostedPanel>

        <FrostedPanel padding="md">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Scheduled job health
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {sourceHealth.map((s) => (
              <li
                key={s.name}
                className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot
                    status={
                      s.status === 'fresh'
                        ? 'fresh'
                        : s.status === 'stale'
                          ? 'stale'
                          : s.status === 'error'
                            ? 'error'
                            : 'offline'
                    }
                  />
                  <span className="min-w-0 break-all font-mono text-xs">{s.name}</span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {s.lastSuccess ? fmtTimeAgo(s.lastSuccess) : 'never'}
                </span>
              </li>
            ))}
            {sourceHealth.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No health data.</li>
            ) : null}
          </ul>
        </FrostedPanel>
      </section>

      <section className="mb-6">
        <CatalystSpendPanel spend={catalystSpend} spendCap={catalystSpendCap} />
      </section>

      <section>
        <FrostedPanel padding="none" className="overflow-hidden">
          <div className="border-b border-white/[0.06] px-5 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Recent failures
          </div>
          {recentErrors.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">Nothing broken. Nice.</div>
          ) : (
            <ul className="divide-y divide-white/[0.04]">
              {recentErrors.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-col items-start gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-5"
                >
                  <span className="font-mono text-[10px] text-muted-foreground sm:shrink-0">
                    {fmtDateTime(e.startedAt)}
                  </span>
                  <span className="break-all font-mono text-xs sm:shrink-0">{e.name}</span>
                  <span className="min-w-0 break-words font-mono text-[10px] leading-relaxed text-rose-300/80 sm:flex-1 sm:truncate">
                    {e.error ?? 'no message'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </FrostedPanel>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad' | 'warn' | 'neutral';
}): React.ReactElement {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-400'
      : tone === 'bad'
        ? 'text-rose-400'
        : tone === 'warn'
          ? 'text-amber-300'
          : 'text-foreground';
  return (
    <FrostedPanel className="min-w-0 flex flex-col gap-1">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'break-words font-mono text-base font-medium tabular-nums sm:text-lg',
          toneClass,
        )}
      >
        {value}
      </div>
      {sub && <div className="font-mono text-[10px] text-muted-foreground/60">{sub}</div>}
    </FrostedPanel>
  );
}

function CatalystSpendPanel({
  spend,
  spendCap,
}: {
  spend: CatalystSpendBreakdown;
  spendCap: number;
}): React.ReactElement {
  const todayPct = spendCap > 0 ? Math.min(100, (spend.today / spendCap) * 100) : 0;
  const tone = spend.today >= spendCap ? 'bad' : spend.today >= spendCap * 0.7 ? 'warn' : 'good';
  const toneClass =
    tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : 'text-amber-300';
  const meta = spend.lastRun?.metadata;
  let lastRunSummary: string | null = null;
  if (meta && typeof meta === 'object') {
    const obj = meta as Record<string, unknown>;
    const summary = obj['summary'];
    if (summary && typeof summary === 'object') {
      const sObj = summary as Record<string, unknown>;
      const suggestions = sObj['suggestions'];
      if (typeof suggestions === 'number') {
        lastRunSummary = `${suggestions} suggestion${suggestions === 1 ? '' : 's'}`;
      }
    }
  }
  return (
    <FrostedPanel padding="md">
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Catalyst engine spend
        </div>
        <div className="break-words font-mono text-[10px] text-muted-foreground/60">
          purposes: catalyst-eval · 8k-classify · earnings-guidance
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-md border border-white/[0.08] bg-black/20 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Spend today
          </div>
          <div className={cn('mt-1 font-mono text-lg font-medium tabular-nums', toneClass)}>
            {fmtUsd(spend.today)}{' '}
            <span className="text-xs text-muted-foreground/60">/ {fmtUsd(spendCap)}</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                tone === 'good'
                  ? 'bg-emerald-500/70'
                  : tone === 'warn'
                    ? 'bg-amber-500/70'
                    : 'bg-rose-500/80',
              )}
              style={{ width: `${todayPct}%` }}
            />
          </div>
        </div>
        <div className="rounded-md border border-white/[0.08] bg-black/20 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Spend month-to-date
          </div>
          <div className="mt-1 font-mono text-lg font-medium tabular-nums text-foreground">
            {fmtUsd(spend.monthToDate)}
          </div>
        </div>
        <div className="rounded-md border border-white/[0.08] bg-black/20 p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Last engine run
          </div>
          <div className="mt-1 font-mono text-xs text-foreground">
            {spend.lastRun ? fmtDateTime(spend.lastRun.startedAt) : 'never'}
          </div>
          <div className="mt-1 font-mono text-[10px] text-muted-foreground/70">
            {spend.lastRun
              ? `status: ${spend.lastRun.status}${lastRunSummary ? ` · ${lastRunSummary}` : ''}`
              : 'awaiting first run'}
          </div>
        </div>
      </div>
      {spend.perPurposeToday.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {spend.perPurposeToday.map((p) => (
            <span
              key={p.purpose}
              className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {p.purpose}: {fmtUsd(p.usd)}
            </span>
          ))}
        </div>
      )}
    </FrostedPanel>
  );
}
