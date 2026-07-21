import * as React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@vantage/db';
import { getGoalDetail, type GoalDetail } from '../data';
import type { EditGoalInitial } from '../EditGoalForm';
import { listAccounts } from '../../accounts/data';
import { GoalProgressBar } from '../GoalProgressBar';
import { GoalProgressChart } from '../GoalProgressChart';
import { LinkPositionForm } from '../LinkPositionForm';
import { GoalDetailHeader } from '../GoalDetailHeader';
import { DayTradeScannerTable } from '../DayTradeScannerTable';
import { DbErrorBanner } from '@/components/DbErrorBanner';
import { isTorontoDateKeyInPast } from '@/lib/marketTime';

export const dynamic = 'force-dynamic';

const cadFmt = (v: number) =>
  v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });

const cadFmtCents = (v: number) =>
  v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 2 });

const dateFmt = (d: Date) =>
  d.toLocaleDateString('en-CA', { timeZone: 'UTC', year: 'numeric', month: 'short' });

const dayFmt = (d: Date) =>
  d.toLocaleDateString('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const FREQUENCY_LABEL: Record<string, string> = {
  Weekly: 'weekly',
  Biweekly: 'biweekly',
  Monthly: 'monthly',
  Quarterly: 'quarterly',
};

// Per-period -> per-year multiplier, for "≈ $X/yr" context on the plan card.
const PERIODS_PER_YEAR: Record<string, number> = {
  Weekly: 52,
  Biweekly: 26,
  Monthly: 12,
  Quarterly: 4,
};

interface PageProps {
  params: Promise<{ id: string }>;
}

async function loadGoalSupportingData(): Promise<{
  openPositions: Array<{
    id: number;
    ticker: string;
    shares: unknown;
    accountId: number;
    account: { name: string };
  }>;
  accounts: Awaited<ReturnType<typeof listAccounts>>;
}> {
  const [openPositions, accounts] = await Promise.all([
    prisma.position.findMany({
      where: { closedAt: null },
      select: {
        id: true,
        ticker: true,
        shares: true,
        accountId: true,
        account: { select: { name: true } },
      },
      orderBy: { ticker: 'asc' },
    }),
    listAccounts({ includeArchived: false }),
  ]);
  return { openPositions, accounts };
}

function GoalLoadFailure({ message }: { message: string }): React.ReactElement {
  return (
    <div className="cc-page">
      <Link href="/goals" className="mb-5 inline-flex text-xs text-zinc-500 hover:text-zinc-300">
        Back to goals
      </Link>
      <h1 className="cc-page-title mb-4">Goal unavailable</h1>
      <DbErrorBanner message={message} />
    </div>
  );
}

export default async function GoalDetailPage({ params }: PageProps): Promise<React.ReactElement> {
  const { id } = await params;
  const goalId = Number(id);
  if (!Number.isFinite(goalId)) notFound();
  let goal: GoalDetail | null = null;
  try {
    goal = await getGoalDetail(goalId);
  } catch (err) {
    return (
      <GoalLoadFailure message={err instanceof Error ? err.message : 'database unreachable'} />
    );
  }
  if (!goal) notFound();

  let supportingData: Awaited<ReturnType<typeof loadGoalSupportingData>>;
  try {
    supportingData = await loadGoalSupportingData();
  } catch (err) {
    return (
      <GoalLoadFailure message={err instanceof Error ? err.message : 'database unreachable'} />
    );
  }
  const { openPositions, accounts } = supportingData;
  const linkablePositions = openPositions.map((p) => ({
    id: p.id,
    ticker: p.ticker,
    accountId: p.accountId,
    accountName: p.account.name,
    shares: Number(p.shares),
  }));
  const alreadyLinked = goal.positions.map((p) => p.positionId);
  const linkedPositions = goal.positions.map((p) => ({
    id: p.positionId,
    ticker: p.ticker,
    accountName: p.accountName,
    shares: p.shares,
    allocation: p.allocation,
  }));
  const accountChoices = accounts.map((a) => ({ id: a.id, name: a.name, type: a.type }));

  const headerInitial = {
    id: goal.id,
    name: goal.name,
    type: goal.type,
    targetAmountCad: goal.targetAmountCad,
    targetDate: goal.targetDate,
    isWithdrawal: goal.isWithdrawal,
    notes: goal.notes,
    riskOverride: goal.riskOverride,
    strategy: goal.strategy,
    tradingStyle: goal.tradingStyle,
    contributionAmountCad: goal.contributionAmountCad,
    contributionFrequency: goal.contributionFrequency,
    contributionStartDate: goal.contributionStartDate,
    accountId: goal.account?.id ?? null,
  };

  // DayTrading is a fundamentally different surface — render a distinct,
  // disclaimer-forward layout instead of the buy-and-hold glide/progress view.
  if (goal.type === 'DayTrading') {
    return (
      <DayTradingDetail goal={goal} accountChoices={accountChoices} headerInitial={headerInitial} />
    );
  }

  // Next-action nudge — pure composition of signals already on the page.
  const { onTrack, shortfallCad, requiredMonthlyCad } = goal.progress;
  const topPicks = goal.recommendedSecurities.slice(0, 3);
  const targetDateLabel = goal.targetDate ? dateFmt(goal.targetDate) : null;
  // Securities link into the buy flow, pre-filled with the recommended account.
  const buyAccountId = goal.recommendedAccount.bestAccountId ?? goal.account?.id ?? null;
  const buyHref = (ticker: string) => {
    const params = new URLSearchParams({ ticker, goalId: String(goal.id) });
    if (buyAccountId !== null) params.set('accountId', String(buyAccountId));
    return `/portfolio/add?${params.toString()}`;
  };

  const tickerLinks =
    topPicks.length > 0 ? (
      <span className="inline-flex flex-wrap gap-1.5 align-middle">
        {topPicks.map((s) => (
          <Link
            key={s.ticker}
            href={buyHref(s.ticker)}
            className="inline-flex min-h-11 items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 font-mono text-xs text-emerald-300 hover:bg-emerald-500/20 sm:min-h-0 sm:px-1.5 sm:py-0.5"
          >
            {s.ticker}
          </Link>
        ))}
      </span>
    ) : null;

  let nudgeBody: React.ReactNode;
  let nudgeTone: string;
  if (goal.targetDate === null) {
    // Open-ended: no deadline to be behind on — neutral framing.
    nudgeTone = 'border-zinc-500/30 bg-zinc-500/5 text-zinc-300';
    nudgeBody = (
      <>
        Open-ended goal — currently {cadFmt(goal.progress.currentValueCad)}.
        {topPicks.length > 0 ? <> Top picks to grow it: {tickerLinks}</> : null}
      </>
    );
  } else if (!onTrack && shortfallCad > 0) {
    nudgeTone = 'border-amber-500/30 bg-amber-500/5 text-amber-200';
    nudgeBody = (
      <>
        You&apos;re {cadFmt(shortfallCad)} behind.{' '}
        {requiredMonthlyCad !== null && targetDateLabel ? (
          <>
            Contribute ~{cadFmt(requiredMonthlyCad)}/mo to hit your target by {targetDateLabel}
            {topPicks.length > 0 ? <>, or add one of: {tickerLinks}</> : null}.
          </>
        ) : topPicks.length > 0 ? (
          <>Add one of: {tickerLinks} to close the gap.</>
        ) : null}
      </>
    );
  } else {
    nudgeTone = 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200';
    nudgeBody = (
      <>
        On track — at this pace you&apos;ll hit {cadFmt(goal.progress.targetCad)}
        {targetDateLabel ? <> by {targetDateLabel}</> : null}.
      </>
    );
  }

  // Contribution-plan derived display values (buy-and-hold only).
  const { projection } = goal;
  const hasPlan = projection.hasSchedule && goal.contributionAmountCad != null;
  const freqLabel = goal.contributionFrequency
    ? (FREQUENCY_LABEL[goal.contributionFrequency] ?? goal.contributionFrequency.toLowerCase())
    : '';
  const perYear =
    hasPlan && goal.contributionFrequency
      ? (goal.contributionAmountCad as number) * (PERIODS_PER_YEAR[goal.contributionFrequency] ?? 0)
      : 0;
  const nextContribDate = projection.nextContributionDate
    ? new Date(`${projection.nextContributionDate}T00:00:00.000Z`)
    : null;
  // Overdue when the next scheduled date is strictly before today (the schedule
  // started in the past and a contribution window has elapsed).
  const contribOverdue = projection.nextContributionDate
    ? isTorontoDateKeyInPast(projection.nextContributionDate)
    : false;

  // Drift hint comparing actual equity weight to the target glide.
  const actual = goal.actualAllocation;
  let driftHint: string | null = null;
  const roomShortfall = Math.max(goal.progress.targetCad - goal.progress.currentValueCad, 0);
  if (actual) {
    const equityDiff = actual.equityPct - goal.glide.equityPct;
    if (equityDiff <= -15) {
      driftHint = `You're ${actual.equityPct}% equity vs a ${goal.glide.equityPct}% target — consider adding growth.`;
    } else if (equityDiff >= 15) {
      driftHint = `You're ${actual.equityPct}% equity vs a ${goal.glide.equityPct}% target — consider trimming risk for this horizon.`;
    } else {
      driftHint = `Your mix is close to the ${goal.glide.equityPct}% equity target.`;
    }
  }

  return (
    <div className="cc-page space-y-6">
      <div className="mb-1 flex items-center gap-3">
        <Link
          href="/goals"
          className="inline-flex min-h-11 items-center text-xs text-zinc-500 hover:text-zinc-300"
        >
          ← Goals
        </Link>
      </div>
      <div className="[&>div]:flex-col [&>div]:gap-3 [&_button]:min-h-11 [&_button]:px-3 [&_h1]:flex-wrap [&_h1]:break-words sm:[&>div]:flex-row">
        <GoalDetailHeader initial={headerInitial} accounts={accountChoices} notes={goal.notes} />
      </div>

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Progress
        </div>
        <GoalProgressBar
          currentCad={goal.progress.currentValueCad}
          targetCad={goal.progress.targetCad}
          percentComplete={goal.progress.percentComplete}
          onTrack={goal.progress.onTrack}
          targetDate={goal.targetDate}
        />
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-xs text-zinc-500">Current</div>
            <div className="font-mono">{cadFmt(goal.progress.currentValueCad)}</div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Shortfall</div>
            <div
              className={
                'font-mono ' +
                (goal.progress.shortfallCad > 0 ? 'text-amber-300' : 'text-emerald-300')
              }
            >
              {cadFmt(goal.progress.shortfallCad)}
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Months left</div>
            <div className="font-mono">
              {goal.progress.monthsRemaining === null ? '—' : goal.progress.monthsRemaining}
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Required / mo</div>
            <div className="font-mono">
              {goal.progress.requiredMonthlyCad === null
                ? '—'
                : cadFmt(goal.progress.requiredMonthlyCad)}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Progress {hasPlan ? '& projection' : 'over time'}
        </div>
        <GoalProgressChart
          snapshots={goal.snapshots}
          targetCad={goal.progress.targetCad}
          projectionSeries={hasPlan ? projection.series : undefined}
          targetDate={goal.targetDate}
        />
        {hasPlan ? (
          <p className="mt-3 text-xs text-zinc-500">
            Projection assumes a {(projection.assumedAnnualReturn * 100).toFixed(1)}% net nominal
            annual return (FP Canada 2026 guidelines, blended to this goal&apos;s target-date
            allocation), with contributions invested at period end. Markets vary year to year — this
            is a planning estimate, not a guarantee.
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Contribution plan
        </div>
        {hasPlan ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="font-mono text-base text-emerald-300">
                {cadFmtCents(goal.contributionAmountCad as number)}
              </span>
              <span className="text-zinc-400">{freqLabel}</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">≈ {cadFmt(perYear)}/yr</span>
              {nextContribDate ? (
                <>
                  <span className="text-zinc-600">·</span>
                  <span className={contribOverdue ? 'text-amber-300' : 'text-zinc-400'}>
                    {contribOverdue ? 'contribution due' : 'next contribution'}{' '}
                    {dayFmt(nextContribDate)}
                  </span>
                </>
              ) : null}
            </div>
            {goal.targetDate === null ? (
              <p className="mt-2 text-sm text-zinc-300">
                {projection.monthsToTarget !== null ? (
                  <>
                    Open-ended — at this pace you&apos;re projected to reach{' '}
                    {cadFmt(goal.progress.targetCad)} in about {projection.monthsToTarget}{' '}
                    {projection.monthsToTarget === 1 ? 'month' : 'months'}.
                  </>
                ) : (
                  <>
                    Open-ended — this contribution pace doesn&apos;t reach{' '}
                    {cadFmt(goal.progress.targetCad)} within the projection window.
                  </>
                )}
              </p>
            ) : null}
            {goal.contributionSplit.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-xs text-zinc-500">
                  Suggested split across recommended securities (by fit weight)
                </div>
                <div className="flex flex-wrap gap-2">
                  {goal.contributionSplit.map((s) => (
                    <Link
                      key={s.ticker}
                      href={buyHref(s.ticker)}
                      className="inline-flex min-h-11 items-center rounded border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-xs hover:bg-emerald-500/15 sm:min-h-0 sm:px-2.5 sm:py-1.5"
                      title={`${(s.weight * 100).toFixed(0)}% of each contribution`}
                    >
                      <span className="font-mono text-emerald-300">{cadFmtCents(s.amountCad)}</span>{' '}
                      <span className="text-zinc-400">{s.ticker}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-zinc-500">
            No contribution plan — add one (edit this goal) to project your goal forward and get a
            per-contribution buy split.
          </p>
        )}
      </section>

      {hasPlan && goal.targetDate ? (
        <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
            Projection at target date
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-zinc-500">Projected value</div>
              <div className="font-mono">
                {projection.projectedValueAtTarget === null
                  ? '—'
                  : cadFmt(projection.projectedValueAtTarget)}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">On track?</div>
              <div>
                {projection.onTrack === null ? (
                  '—'
                ) : projection.onTrack ? (
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-300">
                    On track
                  </span>
                ) : (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-amber-300">
                    Short {cadFmt(projection.shortfall ?? 0)}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Required / period</div>
              <div className="font-mono">
                {projection.requiredContribution === null
                  ? '—'
                  : cadFmtCents(projection.requiredContribution)}
              </div>
            </div>
          </div>
          {projection.onTrack === false &&
          projection.requiredContribution !== null &&
          targetDateLabel ? (
            <p className="mt-3 text-sm text-amber-200">
              Contribute {cadFmtCents(projection.requiredContribution)}/{freqLabel} (up from{' '}
              {cadFmtCents(goal.contributionAmountCad as number)}) to hit your target by{' '}
              {targetDateLabel}.
            </p>
          ) : null}
          {projection.onTrack === true ? (
            <p className="mt-3 text-sm text-emerald-200">
              At {cadFmtCents(goal.contributionAmountCad as number)}/{freqLabel} you&apos;re
              projected to reach {cadFmt(goal.progress.targetCad)} by {targetDateLabel}.
            </p>
          ) : null}
          <p className="mt-3 text-xs text-zinc-500">
            Lump-sum investing has historically beaten dollar-cost averaging about two-thirds of the
            time; DCA&apos;s edge is discipline and lower regret in a downturn, not higher expected
            return.{' '}
            <a
              href="https://corporate.vanguard.com/content/dam/corp/research/pdf/cost_averaging_invest_now_or_temporarily_hold_your_cash.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center text-sky-400 hover:underline sm:min-h-0"
            >
              Vanguard, 2023
            </a>
          </p>
        </section>
      ) : null}

      <section className={'rounded-lg border p-4 text-sm sm:p-5 ' + nudgeTone}>
        <div className="mb-1 text-xs font-medium uppercase tracking-wider opacity-80">
          Next action
        </div>
        <p className="leading-relaxed">{nudgeBody}</p>
        {hasPlan && nextContribDate ? (
          <p
            className={'mt-2 leading-relaxed ' + (contribOverdue ? 'text-amber-300' : 'opacity-80')}
          >
            {contribOverdue ? (
              <>Contribution due — scheduled {dayFmt(nextContribDate)}.</>
            ) : (
              <>Next contribution due {dayFmt(nextContribDate)}.</>
            )}{' '}
            {cadFmtCents(goal.contributionAmountCad as number)} {freqLabel}.
          </p>
        ) : null}
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Recommended account
        </div>
        {goal.recommendedAccount.contributionRoomCad !== null &&
        goal.recommendedAccount.bestAccountId != null &&
        roomShortfall > goal.recommendedAccount.contributionRoomCad ? (
          <div className="mb-3 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-300">
            ⚠ The recommended account&apos;s contribution room is{' '}
            {cadFmt(goal.recommendedAccount.contributionRoomCad)}, but this goal still needs{' '}
            {cadFmt(roomShortfall)} to reach the target. You&apos;ll need additional room or to
            split funding across accounts.
          </div>
        ) : null}
        <div className="font-mono text-sm">
          {goal.recommendedAccount.bestAccountName ?? goal.recommendedAccount.rankedTypes[0] ?? '—'}
        </div>
        <p className="mt-2 text-sm text-zinc-300">{goal.recommendedAccount.rationale}</p>
        {goal.recommendedAccount.contributionRoomCad !== null &&
        goal.recommendedAccount.bestAccountId != null ? (
          <div className="mt-2 text-xs text-zinc-500">
            Selected account room: {cadFmt(goal.recommendedAccount.contributionRoomCad)}
          </div>
        ) : null}
        {goal.recommendedAccount.warning ? (
          <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-sm text-amber-300">
            ⚠ {goal.recommendedAccount.warning}
          </div>
        ) : null}
        <div className="mt-3 text-xs text-zinc-500">
          Ranked: {goal.recommendedAccount.rankedTypes.join(' → ')}
        </div>
      </section>

      {goal.riskHorizonWarning ? (
        <section className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200 sm:p-5">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-rose-300">
            Risk vs. horizon
          </div>
          <p className="leading-relaxed font-medium">{goal.riskHorizonWarning}</p>
          <p className="mt-2 leading-relaxed text-rose-200/80">
            We&apos;re honoring your explicit risk setting — the recommendations below reflect it
            rather than the safer, horizon-based default. Lower the risk on this goal to de-risk
            toward cash.
          </p>
        </section>
      ) : null}

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Recommended securities
        </div>
        {goal.recommendedSecurities.length === 0 ? (
          <div className="text-sm text-zinc-500">No recommendations for this goal type.</div>
        ) : (
          <ul className="space-y-2">
            {goal.recommendedSecurities.map((s) => (
              <li
                key={s.ticker}
                className="flex flex-col gap-2 border-b border-white/[0.04] pb-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:pb-2"
              >
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{s.ticker}</span>
                    <span className="text-xs text-zinc-500">{s.name}</span>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                      {s.currency}
                    </span>
                    {s.optimalForAccount && goal.recommendedFor ? (
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                        Best for {goal.recommendedFor}
                      </span>
                    ) : null}
                    {s.kind === 'discovery' ? (
                      <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-purple-300">
                        Discovery
                        {s.discoveryScore !== undefined ? (
                          <sup className="ml-1 text-[8px] text-purple-400">
                            {s.discoveryScore.toFixed(2)}
                          </sup>
                        ) : null}
                      </span>
                    ) : null}
                    {s.incomeYield !== undefined && s.incomeYieldSource ? (
                      <span
                        className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cyan-300"
                        title={
                          s.incomeYieldSource === 'metrics'
                            ? 'Trailing provider yield used by the recommendation engine'
                            : 'Reviewed fallback estimate used because provider yield was unavailable'
                        }
                      >
                        {s.incomeYieldSource === 'metrics' ? 'TTM yield' : 'Est yield'}{' '}
                        {(s.incomeYield * 100).toFixed(1)}%
                      </span>
                    ) : null}
                    {s.navErosionRisk === 'high' ? (
                      <span
                        className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300"
                        title="High distribution funded partly by return-of-capital — the fund can bleed NAV over time. Size as a satellite."
                      >
                        NAV-erosion risk
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-zinc-400">{s.reason}</p>
                  {s.taxRationale ? (
                    <p className="mt-1 text-xs text-zinc-500">{s.taxRationale}</p>
                  ) : null}
                </div>
                <div className="sm:text-right">
                  <div className="font-mono text-xs text-emerald-300">{s.fitScore}/100</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Linked positions
          </div>
        </div>
        <div className="mb-4 border-b border-white/[0.06] pb-4">
          <div className="[&_button]:min-h-11 [&_button]:px-3 [&_form]:flex-col [&_form]:items-stretch [&_input]:min-h-11 [&_label]:w-full [&_select]:min-h-11 [&_select]:w-full [&_select]:max-w-full sm:[&_form]:flex-row sm:[&_form]:items-end sm:[&_label]:w-auto sm:[&_select]:w-auto">
            <LinkPositionForm
              goalId={goal.id}
              openPositions={linkablePositions}
              alreadyLinked={alreadyLinked}
              linkedPositions={linkedPositions}
            />
          </div>
        </div>
        {goal.positions.length === 0 ? (
          <div className="text-sm text-zinc-500">
            No positions linked yet. Use the picker above to attach a position to this goal.
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {goal.positions.map((p) => (
                <article
                  key={p.positionId}
                  className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-base font-medium">{p.ticker}</div>
                      <div className="mt-1 break-words text-xs text-zinc-400">{p.accountName}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm">{cadFmt(p.valueCad)}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">
                        Value (CAD)
                      </div>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-white/[0.05] pt-3 text-xs">
                    <div>
                      <dt className="uppercase tracking-wider text-zinc-500">Shares</dt>
                      <dd className="mt-1 font-mono">{p.shares}</dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wider text-zinc-500">Allocation</dt>
                      <dd className="mt-1 font-mono">{(p.allocation * 100).toFixed(0)}%</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2">Account</th>
                  <th className="pb-2 text-right">Shares</th>
                  <th className="pb-2 text-right">Allocation</th>
                  <th className="pb-2 text-right">Value (CAD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {goal.positions.map((p) => (
                  <tr key={p.positionId}>
                    <td className="py-2 font-mono">{p.ticker}</td>
                    <td className="py-2 text-xs text-zinc-400">{p.accountName}</td>
                    <td className="py-2 text-right font-mono text-xs">{p.shares}</td>
                    <td className="py-2 text-right font-mono text-xs">
                      {(p.allocation * 100).toFixed(0)}%
                    </td>
                    <td className="py-2 text-right font-mono text-xs">{cadFmt(p.valueCad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Allocation — target vs actual
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-zinc-500">Target (glide path)</div>
            <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="bg-zinc-500"
                style={{ width: goal.glide.cashPct + '%' }}
                title={`Cash ${goal.glide.cashPct}%`}
              />
              <div
                className="bg-blue-500"
                style={{ width: goal.glide.bondPct + '%' }}
                title={`Bonds ${goal.glide.bondPct}%`}
              />
              <div
                className="bg-emerald-500"
                style={{ width: goal.glide.equityPct + '%' }}
                title={`Equity ${goal.glide.equityPct}%`}
              />
            </div>
          </div>
          {actual ? (
            <div>
              <div className="mb-1 text-xs text-zinc-500">Actual (linked positions)</div>
              <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="bg-zinc-500"
                  style={{ width: actual.cashPct + '%' }}
                  title={`Cash ${actual.cashPct}%`}
                />
                <div
                  className="bg-blue-500"
                  style={{ width: actual.bondPct + '%' }}
                  title={`Bonds ${actual.bondPct}%`}
                />
                <div
                  className="bg-emerald-500"
                  style={{ width: actual.equityPct + '%' }}
                  title={`Equity ${actual.equityPct}%`}
                />
              </div>
            </div>
          ) : (
            <div className="text-xs text-zinc-500">Link positions to compare your actual mix.</div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-zinc-400">
          <span>
            <span className="mr-1 inline-block size-2 rounded-full bg-zinc-500" />
            Cash
          </span>
          <span>
            <span className="mr-1 inline-block size-2 rounded-full bg-blue-500" />
            Bonds
          </span>
          <span>
            <span className="mr-1 inline-block size-2 rounded-full bg-emerald-500" />
            Equity
          </span>
        </div>
        {actual && driftHint ? <p className="mt-2 text-xs text-zinc-400">{driftHint}</p> : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DayTrading detail — a deliberately HONEST, disclaimer-forward layout. No
// glide path / progress-to-target (those don't model trading). Surfaces the
// scanner watchlist, the inverted (non-registered-only) account rec, and a
// 1%-risk position-sizing calculator. Server component (no client state).
// ---------------------------------------------------------------------------

function DayTradingDetail({
  goal,
  accountChoices,
  headerInitial,
}: {
  goal: GoalDetail;
  accountChoices: Array<{ id: number; name: string; type: string }>;
  headerInitial: EditGoalInitial;
}): React.ReactElement {
  const tradingCapital = goal.targetAmountCad;
  // Standard risk-management default: never risk more than 1% of trading capital
  // on a single trade. The per-candidate trade plans below turn this into an
  // exact share count using each name's ATR-based stop distance.
  const riskPerTrade = tradingCapital * 0.01;
  // The account rec warning fires (red) when the user has no non-registered account.
  const hasAccountWarning = !!goal.recommendedAccount.warning;

  // Quiet-tape framing off the TOP candidate's fitScore (the scanner returns the
  // list fitScore-desc, so [0] is the best setup today). fitScore is a per-style
  // SETUP-QUALITY score, not stock quality or direction: for Momentum it's
  // ~60% relative volume + catalyst + volatility, so when RVOL sits near 1x
  // across the board (a quiet tape) the whole board mathematically lands in the
  // 40s. That's honest, not bearish. Thresholds:
  //   < 55  → calm "quiet tape, no edge" banner (amber/zinc, NOT rose-alarm)
  //   ≥ 70  → a small positive "strong setup" note
  //   55–69 → neither (an ordinary middle, nothing to flag either way)
  // 55 is just below Momentum's "green" cutoff (70) and well above its quiet-tape
  // floor (~40s), so it cleanly separates "nothing moving" from "something's here."
  const QUIET_TAPE_BELOW = 55;
  const STRONG_SETUP_AT = 70;
  const topCandidate = goal.dayTradeCandidates[0] ?? null;
  const topFit = topCandidate ? topCandidate.fitScore : null;
  const isQuietTape = topFit !== null && topFit < QUIET_TAPE_BELOW;
  const isStrongSetup = topFit !== null && topFit >= STRONG_SETUP_AT;

  return (
    <div className="cc-page space-y-6">
      <div className="mb-1 flex items-center gap-3">
        <Link
          href="/goals"
          className="inline-flex min-h-11 items-center text-xs text-zinc-500 hover:text-zinc-300"
        >
          ← Goals
        </Link>
      </div>
      <div className="[&>div]:flex-col [&>div]:gap-3 [&_button]:min-h-11 [&_button]:px-3 [&_h1]:flex-wrap [&_h1]:break-words sm:[&>div]:flex-row">
        <GoalDetailHeader initial={headerInitial} accounts={accountChoices} notes={goal.notes} />
      </div>

      {/* 1. Risk disclaimer banner — prescriptive + honest. */}
      <section className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200 sm:p-5">
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-rose-300">
          Day-trading reality check
        </div>
        <p className="leading-relaxed">
          Each candidate below has a suggested{' '}
          <span className="font-semibold">entry, a hard stop, a target, and a position size</span>{' '}
          sized to risk <span className="font-semibold">~1% of this goal&apos;s capital</span>.
          Execute the plan and honor the stop — it&apos;s non-negotiable. This is still speculation,
          not investing: only <span className="font-semibold">~1-4% of day traders</span> are
          profitable long-term, so treat every plan as a hypothesis, not a guarantee.
        </p>
        <p className="mt-2 leading-relaxed text-rose-200/80">
          The price is always the <span className="font-semibold">freshest real print</span> we
          hold, labeled by session — <span className="font-semibold">live</span> during regular
          hours, else <span className="font-semibold">pre-market / after-hours / close</span> —
          stamped in ET (Alpaca, IEX). It never shows an older close when a newer print exists, and
          never calls an hours-old print &ldquo;live.&rdquo; ATR% (shown with its $ value) and
          relative volume are end-of-day daily readings (volatility is a daily measure). Extended
          hours run on IEX only, so thin names can have gaps. The plan&apos;s levels are computed
          from those inputs — they are not predictions.
        </p>
      </section>

      {/* 2. Account card — inverted logic (non-registered only) + CRA warning. */}
      <section
        className={
          'rounded-lg border p-4 sm:p-5 ' +
          (hasAccountWarning
            ? 'border-rose-500/40 bg-rose-500/[0.06]'
            : 'border-white/[0.06] bg-zinc-950/40')
        }
      >
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          Account for day trading
        </div>
        <div className="font-mono text-sm">
          {goal.recommendedAccount.bestAccountName ?? goal.recommendedAccount.rankedTypes[0] ?? '—'}
        </div>
        <p className="mt-2 text-sm text-zinc-300">{goal.recommendedAccount.rationale}</p>
        {goal.recommendedAccount.warning ? (
          <div className="mt-3 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-sm font-medium text-rose-300">
            ⚠ {goal.recommendedAccount.warning}
          </div>
        ) : null}
        <div className="mt-3 text-xs text-zinc-500">
          Ranked: {goal.recommendedAccount.rankedTypes.join(' → ')} (registered accounts excluded)
        </div>
      </section>

      {/* 2.5 Quiet-tape / strong-setup banner — honest read of TODAY's best setup
          quality. Calm amber/zinc when nothing's moving (NOT a rose alarm); a
          quiet emerald note when a genuinely strong setup exists. */}
      {isQuietTape ? (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm text-amber-200/90 sm:p-5">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-amber-300/80">
            Quiet tape
          </div>
          <p className="leading-relaxed">
            The best setup today scores <span className="font-semibold">{topFit}/100</span>.
            Relative volume is near average across the board, so there&apos;s no strong day-trade
            setup right now. Sitting out is a valid call — this score measures{' '}
            <span className="font-semibold">setup quality today</span>, not which way a stock will
            move.
          </p>
        </section>
      ) : isStrongSetup ? (
        <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-4 text-sm text-emerald-200/90 sm:p-5">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-emerald-300/80">
            Setup in play
          </div>
          <p className="leading-relaxed">
            The top candidate scores <span className="font-semibold">{topFit}/100</span> — a strong
            setup for this style (volume + catalyst + range are lining up). Still verify the live
            tape and honor the plan&apos;s stop; the score rates setup quality, not direction.
          </p>
        </section>
      ) : null}

      {/* 3. Candidate scanner table. */}
      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Candidate scanner{goal.tradingStyle ? ` — ${goal.tradingStyle}` : ''}
          </div>
          <div className="text-[11px] text-zinc-500 sm:text-right">
            Liquidity floor $5M/day · ATR ≥ 2% · daily data
          </div>
        </div>
        <DayTradeScannerTable
          candidates={goal.dayTradeCandidates.map((c) => ({
            ...c,
            asOf: c.asOf ? c.asOf.toISOString().slice(0, 10) : null,
            liveAsOf: c.liveAsOf ? c.liveAsOf.toISOString() : null,
            // displayAsOf is an instant for session-stamped prints (live/pre/
            // after/close) and a daily-bar date for a prior-close fallback —
            // serialize as a full ISO so the table renders the exact ET time.
            displayAsOf: c.displayAsOf ? c.displayAsOf.toISOString() : null,
          }))}
          style={goal.tradingStyle}
        />
      </section>

      {/* 4. How sizing works — the 1%-risk rule that drives each candidate's plan. */}
      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-400">
          How position sizing works (1% risk rule)
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-zinc-500">Trading capital</div>
            <div className="font-mono">{cadFmt(tradingCapital)}</div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Max loss / trade (1%)</div>
            <div className="font-mono text-amber-300">{cadFmt(riskPerTrade)}</div>
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-400">
          Every candidate&apos;s plan caps its loss at {cadFmt(riskPerTrade)} — 1% of your{' '}
          {cadFmt(tradingCapital)}. The share count is {cadFmt(riskPerTrade)} ÷ that name&apos;s
          ATR-based stop distance, so a tighter stop buys more shares and a wider stop forces fewer,
          for the same dollar risk. Expand any row in the scanner above to see its exact entry,
          stop, target, and share count.
        </p>
        <p className="mt-1 text-[11px] text-zinc-500">
          Trading capital = this goal&apos;s target amount. US names are priced in USD while your
          capital is CAD; share counts size USD risk against the CAD budget 1:1, so convert for an
          exact position.
        </p>
      </section>

      {/* 5. P&L-style current value (no glide path / progress-to-target). */}
      <section className="rounded-lg border border-white/[0.06] bg-zinc-950/40 p-4 sm:p-5">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Linked positions (current value)
          </div>
          <div className="font-mono text-sm text-zinc-300">
            {cadFmt(goal.progress.currentValueCad)}
          </div>
        </div>
        {goal.positions.length === 0 ? (
          <div className="text-sm text-zinc-500">
            No positions linked. Link your open day-trade positions to track their current value
            here.
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {goal.positions.map((p) => (
                <article
                  key={p.positionId}
                  className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3"
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-base font-medium">{p.ticker}</div>
                      <div className="mt-1 break-words text-xs text-zinc-400">{p.accountName}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm">{cadFmt(p.valueCad)}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">
                        Value (CAD)
                      </div>
                    </div>
                  </div>
                  <dl className="mt-3 border-t border-white/[0.05] pt-3 text-xs">
                    <div>
                      <dt className="uppercase tracking-wider text-zinc-500">Shares</dt>
                      <dd className="mt-1 font-mono">{p.shares}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2">Account</th>
                  <th className="pb-2 text-right">Shares</th>
                  <th className="pb-2 text-right">Value (CAD)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {goal.positions.map((p) => (
                  <tr key={p.positionId}>
                    <td className="py-2 font-mono">{p.ticker}</td>
                    <td className="py-2 text-xs text-zinc-400">{p.accountName}</td>
                    <td className="py-2 text-right font-mono text-xs">{p.shares}</td>
                    <td className="py-2 text-right font-mono text-xs">{cadFmt(p.valueCad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}
