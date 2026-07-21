'use client';

import * as React from 'react';
import { suggestGoalStrategy } from './actions';

type StrategyValue = '' | 'Income' | 'Growth' | 'Balanced' | 'Preservation';
type RiskValue = 'VeryLow' | 'Low' | 'Moderate' | 'High' | 'Aggressive' | null;

export interface GoalStrategyResult {
  strategy: StrategyValue;
  riskOverride: RiskValue;
  isWithdrawal: boolean;
}

// The 3-question "Help me decide" questionnaire, shared by NewGoalForm and
// EditGoalForm. Owns the textareas + the suggestGoalStrategy call + rationale
// display; hands the parsed result back via onResult so each form applies it to
// its own state.
export function GoalStrategyHelper({
  onResult,
  onClose,
}: {
  onResult: (r: GoalStrategyResult) => void;
  onClose: () => void;
}): React.ReactElement {
  const [q1, setQ1] = React.useState('');
  const [q2, setQ2] = React.useState('');
  const [q3, setQ3] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<{ strategy: StrategyValue; rationale: string } | null>(
    null,
  );

  return (
    <div className="mt-2 space-y-2 rounded border border-blue-500/30 bg-blue-500/5 p-3 text-sm">
      <div className="text-xs font-medium uppercase tracking-wider text-blue-300">
        Help me decide
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-zinc-400">
          1. What is the primary purpose — cash flow now, or growing wealth for later?
        </span>
        <textarea
          value={q1}
          onChange={(e) => setQ1(e.target.value)}
          rows={2}
          className="w-full rounded border border-white/[0.08] bg-black/40 px-2 py-1 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-zinc-400">
          2. How would you react if this dropped 30% temporarily?
        </span>
        <textarea
          value={q2}
          onChange={(e) => setQ2(e.target.value)}
          rows={2}
          className="w-full rounded border border-white/[0.08] bg-black/40 px-2 py-1 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-zinc-400">3. Is the target date hard or soft?</span>
        <textarea
          value={q3}
          onChange={(e) => setQ3(e.target.value)}
          rows={2}
          className="w-full rounded border border-white/[0.08] bg-black/40 px-2 py-1 text-sm"
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              const r = await suggestGoalStrategy({
                purpose: q1,
                volatility: q2,
                dateStrictness: q3,
              });
              onResult({
                strategy: r.strategy,
                riskOverride: r.riskOverride ?? null,
                isWithdrawal: r.isWithdrawal,
              });
              setResult({ strategy: r.strategy, rationale: r.rationale });
            } catch {
              setResult({
                strategy: 'Balanced',
                rationale: "Couldn't reach the helper. Defaulting to Balanced.",
              });
            } finally {
              setLoading(false);
            }
          }}
          className="rounded bg-blue-500/20 px-3 py-1 text-xs font-medium text-blue-300 hover:bg-blue-500/30 disabled:opacity-50"
        >
          {loading ? 'Asking…' : 'Suggest'}
        </button>
        <button
          type="button"
          onClick={() => {
            setResult(null);
            onClose();
          }}
          className="rounded border border-white/[0.08] px-3 py-1 text-xs text-zinc-300 hover:bg-white/[0.04]"
        >
          Cancel
        </button>
      </div>
      {result ? (
        <div className="text-xs text-zinc-300">
          <span className="font-mono text-emerald-300">{result.strategy}</span> — {result.rationale}
        </div>
      ) : null}
    </div>
  );
}
