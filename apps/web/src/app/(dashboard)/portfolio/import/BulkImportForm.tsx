/**
 * BulkImportForm — CSV paste → parse → preview → confirm.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { AccountPicker } from '@/components/AccountPicker';
import type { AccountListItem } from '@/app/(dashboard)/accounts/data';
import { bulkImportPositions, type BulkRow } from './actions';

type Validity = 'ok' | 'warn' | 'bad';

interface PreviewRow {
  raw: string;
  ticker: string;
  shares: number;
  avgCost: number;
  category: string;
  validity: Validity;
  note?: string;
}

const ALLOWED_CATEGORIES = ['Conviction', 'Speculative', 'Meme', 'Income', 'Other'];

function parseCsv(text: string): PreviewRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows: PreviewRow[] = [];
  for (const line of lines) {
    // Skip header
    if (/^ticker\b/i.test(line)) continue;
    const parts = line.split(',').map((s) => s.trim());
    const [tickerRaw, sharesRaw, avgCostRaw, categoryRaw] = parts;
    const ticker = (tickerRaw ?? '').toUpperCase();
    const shares = Number(sharesRaw);
    const avgCost = Number(avgCostRaw);
    let category = categoryRaw || 'Other';
    // Title-case match against allowed
    const found = ALLOWED_CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
    category = found ?? 'Other';

    let validity: Validity = 'ok';
    let note: string | undefined;
    if (!/^[A-Z.-]{1,8}$/.test(ticker)) {
      validity = 'bad';
      note = 'invalid ticker';
    } else if (!Number.isFinite(shares) || shares <= 0) {
      validity = 'bad';
      note = 'shares must be > 0';
    } else if (!Number.isFinite(avgCost) || avgCost < 0) {
      validity = 'bad';
      note = 'avg cost must be ≥ 0';
    } else if (!found) {
      validity = 'warn';
      note = `category defaulted to Other (got "${categoryRaw}")`;
    }

    rows.push({
      raw: line,
      ticker,
      shares,
      avgCost,
      category,
      validity,
      ...(note ? { note } : {}),
    });
  }
  return rows;
}

export function BulkImportForm({
  existingTickers,
  accounts,
}: {
  existingTickers: string[];
  accounts: AccountListItem[];
}): React.ReactElement {
  const router = useRouter();
  const [text, setText] = React.useState('');
  const [preview, setPreview] = React.useState<PreviewRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [accountId, setAccountId] = React.useState<number | null>(null);
  // Default cost currency for rows whose ticker carries no CA suffix. Seeded
  // from the chosen account's currency; .TO/.NE/.V rows always import as CAD
  // regardless of this selector (handled server-side).
  const [importCurrency, setImportCurrency] = React.useState<'CAD' | 'USD'>('CAD');
  const [result, setResult] = React.useState<{
    created: string[];
    updated: string[];
    skipped: string[];
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const onPreview = () => {
    setResult(null);
    setError(null);
    setPreview(parseCsv(text));
  };

  // When the user picks an account, default the cost currency to match it.
  React.useEffect(() => {
    if (accountId === null) return;
    const acct = accounts.find((a) => a.id === accountId);
    if (acct) setImportCurrency(acct.currency);
  }, [accountId, accounts]);

  const pasteTickers = React.useMemo(() => new Set(preview.map((p) => p.ticker)), [preview]);
  const missingFromPaste = existingTickers.filter((t) => !pasteTickers.has(t));

  const validRows: BulkRow[] = preview
    .filter((p) => p.validity !== 'bad')
    .map((p) => ({
      ticker: p.ticker,
      shares: p.shares,
      avgCost: p.avgCost,
      category: p.category,
    }));

  const onConfirm = async () => {
    if (validRows.length === 0) return;
    if (accounts.length > 0 && accountId === null) {
      setError('Pick an account before importing.');
      return;
    }
    setSubmitting(true);
    setError(null);
    // The action's argument type doesn't yet declare accountId, but the
    // server reads it for per-account routing once Agent C extends the type.
    const payload = (
      accountId !== null ? validRows.map((r) => ({ ...r, accountId })) : validRows
    ) as Parameters<typeof bulkImportPositions>[0];
    const res = await bulkImportPositions(payload, accountId ?? undefined, importCurrency);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? 'unexpected error');
      return;
    }
    setResult({ created: res.created, updated: res.updated, skipped: res.skipped });
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="[&_button]:min-h-11 [&_input]:min-h-11 [&_select]:min-h-11">
        <AccountPicker
          accounts={accounts}
          value={accountId}
          onChange={setAccountId}
          label="Import into"
          hint="Every row in the paste will be created under this account."
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Cost currency
        </label>
        <div className="flex gap-2">
          {(['CAD', 'USD'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setImportCurrency(c)}
              className={cn(
                'min-h-11 min-w-16 rounded-md border px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] transition',
                importCurrency === c
                  ? 'border-[var(--cc-accent)]/40 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]'
                  : 'border-white/[0.08] text-muted-foreground hover:border-white/[0.2] hover:text-foreground',
              )}
            >
              {c}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground/60">
          Applies to rows with no exchange suffix. .TO / .NE / .V tickers always import as CAD.
        </span>
      </div>
      <div>
        <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Paste CSV
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="mt-2 w-full rounded-md border border-white/[0.08] bg-black/30 px-3 py-3 font-mono text-base text-foreground outline-none focus:border-[var(--cc-accent)]/60 focus:ring-2 focus:ring-[var(--cc-accent)]/25 sm:text-xs"
          placeholder={`ticker,shares,avg_cost,category\nAAPL,10,170.50,Conviction\nNVDA,4,820,Speculative`}
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="font-mono text-[10px] text-muted-foreground/60">
            {text.trim() ? `${text.trim().split(/\r?\n/).length} lines` : 'empty'}
          </div>
          <button
            type="button"
            onClick={onPreview}
            className="min-h-11 rounded-md border border-white/[0.08] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground transition hover:border-white/[0.2] hover:text-foreground"
          >
            Preview
          </button>
        </div>
      </div>

      {preview.length > 0 && (
        <div>
          <div className="space-y-3 md:hidden">
            {preview.map((row, i) => (
              <article
                key={i}
                className="rounded-md border border-white/[0.06] bg-white/[0.02] p-4"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-base font-semibold break-words">
                      {row.ticker}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{row.category}</div>
                  </div>
                  <div className="shrink-0">
                    <ValidityBadge v={row.validity} note={row.note} />
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Shares
                    </dt>
                    <dd className="mt-1 font-mono tabular-nums">{row.shares}</dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      Average cost
                    </dt>
                    <dd className="mt-1 font-mono tabular-nums">${row.avgCost.toFixed(2)}</dd>
                  </div>
                </dl>
                {row.note ? (
                  <p className="mt-3 break-words border-t border-white/[0.05] pt-3 text-xs text-muted-foreground">
                    {row.note}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
          <div className="hidden overflow-hidden rounded-md border border-white/[0.06] md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/[0.02] text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  <th className="px-3 py-2">Ticker</th>
                  <th className="px-3 py-2 text-right">Shares</th>
                  <th className="px-3 py-2 text-right">Avg cost</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((row, i) => (
                  <tr key={i} className="border-t border-white/[0.04]">
                    <td className="px-3 py-2 font-mono text-sm font-semibold">{row.ticker}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{row.shares}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      ${row.avgCost.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{row.category}</td>
                    <td className="px-3 py-2">
                      <ValidityBadge v={row.validity} note={row.note} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview.length > 0 && missingFromPaste.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <strong className="font-semibold">Heads up:</strong> {missingFromPaste.join(', ')} exist
          in the DB but aren&rsquo;t in this paste. We don&rsquo;t auto-close them — close manually
          if intended.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 font-mono text-xs text-emerald-300">
          Created {result.created.length} · Updated {result.updated.length} · Skipped{' '}
          {result.skipped.length}
        </div>
      )}

      {preview.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <span className="font-mono text-[10px] text-muted-foreground/60">
            {validRows.length} valid · {preview.length - validRows.length} blocked
          </span>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting || validRows.length === 0}
            className="min-h-11 w-full rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30 disabled:opacity-40 sm:w-auto"
          >
            {submitting ? 'Importing…' : `Import ${validRows.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

function ValidityBadge({ v, note }: { v: Validity; note?: string }): React.ReactElement {
  const cls =
    v === 'ok'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : v === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : 'border-rose-500/40 bg-rose-500/10 text-rose-300';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]',
        cls,
      )}
      title={note}
    >
      {v === 'ok' ? 'OK' : v === 'warn' ? 'warn' : 'invalid'}
    </span>
  );
}
