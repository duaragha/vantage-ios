/**
 * PositionForm — client form for create/update position + optional thesis.
 *
 * Invokes the `upsertPosition` server action. Accepts a `prefill` prop so the
 * Bought-flow URL can pre-populate ticker + shares + avg cost.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { upsertPosition } from '@/app/(dashboard)/portfolio/actions';
import { suggestAccountForTicker } from '@/app/(dashboard)/accounts/actions';
import type { AccountListItem } from '@/app/(dashboard)/accounts/data';
import { AccountPicker } from '@/components/AccountPicker';
import { cn } from '@/lib/utils';

export interface PositionFormPrefill {
  ticker?: string;
  name?: string;
  shares?: string;
  avgCost?: string;
  category?: string;
  sector?: string;
  notes?: string;
  stopLoss?: string;
  priceTarget?: string;
  currency?: string;
  thesisSummary?: string;
  pillars?: string[];
  riskFactors?: string[];
  fromInsightId?: number;
  accountId?: number;
}

export function PositionForm({
  prefill,
  mode = 'create',
  onDone,
  accounts,
}: {
  prefill?: PositionFormPrefill;
  mode?: 'create' | 'edit';
  onDone?: () => void;
  /**
   * Optional list of accounts for the Account picker. When omitted the picker
   * is hidden (used by older callers that haven't been wired up yet — they
   * fall back to whatever account the server action picks as default).
   */
  accounts?: AccountListItem[];
}): React.ReactElement {
  const router = useRouter();

  const [ticker, setTicker] = React.useState(prefill?.ticker ?? '');
  const [name, setName] = React.useState(prefill?.name ?? '');
  const [shares, setShares] = React.useState(prefill?.shares ?? '');
  const [avgCost, setAvgCost] = React.useState(prefill?.avgCost ?? '');
  const [category, setCategory] = React.useState(prefill?.category ?? 'Conviction');
  const [sector, setSector] = React.useState(prefill?.sector ?? '');
  const [notes, setNotes] = React.useState(prefill?.notes ?? '');
  const [stopLoss, setStopLoss] = React.useState(prefill?.stopLoss ?? '');
  const [priceTarget, setPriceTarget] = React.useState(prefill?.priceTarget ?? '');
  // Currency avgCost is entered in. Detected from the ticker lookup (VDY.TO →
  // CAD, AAPL → USD) but user-overridable via the toggle. `currencyTouched`
  // tracks a manual override so the auto-detect doesn't stomp the user's pick.
  const [currency, setCurrency] = React.useState<'CAD' | 'USD'>(
    prefill?.currency === 'CAD' ? 'CAD' : 'USD',
  );
  const currencyTouched = React.useRef(false);
  const [accountId, setAccountId] = React.useState<number | null>(prefill?.accountId ?? null);
  const [suggestion, setSuggestion] = React.useState<{
    accountId: number;
    rationale: string;
  } | null>(null);
  const [lookingUp, setLookingUp] = React.useState(false);
  const [lookupError, setLookupError] = React.useState<string | null>(null);
  // Tracks whether the current name/sector were auto-filled (true) vs typed by
  // the user (false). If the user typed 'A' (autofilled Agilent) then typed
  // 'AAPL', we want the next autofill to OVERWRITE Agilent with Apple — but
  // only because the name was auto-set, not a manual entry.
  const autoFilled = React.useRef({ name: false, sector: false });

  // Fetch Finnhub profile as soon as the user leaves the ticker field (or after
  // 500ms of idleness while typing). Pre-fills name + sector but leaves them
  // editable. Lookup failures remain non-blocking but are shown beside the
  // ticker so the user knows name/sector/currency need manual verification.
  const lookupTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUp = React.useRef<string>('');
  const ranInitialEditLookup = React.useRef(false);
  const runLookup = React.useCallback(
    async (raw: string, force: boolean = false) => {
      const symbol = raw.trim().toUpperCase();
      if (!symbol) return;
      if (!force && symbol === lastLookedUp.current) return;
      if (!/^[A-Z.-]{1,8}$/.test(symbol)) return;
      lastLookedUp.current = symbol;
      setLookingUp(true);
      setLookupError(null);
      try {
        const res = await fetch(`/api/tickers/lookup/${encodeURIComponent(symbol)}`, {
          cache: 'no-store',
        });
        if (res.status === 404) {
          setLookupError(`${symbol} not found`);
          return;
        }
        if (!res.ok) {
          setLookupError('lookup unavailable; verify manually');
          return;
        }
        const profile = (await res.json()) as {
          ticker?: string;
          name?: string;
          sector?: string | null;
          currency?: string | null;
        };
        // If the lookup resolved a different (suffixed) symbol — e.g. user
        // typed "VDY", resolver matched "VDY.TO" — correct the ticker field so
        // the saved position uses the real exchange-qualified symbol.
        if (profile.ticker && profile.ticker.toUpperCase() !== symbol.toUpperCase()) {
          lastLookedUp.current = profile.ticker.toUpperCase();
          setTicker(profile.ticker.toUpperCase());
        }
        // On force (manual refresh click), overwrite existing values.
        // On auto-lookup: overwrite when the current value is blank OR was set
        // by a previous auto-lookup (so AAPL replaces the stale "Agilent" from
        // when the user only had "A" typed).
        if (profile.name && (force || !name.trim() || autoFilled.current.name)) {
          setName(profile.name);
          autoFilled.current.name = true;
        }
        if (profile.sector && (force || !sector.trim() || autoFilled.current.sector)) {
          setSector(profile.sector);
          autoFilled.current.sector = true;
        }
        // Auto-detect the cost currency from the resolved listing. The lookup
        // resolver also corrects VDY → VDY.TO, so the resolved ticker suffix is
        // the truth source; fall back to the profile's currency field. Never
        // overrides a manual toggle (force from the refresh button does).
        if (force || !currencyTouched.current) {
          const resolvedTicker = (profile.ticker ?? symbol).toUpperCase();
          const detected: 'CAD' | 'USD' = /\.(TO|NE|V)$/.test(resolvedTicker)
            ? 'CAD'
            : profile.currency?.toUpperCase() === 'CAD'
              ? 'CAD'
              : 'USD';
          setCurrency(detected);
          if (force) currencyTouched.current = false;
        }
      } catch {
        setLookupError('lookup unavailable; verify manually');
      } finally {
        setLookingUp(false);
      }
    },
    [name, sector],
  );
  // On mount in edit mode: if name or sector is missing, auto-fire the lookup
  // so existing positions get retroactively populated without the user having
  // to retype anything.
  React.useEffect(() => {
    if (ranInitialEditLookup.current) return;
    if (mode !== 'edit') return;
    if (!ticker) return;
    if (name.trim() && sector.trim()) return;
    ranInitialEditLookup.current = true;
    void runLookup(ticker);
  }, [mode, name, runLookup, sector, ticker]);

  const onTickerChange = (raw: string) => {
    const upper = raw.toUpperCase();
    setTicker(upper);
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    // Debounce so we don't hammer Finnhub on every keystroke.
    lookupTimer.current = setTimeout(() => runLookup(upper), 500);
  };

  // Account-suggestion side channel: when the user settles on a ticker, ask the
  // server for the "natural home" account (e.g. US dividend → RRSP). The hint
  // is non-blocking — user can override or ignore.
  React.useEffect(() => {
    if (!accounts || accounts.length === 0) {
      setSuggestion(null);
      return;
    }
    const symbol = ticker.trim().toUpperCase();
    if (!symbol || !/^[A-Z.-]{1,8}$/.test(symbol)) {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const result = await suggestAccountForTicker(symbol);
        if (cancelled) return;
        if (result && result.accountId !== null) {
          setSuggestion({
            accountId: result.accountId,
            rationale: result.rationale,
          });
        } else {
          setSuggestion(null);
        }
      } catch {
        if (!cancelled) setSuggestion(null);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ticker, accounts]);
  const [thesisSummary, setThesisSummary] = React.useState(prefill?.thesisSummary ?? '');
  const [pillars, setPillars] = React.useState<string[]>(
    prefill?.pillars && prefill.pillars.length > 0 ? prefill.pillars : ['', ''],
  );
  const [risks, setRisks] = React.useState<string[]>(
    prefill?.riskFactors && prefill.riskFactors.length > 0 ? prefill.riskFactors : [''],
  );

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    // accountId is included whenever an Account picker is present; older
    // callers without `accounts` prop send no accountId and the server action
    // falls back to its default-account behavior. The cast keeps the new
    // field flowing through until the server-side action type is extended.
    const payload = {
      ticker,
      name: name || null,
      shares: Number(shares),
      avgCost: Number(avgCost),
      currency,
      category,
      sector: sector || null,
      notes: notes || null,
      stopLoss: stopLoss.trim() ? Number(stopLoss) : null,
      priceTarget: priceTarget.trim() ? Number(priceTarget) : null,
      thesisSummary: thesisSummary || undefined,
      thesisPillars: pillars,
      thesisRiskFactors: risks,
      ...(accountId !== null ? { accountId } : {}),
    } as Parameters<typeof upsertPosition>[0] & { accountId?: number };
    try {
      const result = await upsertPosition(payload);
      if (!result.ok) {
        setError(result.error ?? 'Position could not be saved.');
        return;
      }
      if (prefill?.fromInsightId) {
        // Mark the insight Bought so the feed updates.
        try {
          await fetch(`/api/insights/${prefill.fromInsightId}/bought`, {
            method: 'POST',
          });
        } catch {
          // Non-fatal — the position is already written.
        }
      }
      if (onDone) onDone();
      const destination = result.positionId
        ? `/positions/${result.ticker}?positionId=${result.positionId}`
        : `/positions/${result.ticker}`;
      router.push(destination);
      router.refresh();
    } catch {
      setError('Position could not be saved.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {accounts && accounts.length > 0 && (
        <AccountPicker
          accounts={accounts}
          value={accountId}
          onChange={setAccountId}
          hint={(() => {
            if (!suggestion || suggestion.accountId === accountId) return null;
            const suggested = accounts.find((a) => a.id === suggestion.accountId);
            if (!suggested) return null;
            return (
              <span className="flex flex-wrap items-center gap-1.5 text-[var(--cc-accent)]/90">
                <span className="font-semibold">
                  Suggested: {suggested.name} ({suggested.type})
                </span>
                <span className="text-muted-foreground/80">— {suggestion.rationale}</span>
                <button
                  type="button"
                  onClick={() => setAccountId(suggestion.accountId)}
                  className="rounded border border-[var(--cc-accent)]/30 px-1.5 py-0.5 font-mono uppercase tracking-[0.15em] text-[var(--cc-accent)] transition hover:bg-[var(--cc-accent)]/10"
                >
                  Use it
                </button>
              </span>
            );
          })()}
        />
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label={
            lookingUp ? 'Ticker · looking up…' : lookupError ? `Ticker · ${lookupError}` : 'Ticker'
          }
        >
          <div className="flex gap-2">
            <input
              value={ticker}
              onChange={(e) => onTickerChange(e.target.value)}
              onBlur={() => runLookup(ticker)}
              placeholder="AAPL"
              className="cc-input font-mono uppercase flex-1"
              required
            />
            <button
              type="button"
              onClick={() => void runLookup(ticker, true)}
              disabled={!ticker || lookingUp}
              title="Re-fetch name + sector from Finnhub (overwrites current values)"
              className="cc-input flex items-center justify-center px-3 text-muted-foreground transition hover:text-[var(--cc-accent)] disabled:opacity-40"
              style={{ width: '2.25rem' }}
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </button>
          </div>
        </Field>
        <Field label="Name (auto)">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              autoFilled.current.name = false;
            }}
            placeholder="Auto-fills from Finnhub"
            className="cc-input"
          />
        </Field>
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="cc-input"
          >
            <option>Conviction</option>
            <option>Speculative</option>
            <option>Meme</option>
            <option>Income</option>
            <option>Other</option>
          </select>
        </Field>
        <Field label="Shares">
          <input
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            type="number"
            step="0.0001"
            inputMode="decimal"
            className="cc-input font-mono tabular-nums"
            required
          />
        </Field>
        <Field label={`Average cost (${currency})`}>
          <div className="flex gap-2">
            <input
              value={avgCost}
              onChange={(e) => setAvgCost(e.target.value)}
              type="number"
              step="0.01"
              inputMode="decimal"
              className="cc-input font-mono tabular-nums flex-1"
              required
            />
            <div className="flex shrink-0 gap-1">
              {(['CAD', 'USD'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    currencyTouched.current = true;
                    setCurrency(c);
                  }}
                  className={cn(
                    'rounded-md border px-2 font-mono text-[10px] uppercase tracking-[0.15em] transition',
                    currency === c
                      ? 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                      : 'border-white/[0.08] text-muted-foreground hover:border-white/[0.2] hover:text-foreground',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        </Field>
        <Field label="Sector (optional)">
          <input
            value={sector}
            onChange={(e) => {
              setSector(e.target.value);
              autoFilled.current.sector = false;
            }}
            placeholder="Technology"
            className="cc-input"
          />
        </Field>
        <Field label={`Stop loss (${currency}, optional)`}>
          <input
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className="cc-input font-mono tabular-nums"
          />
        </Field>
        <Field label={`Price target (${currency}, optional)`}>
          <input
            value={priceTarget}
            onChange={(e) => setPriceTarget(e.target.value)}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className="cc-input font-mono tabular-nums"
          />
        </Field>
        <Field label="Notes (optional)">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className="cc-input" />
        </Field>
      </div>

      <div className="border-t border-white/[0.06] pt-5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Thesis (optional)
        </div>
        <Field label="Summary">
          <textarea
            value={thesisSummary}
            onChange={(e) => setThesisSummary(e.target.value)}
            rows={2}
            className="cc-input font-sans"
            placeholder="One sentence: why do you own this?"
          />
        </Field>

        <DynamicList
          label="Pillars (2-4)"
          hint="Each one is a statement that must remain true."
          items={pillars}
          setItems={setPillars}
          max={4}
          min={1}
        />

        <DynamicList
          label="Risk factors (1-3)"
          hint="Things that would break the thesis."
          items={risks}
          setItems={setRisks}
          max={3}
          min={1}
        />
      </div>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="relative overflow-hidden rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 text-sm font-medium text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add position'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function DynamicList({
  label,
  hint,
  items,
  setItems,
  max,
  min,
}: {
  label: string;
  hint?: string;
  items: string[];
  setItems: (next: string[]) => void;
  max: number;
  min: number;
}): React.ReactElement {
  const set = (i: number, val: string) => {
    const next = [...items];
    next[i] = val;
    setItems(next);
  };
  const add = () => {
    if (items.length >= max) return;
    setItems([...items, '']);
  };
  const remove = (i: number) => {
    if (items.length <= min) return;
    setItems(items.filter((_, idx) => idx !== i));
  };
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {label}
        </span>
        {hint && <span className="font-mono text-[10px] text-muted-foreground/60">{hint}</span>}
      </div>
      {items.map((item, i) => (
        <div key={i} className="flex gap-2">
          <textarea
            value={item}
            onChange={(e) => set(i, e.target.value)}
            rows={2}
            className="cc-input font-sans"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={items.length <= min}
            className="h-9 rounded-md border border-white/[0.08] px-3 text-xs text-muted-foreground transition hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-30"
          >
            ✕
          </button>
        </div>
      ))}
      {items.length < max && (
        <button
          type="button"
          onClick={add}
          className="self-start font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:text-[var(--cc-accent)]"
        >
          + add another
        </button>
      )}
    </div>
  );
}
