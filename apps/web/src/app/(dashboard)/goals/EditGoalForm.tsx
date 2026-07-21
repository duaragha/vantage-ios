'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { updateGoal, type GoalInputForm } from './actions';
import { GoalStrategyHelper } from './GoalStrategyHelper';
import { isTorontoDateKeyInPast } from '@/lib/marketTime';

type GoalType = GoalInputForm['type'];
type StrategyValue = '' | 'Income' | 'Growth' | 'Balanced' | 'Preservation';
type TradingStyleValue = 'Momentum' | 'Breakout' | 'ORB' | 'MeanReversion' | 'Scalping';
type FrequencyValue = '' | 'Weekly' | 'Biweekly' | 'Monthly' | 'Quarterly';

const FREQUENCY_OPTIONS: Array<{ value: FrequencyValue; label: string }> = [
  { value: '', label: 'No contribution plan' },
  { value: 'Weekly', label: 'Weekly' },
  { value: 'Biweekly', label: 'Biweekly' },
  { value: 'Monthly', label: 'Monthly' },
  { value: 'Quarterly', label: 'Quarterly' },
];

const TYPE_OPTIONS: Array<{ value: GoalType; label: string }> = [
  { value: 'Withdrawal', label: 'Withdrawal' },
  { value: 'DownPayment', label: 'Down Payment' },
  { value: 'Vacation', label: 'Vacation' },
  { value: 'TaxBill', label: 'Tax Bill' },
  { value: 'EmergencyFund', label: 'Emergency Fund' },
  { value: 'Income', label: 'Income' },
  { value: 'Retirement', label: 'Retirement' },
  { value: 'Education', label: 'Education' },
  { value: 'Custom', label: 'Custom' },
  { value: 'DayTrading', label: 'Day Trading' },
];

const RISK_OPTIONS = ['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive'] as const;

const STRATEGY_OPTIONS: Array<{ value: StrategyValue; label: string; hint: string }> = [
  { value: '', label: 'Auto', hint: 'engine picks based on goal type' },
  { value: 'Income', label: 'Income', hint: 'chase dividends/interest' },
  { value: 'Growth', label: 'Growth', hint: 'chase price appreciation' },
  { value: 'Balanced', label: 'Balanced', hint: 'mix' },
  { value: 'Preservation', label: 'Preservation', hint: 'protect capital' },
];

const TRADING_STYLE_OPTIONS: Array<{ value: TradingStyleValue; label: string; hint: string }> = [
  { value: 'Momentum', label: 'Momentum', hint: 'high RVOL + catalyst + recent strength' },
  { value: 'Breakout', label: 'Breakout', hint: 'near range high, volume expansion' },
  { value: 'ORB', label: 'ORB', hint: 'opening-range breakout — needs intraday range' },
  { value: 'MeanReversion', label: 'Mean Reversion', hint: 'RSI extreme snap-back' },
  {
    value: 'Scalping',
    label: 'Scalping',
    hint: 'deepest liquidity — most scalpers lose long-term',
  },
];

function contributionValidationError(
  amount: number | '',
  frequency: FrequencyValue,
  isDayTrade: boolean,
): string | null {
  if (isDayTrade) return null;
  const hasAmount = amount !== '';
  const hasFrequency = frequency !== '';

  if (hasAmount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return 'Contribution amount must be a positive number.';
    }
    if (!hasFrequency) return 'Select a contribution frequency.';
  }

  if (!hasAmount && hasFrequency) {
    return 'Enter a contribution amount.';
  }

  return null;
}

function toInputDate(value: Date | null): string {
  if (!value) return '';
  return value.toISOString().slice(0, 10);
}

export interface EditGoalInitial {
  id: number;
  name: string;
  type: GoalType;
  targetAmountCad: number;
  targetDate: Date | null;
  isWithdrawal: boolean;
  notes: string | null;
  riskOverride: 'VeryLow' | 'Low' | 'Moderate' | 'High' | 'Aggressive' | null;
  strategy: 'Income' | 'Growth' | 'Balanced' | 'Preservation' | null;
  tradingStyle: TradingStyleValue | null;
  contributionAmountCad: number | null;
  contributionFrequency: 'Weekly' | 'Biweekly' | 'Monthly' | 'Quarterly' | null;
  contributionStartDate: Date | null;
  accountId: number | null;
}

export function EditGoalForm({
  initial,
  accounts,
  onCancel,
}: {
  initial: EditGoalInitial;
  accounts: Array<{ id: number; name: string; type: string }>;
  onCancel: () => void;
}): React.ReactElement {
  const router = useRouter();
  const [name, setName] = React.useState(initial.name);
  const [type, setType] = React.useState<GoalType>(initial.type);
  const [targetAmount, setTargetAmount] = React.useState<number>(initial.targetAmountCad);
  const [targetDate, setTargetDate] = React.useState<string>(toInputDate(initial.targetDate));
  const [openEnded, setOpenEnded] = React.useState(initial.targetDate === null);
  const [isWithdrawal, setIsWithdrawal] = React.useState(initial.isWithdrawal);
  const [notes, setNotes] = React.useState(initial.notes ?? '');
  const [accountId, setAccountId] = React.useState<number | ''>(
    initial.accountId === null ? '' : initial.accountId,
  );
  const [risk, setRisk] = React.useState<string>(initial.riskOverride ?? '');
  const [strategy, setStrategy] = React.useState<StrategyValue>(
    (initial.strategy ?? '') as StrategyValue,
  );
  const [tradingStyle, setTradingStyle] = React.useState<TradingStyleValue>(
    initial.tradingStyle ?? 'Momentum',
  );
  const [contributionAmount, setContributionAmount] = React.useState<number | ''>(
    initial.contributionAmountCad ?? '',
  );
  const [contributionFrequency, setContributionFrequency] = React.useState<FrequencyValue>(
    (initial.contributionFrequency ?? '') as FrequencyValue,
  );
  const [contributionStart, setContributionStart] = React.useState<string>(
    toInputDate(initial.contributionStartDate),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  // "Help me decide" questionnaire.
  const [helperOpen, setHelperOpen] = React.useState(false);

  const isDayTrade = type === 'DayTrading';
  const targetDateIsPast = React.useMemo(() => {
    if (isDayTrade || openEnded || !targetDate) return false;
    return isTorontoDateKeyInPast(targetDate);
  }, [isDayTrade, openEnded, targetDate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (targetDateIsPast) {
      setError('Target date cannot be in the past.');
      return;
    }
    const contributionError = contributionValidationError(
      contributionAmount,
      contributionFrequency,
      isDayTrade,
    );
    if (contributionError) {
      setError(contributionError);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await updateGoal(initial.id, {
      name: name.trim(),
      type,
      targetAmountCad: Number(targetAmount),
      // Target date is irrelevant for day trading (no glide horizon).
      targetDate: isDayTrade || openEnded ? null : targetDate || null,
      isWithdrawal: isDayTrade ? false : isWithdrawal,
      notes: notes || null,
      riskOverride: (risk || null) as GoalInputForm['riskOverride'],
      strategy: isDayTrade ? null : ((strategy || null) as GoalInputForm['strategy']),
      tradingStyle: isDayTrade ? tradingStyle : null,
      // Contribution plan — buy-and-hold only. Send the trio so updateGoal can
      // clear it when emptied (sending nulls explicitly).
      contributionAmountCad:
        isDayTrade || contributionAmount === '' ? null : Number(contributionAmount),
      contributionFrequency: isDayTrade
        ? null
        : ((contributionFrequency || null) as GoalInputForm['contributionFrequency']),
      contributionStartDate: isDayTrade ? null : contributionStart || null,
      accountId: typeof accountId === 'number' ? accountId : null,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCancel();
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-blue-500/30 bg-blue-500/[0.03] p-5"
    >
      <div className="text-xs font-medium uppercase tracking-wider text-blue-300">
        Editing — recs update live as you change inputs
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">Name</span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-mono"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as GoalType)}
            className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            {isDayTrade ? 'Trading Capital (CAD)' : 'Target Amount (CAD)'}
          </span>
          <input
            type="number"
            required
            min="0"
            step="100"
            value={targetAmount}
            onChange={(e) => setTargetAmount(Number(e.target.value))}
            className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-mono"
          />
        </label>
        {isDayTrade ? null : (
          <label className="space-y-1.5">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
              Target Date
            </span>
            <div className="flex items-center gap-2">
              <input
                type="date"
                disabled={openEnded}
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="flex-1 rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-mono disabled:opacity-50"
              />
              {targetDateIsPast ? (
                <span className="text-xs text-amber-300">Target is in the past.</span>
              ) : null}
              <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={openEnded}
                  onChange={(e) => setOpenEnded(e.target.checked)}
                />
                Open-ended
              </label>
            </div>
          </label>
        )}
        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Account
          </span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm"
          >
            <option value="">Engine picks</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.type})
              </option>
            ))}
          </select>
        </label>
        {isDayTrade ? (
          <div className="space-y-1.5 sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
              Trading style
            </span>
            <div className="flex flex-wrap gap-1.5">
              {TRADING_STYLE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setTradingStyle(o.value)}
                  className={
                    'rounded border px-2 py-1 text-xs ' +
                    (tradingStyle === o.value
                      ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
                      : 'border-white/[0.08] text-zinc-400 hover:bg-white/[0.04]')
                  }
                  title={o.hint}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="text-xs text-zinc-500">
              {TRADING_STYLE_OPTIONS.find((o) => o.value === tradingStyle)?.hint ?? ''}
            </span>
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Risk override
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setRisk('')}
                  className={
                    'rounded border px-2 py-1 text-xs ' +
                    (risk === ''
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                      : 'border-white/[0.08] text-zinc-400 hover:bg-white/[0.04]')
                  }
                >
                  Auto
                </button>
                {RISK_OPTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRisk(r)}
                    className={
                      'rounded border px-2 py-1 text-xs ' +
                      (risk === r
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                        : 'border-white/[0.08] text-zinc-400 hover:bg-white/[0.04]')
                    }
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Strategy
                </span>
                <button
                  type="button"
                  onClick={() => setHelperOpen((o) => !o)}
                  className="text-xs text-blue-300 hover:underline"
                >
                  {helperOpen ? 'Hide helper' : 'Not sure? Help me decide'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STRATEGY_OPTIONS.map((o) => (
                  <button
                    key={o.value || 'auto'}
                    type="button"
                    onClick={() => setStrategy(o.value)}
                    className={
                      'rounded border px-2 py-1 text-xs ' +
                      (strategy === o.value
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                        : 'border-white/[0.08] text-zinc-400 hover:bg-white/[0.04]')
                    }
                    title={o.hint}
                  >
                    {o.label}
                  </button>
                ))}
                <span className="self-center text-xs text-zinc-500">
                  {STRATEGY_OPTIONS.find((o) => o.value === strategy)?.hint ?? ''}
                </span>
              </div>
              {helperOpen ? (
                <GoalStrategyHelper
                  onResult={(r) => {
                    setStrategy(r.strategy);
                    if (r.riskOverride) setRisk(r.riskOverride);
                    setIsWithdrawal(r.isWithdrawal);
                  }}
                  onClose={() => setHelperOpen(false)}
                />
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-400 sm:col-span-2">
              <input
                type="checkbox"
                checked={isWithdrawal}
                onChange={(e) => setIsWithdrawal(e.target.checked)}
              />
              This goal is a withdrawal target.
            </label>
            <div className="space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Contribution plan (optional)
              </span>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input
                  type="number"
                  min="0"
                  step="50"
                  value={contributionAmount}
                  onChange={(e) =>
                    setContributionAmount(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  placeholder="Amount (CAD)"
                  className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-mono"
                />
                <select
                  value={contributionFrequency}
                  onChange={(e) => setContributionFrequency(e.target.value as FrequencyValue)}
                  className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm"
                >
                  {FREQUENCY_OPTIONS.map((o) => (
                    <option key={o.value || 'none'} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  value={contributionStart}
                  onChange={(e) => setContributionStart(e.target.value)}
                  title="First contribution date (defaults to today)"
                  className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-mono"
                />
              </div>
              <span className="text-xs text-zinc-500">
                Scheduled contributions project this goal forward. Clear the amount to remove the
                plan.
              </span>
            </div>
          </>
        )}
        <label className="space-y-1.5 sm:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm"
          />
        </label>
      </div>

      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-sm text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-white/[0.08] px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-emerald-500/20 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
