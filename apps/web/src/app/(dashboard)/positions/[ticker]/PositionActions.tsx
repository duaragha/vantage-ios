/**
 * PositionActions — client action cluster for a position detail page.
 * Edit (opens Drawer), Re-evaluate (POSTs to /api/worker/thesis/:id), Close.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Drawer } from '@/components/Drawer';
import { PositionForm } from '@/components/PositionForm';

export function PositionActions({
  positionId,
  ticker,
}: {
  positionId: number;
  ticker: string;
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [working, setWorking] = React.useState<null | 'eval' | 'close'>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const reEval = async () => {
    setWorking('eval');
    setToast(null);
    try {
      const res = await fetch(`/api/positions/${positionId}/re-evaluate`, {
        method: 'POST',
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setToast('Evaluation enqueued.');
        router.refresh();
      } else {
        setToast(body.error ?? 'failed');
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'network error');
    } finally {
      setWorking(null);
    }
  };

  const closePos = async () => {
    if (!window.confirm(`Close position in ${ticker}?`)) return;
    setWorking('close');
    setToast(null);
    try {
      const res = await fetch(`/api/positions/${positionId}/close`, {
        method: 'POST',
      });
      if (res.ok) {
        setToast('Closed.');
        router.push('/portfolio');
        router.refresh();
      } else {
        const body = (await res.json()) as { error?: string };
        setToast(body.error ?? 'failed');
      }
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'network error');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-white/[0.08] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition hover:border-white/[0.2] hover:text-foreground"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={reEval}
          disabled={working !== null}
          className="rounded-md border border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:bg-[var(--cc-accent)]/20 disabled:opacity-40"
        >
          {working === 'eval' ? 'Running…' : 'Re-evaluate'}
        </button>
        <button
          type="button"
          onClick={closePos}
          disabled={working !== null}
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-40"
        >
          Close
        </button>
      </div>
      {toast && (
        <div className="rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[10px] text-muted-foreground">
          {toast}
        </div>
      )}
      <Drawer
        open={open}
        title={`Edit ${ticker}`}
        description="Update the lot, alert thresholds, and thesis. Ticker is immutable."
        onClose={() => setOpen(false)}
      >
        <EditPositionBody
          positionId={positionId}
          ticker={ticker}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      </Drawer>
    </div>
  );
}

function EditPositionBody({
  positionId,
  ticker,
  onDone,
}: {
  positionId: number;
  ticker: string;
  onDone: () => void;
}): React.ReactElement {
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [prefill, setPrefill] = React.useState<{
    shares: string;
    avgCost: string;
    category: string;
    sector: string;
    notes: string;
    stopLoss: string;
    priceTarget: string;
    currency: string;
    accountId: number;
    thesisSummary: string;
    pillars: string[];
    riskFactors: string[];
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setPrefill(null);
    (async () => {
      try {
        const res = await fetch(`/api/positions/by-ticker/${ticker}?positionId=${positionId}`);
        if (!res.ok) throw new Error('failed to load');
        const body = (await res.json()) as {
          position: {
            shares: string | number;
            avgCost: string | number;
            category: string;
            sector: string | null;
            notes: string | null;
            stopLoss: string | number | null;
            priceTarget: string | number | null;
            currency: string;
            accountId: number;
          };
          thesis: { summary: string; pillars: unknown; riskFactors: unknown } | null;
        };
        if (cancelled) return;
        const pillars = Array.isArray(body.thesis?.pillars)
          ? (body.thesis!.pillars as Array<{ statement?: string }>).map((p) => p.statement ?? '')
          : [];
        const risks = Array.isArray(body.thesis?.riskFactors)
          ? (body.thesis!.riskFactors as Array<{ statement?: string }>).map(
              (r) => r.statement ?? '',
            )
          : [];
        setPrefill({
          shares: String(body.position.shares),
          avgCost: String(body.position.avgCost),
          category: body.position.category,
          sector: body.position.sector ?? '',
          notes: body.position.notes ?? '',
          stopLoss: body.position.stopLoss == null ? '' : String(body.position.stopLoss),
          priceTarget: body.position.priceTarget == null ? '' : String(body.position.priceTarget),
          currency: body.position.currency,
          accountId: body.position.accountId,
          thesisSummary: body.thesis?.summary ?? '',
          pillars: pillars.length ? pillars : ['', ''],
          riskFactors: risks.length ? risks : [''],
        });
        setLoaded(true);
      } catch {
        if (!cancelled) {
          setLoadError('Position details could not be loaded.');
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [positionId, reloadKey, ticker]);

  if (!loaded) {
    return <div className="h-24 animate-pulse rounded-md bg-white/[0.03]" />;
  }
  if (!prefill || loadError) {
    return (
      <div className="rounded-md border border-rose-500/30 bg-rose-500/[0.08] p-4 text-sm text-rose-100">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{loadError ?? 'Position details are unavailable.'}</span>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          className="mt-3 inline-flex items-center gap-2 rounded-md border border-rose-400/30 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition hover:bg-rose-400/10"
        >
          <RefreshCw className="size-3.5" aria-hidden />
          Retry
        </button>
      </div>
    );
  }

  return (
    <PositionForm
      mode="edit"
      prefill={{
        ticker,
        shares: prefill.shares,
        avgCost: prefill.avgCost,
        category: prefill.category,
        sector: prefill.sector,
        notes: prefill.notes,
        stopLoss: prefill.stopLoss,
        priceTarget: prefill.priceTarget,
        currency: prefill.currency,
        accountId: prefill.accountId,
        thesisSummary: prefill.thesisSummary,
        pillars: prefill.pillars,
        riskFactors: prefill.riskFactors,
      }}
      onDone={onDone}
    />
  );
}
