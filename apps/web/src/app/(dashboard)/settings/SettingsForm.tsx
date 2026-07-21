/**
 * SettingsForm — edit UserSettings, toggle kill switch, change password.
 */

'use client';

import * as React from 'react';
import {
  changePassword,
  recomputeDiscoveryNow,
  saveSettings,
  type DiscoveryWeightsForm,
  type ExchangeCode,
  type SettingsFormPayload,
} from './actions';
import { cn } from '@/lib/utils';

// Grouped for UX. Percentages in headers are advisory — the user can rebalance.
const DISCOVERY_GROUPS: ReadonlyArray<{
  title: string;
  keys: ReadonlyArray<keyof DiscoveryWeightsForm>;
}> = [
  {
    title: 'Fundamentals (~55%)',
    keys: ['epsGrowth', 'revenueGrowth', 'margins', 'valuation', 'profitability', 'balanceSheet'],
  },
  {
    title: 'Quality (~10%)',
    keys: ['liquidity', 'size'],
  },
  {
    title: 'Attention & Momentum (~35%)',
    keys: ['news', 'earnings', 'insider', 'filings', 'momentum', 'sentiment'],
  },
];

const DISCOVERY_KEYS: ReadonlyArray<keyof DiscoveryWeightsForm> = DISCOVERY_GROUPS.flatMap(
  (g) => g.keys,
);

const EXCHANGE_OPTIONS: Array<{
  code: ExchangeCode;
  label: string;
  note: string;
}> = [
  { code: 'US', label: 'US', note: 'NYSE / NASDAQ — USD' },
  { code: 'TO', label: 'TSX', note: 'Toronto · CAD' },
  { code: 'NE', label: 'NEO', note: 'Cboe Canada · CAD · wider spreads' },
  { code: 'V', label: 'TSX-V', note: 'Venture · CAD · thin liquidity' },
];

export function SettingsForm({ initial }: { initial: SettingsFormPayload }): React.ReactElement {
  const [v, setV] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const on = <K extends keyof SettingsFormPayload>(key: K, val: SettingsFormPayload[K]) =>
    setV({ ...v, [key]: val });

  const weightSum = DISCOVERY_KEYS.reduce((acc, k) => acc + (v.discoveryWeights[k] ?? 0), 0);
  const weightSumOff = Math.abs(weightSum - 1) > 0.01;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (weightSumOff) {
      setMsg({
        tone: 'err',
        text: `Discovery weights must sum to 1.00 (currently ${weightSum.toFixed(2)}).`,
      });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await saveSettings(v);
      setMsg(
        res.ok
          ? { tone: 'ok', text: 'Saved.' }
          : { tone: 'err', text: res.error ?? 'Settings could not be saved.' },
      );
    } catch {
      setMsg({ tone: 'err', text: 'Settings could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  const toggleKill = async () => {
    if (
      !v.killSwitch &&
      !window.confirm('Enable kill switch? Non-user LLM calls will stop until you flip it off.')
    ) {
      return;
    }
    const previous = v.killSwitch;
    const next = !previous;
    setV((current) => ({ ...current, killSwitch: next }));
    setSaving(true);
    setMsg(null);
    try {
      const res = await saveSettings({ ...v, killSwitch: next });
      if (!res.ok) {
        setV((current) => ({ ...current, killSwitch: previous }));
      }
      setMsg(
        res.ok
          ? { tone: 'ok', text: next ? 'Kill switch ON.' : 'Kill switch OFF.' }
          : { tone: 'err', text: res.error ?? 'Kill switch could not be changed.' },
      );
    } catch {
      setV((current) => ({ ...current, killSwitch: previous }));
      setMsg({ tone: 'err', text: 'Kill switch could not be changed.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Section title="Budget & caps">
        <Grid>
          <Num
            label="Monthly budget (USD)"
            value={v.monthlyBudget}
            onChange={(n) => on('monthlyBudget', n)}
          />
          <Num
            label="Single position cap %"
            value={v.singlePositionCapPct}
            onChange={(n) => on('singlePositionCapPct', n)}
          />
          <Num
            label="Sector cap %"
            value={v.sectorCapPct}
            onChange={(n) => on('sectorCapPct', n)}
          />
          <Num
            label="Intraday move threshold %"
            value={v.intradayMoveThresholdPct}
            onChange={(n) => on('intradayMoveThresholdPct', n)}
          />
        </Grid>
      </Section>

      <Section title="Alerting">
        <Grid>
          <Num
            label="Pass cooldown (days)"
            value={v.passCooldownDays}
            onChange={(n) => on('passCooldownDays', n)}
          />
          <Num
            label="Per-ticker daily alert cap"
            value={v.perTickerDailyAlertCap}
            onChange={(n) => on('perTickerDailyAlertCap', n)}
          />
          <Text
            label="Timezone"
            value={v.timezone}
            onChange={(s) => on('timezone', s)}
            placeholder="America/Toronto"
          />
        </Grid>
      </Section>

      <DiscoverySection
        weights={v.discoveryWeights}
        minMcap={v.discoveryMinMcapUsd}
        onWeightChange={(key, val) => on('discoveryWeights', { ...v.discoveryWeights, [key]: val })}
        onMinMcapChange={(n) => on('discoveryMinMcapUsd', n)}
      />

      <ExchangesSection
        selected={v.exchangesEnabled}
        onChange={(next) => on('exchangesEnabled', next)}
      />

      <CatalystSection
        enabled={v.catalystEnabled}
        maxPerDay={v.catalystMaxPerDay}
        requireConjunction={v.catalystRequireConjunction}
        spendCap={v.catalystDailySpendCapUsd}
        onChange={(next) =>
          setV({
            ...v,
            catalystEnabled: next.enabled,
            catalystMaxPerDay: next.maxPerDay,
            catalystRequireConjunction: next.requireConjunction,
            catalystDailySpendCapUsd: next.spendCap,
          })
        }
      />

      <Section title="LLM spend caps">
        <Grid>
          <Num
            label="Daily cap (USD)"
            value={v.dailySpendCapUsd}
            onChange={(n) => on('dailySpendCapUsd', n)}
          />
          <Num
            label="Monthly cap (USD)"
            value={v.monthlySpendCapUsd}
            onChange={(n) => on('monthlySpendCapUsd', n)}
          />
        </Grid>
      </Section>

      <Section title="Kill switch">
        <div className="flex items-center justify-between rounded-md border border-white/[0.06] bg-white/[0.02] px-4 py-3">
          <div>
            <div className="text-sm font-medium">
              {v.killSwitch ? 'ON — LLM paused' : 'OFF — LLM running'}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              Flipping this pauses every non-user-initiated LLM call.
            </div>
          </div>
          <button
            type="button"
            onClick={toggleKill}
            disabled={saving}
            className={cn(
              'rounded-md border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition',
              v.killSwitch
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20',
            )}
          >
            {v.killSwitch ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </Section>

      {msg && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 font-mono text-xs',
            msg.tone === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300',
          )}
        >
          {msg.text}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {weightSumOff && (
          <span className="font-mono text-[10px] text-rose-300">
            Weights sum {weightSum.toFixed(2)} ≠ 1.00
          </span>
        )}
        <button
          type="submit"
          disabled={saving || weightSumOff}
          className="rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <ChangePasswordSection />
    </form>
  );
}

function ChangePasswordSection(): React.ReactElement {
  const [oldPassword, setOld] = React.useState('');
  const [newPassword, setNew] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await changePassword(oldPassword, newPassword);
      if (res.ok) {
        setOld('');
        setNew('');
        setMsg({ tone: 'ok', text: 'Password changed.' });
      } else {
        setMsg({ tone: 'err', text: res.error ?? 'Password could not be changed.' });
      }
    } catch {
      setMsg({ tone: 'err', text: 'Password could not be changed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-6">
      <Section title="Change password">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Password label="Current password" value={oldPassword} onChange={setOld} />
          <Password label="New password (min 8)" value={newPassword} onChange={setNew} />
        </div>
        {msg && (
          <div
            className={cn(
              'mt-3 rounded-md border px-3 py-2 font-mono text-xs',
              msg.tone === 'ok'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-300',
            )}
          >
            {msg.text}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-md border border-white/[0.1] bg-white/[0.03] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground transition hover:bg-white/[0.08] disabled:opacity-40"
          >
            {busy ? 'Hashing…' : 'Update password'}
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>;
}

function baseInputCls(): string {
  return 'h-9 w-full rounded-md border border-white/[0.08] bg-black/30 px-3 text-sm outline-none transition focus:border-[var(--cc-accent)]/60 focus:ring-2 focus:ring-[var(--cc-accent)]/25';
}

function Num({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(baseInputCls(), 'font-mono tabular-nums')}
      />
    </label>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={baseInputCls()}
      />
    </label>
  );
}

function DiscoverySection({
  weights,
  minMcap,
  onWeightChange,
  onMinMcapChange,
}: {
  weights: DiscoveryWeightsForm;
  minMcap: number;
  onWeightChange: (key: keyof DiscoveryWeightsForm, value: number) => void;
  onMinMcapChange: (value: number) => void;
}): React.ReactElement {
  const [recomputing, setRecomputing] = React.useState(false);
  const [recomputeMsg, setRecomputeMsg] = React.useState<{
    tone: 'ok' | 'err';
    text: string;
  } | null>(null);

  const sum = DISCOVERY_KEYS.reduce((acc, k) => acc + (weights[k] ?? 0), 0);
  const sumLabel = sum.toFixed(2);
  const sumOff = Math.abs(sum - 1) > 0.01;

  const recompute = async () => {
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      const res = await recomputeDiscoveryNow();
      setRecomputeMsg(
        res.ok
          ? { tone: 'ok', text: 'Discovery recompute queued.' }
          : { tone: 'err', text: res.error ?? 'Discovery recompute unavailable.' },
      );
    } catch {
      setRecomputeMsg({ tone: 'err', text: 'Discovery recompute unavailable.' });
    } finally {
      setRecomputing(false);
    }
  };

  return (
    <Section title="Discovery signal weights">
      <p className="font-mono text-[10px] text-muted-foreground/70">
        Weights are renormalized to sum to 1 at save time. Total must equal 1.00 (±0.01) before
        saving. Live sum:{' '}
        <span className={cn('tabular-nums', sumOff ? 'text-rose-300' : 'text-foreground/80')}>
          {sumLabel}
        </span>
        {sumOff && <span className="ml-1 text-rose-300">(must equal 1.00)</span>}
      </p>
      {DISCOVERY_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-foreground/60">
            {group.title}
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {group.keys.map((key) => (
              <WeightSlider
                key={key}
                label={key}
                value={weights[key] ?? 0}
                onChange={(v) => onWeightChange(key, v)}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Num label="Min market cap (USD)" value={minMcap} onChange={onMinMcapChange} />
        <div className="flex flex-col justify-end">
          <button
            type="button"
            onClick={recompute}
            disabled={recomputing}
            className="h-9 rounded-md border border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 px-3 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:bg-[var(--cc-accent)]/20 disabled:opacity-40"
          >
            {recomputing ? 'Queuing…' : 'Recompute now'}
          </button>
        </div>
      </div>
      {recomputeMsg && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 font-mono text-xs',
            recomputeMsg.tone === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300',
          )}
        >
          {recomputeMsg.text}
        </div>
      )}
    </Section>
  );
}

function WeightSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-foreground/70">
          {clamped.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={clamped}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--cc-accent)]"
      />
    </label>
  );
}

function ExchangesSection({
  selected,
  onChange,
}: {
  selected: ExchangeCode[];
  onChange: (next: ExchangeCode[]) => void;
}): React.ReactElement {
  const toggle = (code: ExchangeCode): void => {
    const has = selected.includes(code);
    const next = has ? selected.filter((c) => c !== code) : [...selected, code];
    // Keep canonical order so saved arrays are deterministic.
    const order: ExchangeCode[] = ['US', 'TO', 'NE', 'V'];
    onChange(order.filter((c) => next.includes(c)));
  };
  return (
    <Section title="Exchanges enabled">
      <p className="font-mono text-[10px] text-muted-foreground/70">
        Which exchanges the weekly universe refresh seeds. US + TSX (TO) cover most of a Canadian
        Wealthsimple portfolio. NEO / TSX-V are optional — liquidity on Wealthsimple is thin for
        those.
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {EXCHANGE_OPTIONS.map(({ code, label, note }) => {
          const active = selected.includes(code);
          return (
            <label
              key={code}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 transition',
                active
                  ? 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10'
                  : 'border-white/[0.08] bg-black/20 hover:border-white/[0.18]',
              )}
            >
              <div className="flex flex-col">
                <span
                  className={cn(
                    'font-mono text-xs uppercase tracking-[0.2em]',
                    active ? 'text-[var(--cc-accent)]' : 'text-foreground/80',
                  )}
                >
                  {label}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/70">{note}</span>
              </div>
              <input
                type="checkbox"
                checked={active}
                onChange={() => toggle(code)}
                className="h-4 w-4 accent-[var(--cc-accent)]"
              />
            </label>
          );
        })}
      </div>
      {selected.length === 0 && (
        <p className="font-mono text-[10px] text-rose-300">
          At least one exchange must be enabled.
        </p>
      )}
    </Section>
  );
}

function Password({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        className={baseInputCls()}
      />
    </label>
  );
}

interface CatalystSectionProps {
  enabled: boolean;
  maxPerDay: number;
  requireConjunction: boolean;
  spendCap: number;
  onChange: (next: {
    enabled: boolean;
    maxPerDay: number;
    requireConjunction: boolean;
    spendCap: number;
  }) => void;
}

function CatalystSection(props: CatalystSectionProps): React.ReactElement {
  const { enabled, maxPerDay, requireConjunction, spendCap, onChange } = props;
  return (
    <Section title="Catalyst engine">
      <p className="font-mono text-[10px] text-muted-foreground/70">
        The catalyst engine watches insider clusters, earnings beats, material 8-Ks, and analyst
        upgrades during market hours. Surviving candidates clear quality + cap + cooldown gates and
        become 48h-window buy suggestions on /insights.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ToggleRow
          label="Enable catalyst-driven buy suggestions"
          checked={enabled}
          onChange={(v) =>
            onChange({
              enabled: v,
              maxPerDay,
              requireConjunction,
              spendCap,
            })
          }
        />
        <ToggleRow
          label="Require multi-signal conjunction"
          hint="When ON, single-signal catalysts are suppressed. Safer."
          checked={requireConjunction}
          onChange={(v) =>
            onChange({
              enabled,
              maxPerDay,
              requireConjunction: v,
              spendCap,
            })
          }
        />
        <BoundedNum
          label="Max catalyst buys per day"
          min={1}
          max={5}
          step={1}
          value={maxPerDay}
          onChange={(n) =>
            onChange({
              enabled,
              maxPerDay: Math.round(n),
              requireConjunction,
              spendCap,
            })
          }
        />
        <BoundedNum
          label="Daily catalyst spend cap (USD)"
          min={0.1}
          max={5}
          step={0.1}
          value={spendCap}
          onChange={(n) =>
            onChange({
              enabled,
              maxPerDay,
              requireConjunction,
              spendCap: n,
            })
          }
        />
      </div>
    </Section>
  );
}

function ToggleRow({
  label,
  checked,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start justify-between gap-3 rounded-md border px-3 py-2 transition',
        checked
          ? 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10'
          : 'border-white/[0.08] bg-black/20 hover:border-white/[0.18]',
      )}
    >
      <div className="flex flex-col">
        <span
          className={cn(
            'font-mono text-[10px] uppercase tracking-[0.2em]',
            checked ? 'text-[var(--cc-accent)]' : 'text-foreground/80',
          )}
        >
          {label}
        </span>
        {hint && <span className="font-mono text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--cc-accent)]"
      />
    </label>
  );
}

function BoundedNum({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}): React.ReactElement {
  const clamp = (n: number): number => {
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  };
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </span>
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className={cn(baseInputCls(), 'font-mono tabular-nums')}
      />
      <span className="font-mono text-[10px] text-muted-foreground/60">
        Range {min} – {max}
      </span>
    </label>
  );
}
