'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  createGoal,
  suggestForGoal,
  type GoalInputForm,
  type SuggestForGoalResult,
} from './actions';
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

const SHORT_LIQUIDATION: GoalType[] = ['Withdrawal', 'DownPayment', 'Vacation', 'TaxBill'];

export function NewGoalForm({
  accounts,
  onCancel,
}: {
  accounts: Array<{ id: number; name: string; type: string }>;
  onCancel: () => void;
}): React.ReactElement {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<GoalType>('Withdrawal');
  const [targetAmount, setTargetAmount] = React.useState<number>(10000);
  const [targetDate, setTargetDate] = React.useState<string>('');
  const [openEnded, setOpenEnded] = React.useState(false);
  const [isWithdrawal, setIsWithdrawal] = React.useState(true);
  const [notes, setNotes] = React.useState('');
  const [accountId, setAccountId] = React.useState<number | ''>('');
  const [risk, setRisk] = React.useState<string>('');
  const [strategy, setStrategy] = React.useState<StrategyValue>('');
  const [tradingStyle, setTradingStyle] = React.useState<TradingStyleValue>('Momentum');
  const [contributionAmount, setContributionAmount] = React.useState<number | ''>('');
  const [contributionFrequency, setContributionFrequency] = React.useState<FrequencyValue>('');
  const [contributionStart, setContributionStart] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<SuggestForGoalResult | null>(null);
  // "Help me decide" questionnaire — collapsed by default, expanded inline when
  // the user clicks the helper button.
  const [helperOpen, setHelperOpen] = React.useState(false);
  const suggestionSeqRef = React.useRef(0);

  const isDayTrade = type === 'DayTrading';
  const targetDateIsPast = React.useMemo(() => {
    if (isDayTrade || openEnded || !targetDate) return false;
    return isTorontoDateKeyInPast(targetDate);
  }, [isDayTrade, openEnded, targetDate]);

  // Auto-toggle isWithdrawal based on type. Day trading is never a withdrawal target.
  React.useEffect(() => {
    if (type === 'DayTrading') {
      setIsWithdrawal(false);
      return;
    }
    setIsWithdrawal(SHORT_LIQUIDATION.includes(type) || type === 'EmergencyFund');
  }, [type]);

  // Debounced suggestion fetch.
  React.useEffect(() => {
    if (!name.trim() || !targetAmount) {
      setSuggestion(null);
      return;
    }
    const seq = ++suggestionSeqRef.current;
    let active = true;
    const t = setTimeout(async () => {
      try {
        const result = await suggestForGoal({
          name: name.trim(),
          type,
          targetAmountCad: Number(targetAmount),
          targetDate: isDayTrade || openEnded ? null : targetDate || null,
          isWithdrawal: isDayTrade ? false : isWithdrawal,
          notes: notes || null,
          riskOverride: (risk || null) as GoalInputForm['riskOverride'],
          strategy: isDayTrade ? null : ((strategy || null) as GoalInputForm['strategy']),
          tradingStyle: isDayTrade ? tradingStyle : null,
          accountId: typeof accountId === 'number' ? accountId : null,
        });
        if (!active || seq !== suggestionSeqRef.current) return;
        setSuggestion(result);
      } catch {
        if (!active || seq !== suggestionSeqRef.current) return;
        setSuggestion(null);
      }
    }, 500);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [
    name,
    type,
    targetAmount,
    targetDate,
    openEnded,
    isWithdrawal,
    notes,
    accountId,
    risk,
    strategy,
    tradingStyle,
    isDayTrade,
  ]);

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
    const result = await createGoal({
      name: name.trim(),
      type,
      targetAmountCad: Number(targetAmount),
      targetDate: isDayTrade || openEnded ? null : targetDate || null,
      isWithdrawal: isDayTrade ? false : isWithdrawal,
      notes: notes || null,
      riskOverride: (risk || null) as GoalInputForm['riskOverride'],
      strategy: isDayTrade ? null : ((strategy || null) as GoalInputForm['strategy']),
      tradingStyle: isDayTrade ? tradingStyle : null,
      // Contribution plan is a buy-and-hold-only funding method.
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
    router.refresh();
    router.push('/goals/' + result.id);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-white/[0.06] bg-zinc-950/60 p-5"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">Name</span>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm font-mono"
            placeholder="Down payment 2027"
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
            <p className="mt-1 text-xs text-rose-300/80">
              Day trading has a 1-4% long-term success rate. Trade only in a non-registered
              (Personal/Margin) account — frequent trading in a TFSA risks CRA business-income
              reclassification (RRSP withdrawals are taxed and burn contribution room).
            </p>
          </div>
        ) : (
          <>
            <label className="space-y-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                Risk
              </span>
              <select
                value={risk}
                onChange={(e) => setRisk(e.target.value)}
                className="w-full rounded border border-white/[0.08] bg-black/40 px-3 py-2 text-sm"
              >
                <option value="">Auto</option>
                <option value="VeryLow">Very Low</option>
                <option value="Low">Low</option>
                <option value="Moderate">Moderate</option>
                <option value="High">High</option>
                <option value="Aggressive">Aggressive</option>
              </select>
            </label>
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
              This goal is a withdrawal target (engine treats it as liquidate-toward).
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
                Scheduled contributions let us project this goal forward. Set an amount and a
                frequency together to enable it.
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

      {suggestion && suggestion.account.rankedTypes.length > 0 ? (
        <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
          <div className="mb-1 text-xs font-medium uppercase tracking-wider text-blue-300">
            Engine preview
          </div>
          <div className="text-zinc-300">
            <span className="font-mono">
              {suggestion.account.bestAccountName ?? suggestion.account.rankedTypes[0]}
            </span>{' '}
            — {suggestion.account.rationale}
          </div>
          {suggestion.account.warning ? (
            <div className="mt-1 text-amber-300">⚠ {suggestion.account.warning}</div>
          ) : null}
          {suggestion.securities.length > 0 ? (
            <div className="mt-2 text-zinc-400">
              Top picks:{' '}
              {suggestion.securities
                .slice(0, 3)
                .map((s) => s.ticker)
                .join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}

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
          {submitting ? 'Creating…' : 'Create Goal'}
        </button>
      </div>
    </form>
  );
}
