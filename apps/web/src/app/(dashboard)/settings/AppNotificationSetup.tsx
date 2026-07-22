'use client';

import * as React from 'react';
import { BellRing, Check, ExternalLink, Smartphone, TriangleAlert } from 'lucide-react';
import type { AppNotificationConfig } from './actions';
import { cn } from '@/lib/utils';

type SetupState =
  | 'checking'
  | 'not-configured'
  | 'livecontainer'
  | 'install-required'
  | 'unsupported'
  | 'ready'
  | 'subscribed'
  | 'denied'
  | 'error';

export function AppNotificationSetup({
  config,
}: {
  config: AppNotificationConfig;
}): React.ReactElement {
  const [state, setState] = React.useState<SetupState>('checking');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{
    tone: 'ok' | 'err';
    text: string;
  } | null>(null);

  const inspect = React.useCallback(async () => {
    setMessage(null);
    if (!config.configured || !config.publicKey) {
      setState('not-configured');
      return;
    }

    const userAgent = navigator.userAgent;
    const isLiveContainer = /Vantage-iOS/i.test(userAgent);
    const isIos = /iPhone|iPad|iPod/i.test(userAgent);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;

    if (isLiveContainer) {
      setState('livecontainer');
      return;
    }
    if (isIos && !standalone) {
      setState('install-required');
      return;
    }
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setState('denied');
      return;
    }

    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const subscription = await registration.pushManager.getSubscription();
      setState(subscription ? 'subscribed' : 'ready');
    } catch {
      setState('error');
    }
  }, [config.configured, config.publicKey]);

  React.useEffect(() => {
    void inspect();
  }, [inspect]);

  const enable = async (): Promise<void> => {
    if (!config.publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'ready');
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        }));
      const serialized = subscription.toJSON();
      const response = await fetch('/api/notifications/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serialized),
      });
      if (!response.ok) {
        if (!existing) await subscription.unsubscribe();
        throw new Error('subscription rejected');
      }
      setState('subscribed');
      setMessage({ tone: 'ok', text: 'Vantage notifications are enabled on this device.' });
    } catch {
      setState('error');
      setMessage({ tone: 'err', text: 'Vantage could not enable notifications on this device.' });
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch('/api/notifications/subscriptions', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error('unsubscribe rejected');
        await subscription.unsubscribe();
      }
      setState('ready');
      setMessage({ tone: 'ok', text: 'Notifications are off on this device.' });
    } catch {
      setMessage({ tone: 'err', text: 'Vantage could not disable this device.' });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/notifications/test', { method: 'POST' });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? 'delivery failed');
      setMessage({ tone: 'ok', text: 'Sent. The Vantage notification should arrive now.' });
    } catch (error) {
      setMessage({
        tone: 'err',
        text: error instanceof Error ? error.message : 'Test notification failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  const meta = stateMeta(state);
  const StatusIcon = meta.icon;

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-[var(--cc-accent)]/[0.11] via-white/[0.035] to-transparent">
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-white/[0.09] bg-black/20 text-[var(--cc-accent)]">
            <BellRing className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Vantage app notifications</h3>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]',
                  meta.badgeClass,
                )}
              >
                <StatusIcon className="size-3" />
                {meta.label}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{meta.description}</p>
          </div>
        </div>

        {(state === 'livecontainer' || state === 'install-required') && (
          <div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.055] p-3 text-xs leading-relaxed text-amber-100/85">
            <div className="flex items-start gap-2">
              <Smartphone className="mt-0.5 size-4 shrink-0 text-amber-200" />
              <p>
                Open <span className="font-medium text-amber-100">vantagee.up.railway.app</span> in
                Safari, tap Share, then <span className="font-medium">Add to Home Screen</span>.
                Open that Vantage icon and return here once.
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {state === 'ready' && (
            <button type="button" onClick={enable} disabled={busy} className={primaryButtonClass()}>
              {busy ? 'Enabling…' : 'Enable notifications'}
            </button>
          )}
          {state === 'subscribed' && (
            <>
              <button
                type="button"
                onClick={sendTest}
                disabled={busy}
                className={primaryButtonClass()}
              >
                {busy ? 'Sending…' : 'Send test'}
              </button>
              <button
                type="button"
                onClick={disable}
                disabled={busy}
                className="min-h-11 rounded-xl border border-white/[0.08] px-4 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:bg-white/[0.04] disabled:opacity-40"
              >
                Disable this device
              </button>
            </>
          )}
          {(state === 'error' || state === 'checking') && (
            <button
              type="button"
              onClick={() => void inspect()}
              disabled={state === 'checking'}
              className={primaryButtonClass()}
            >
              {state === 'checking' ? 'Checking…' : 'Try again'}
            </button>
          )}
          {(state === 'livecontainer' || state === 'install-required') && (
            <a
              href="https://vantagee.up.railway.app/settings"
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/[0.1] bg-black/20 px-4 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground transition hover:bg-white/[0.06]"
            >
              Open in Safari <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </div>

      {message && (
        <div
          className={cn(
            'border-t px-4 py-2.5 text-xs sm:px-5',
            message.tone === 'ok'
              ? 'border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-300'
              : 'border-rose-400/15 bg-rose-400/[0.06] text-rose-300',
          )}
        >
          {message.text}
        </div>
      )}
    </section>
  );
}

function stateMeta(state: SetupState): {
  label: string;
  description: string;
  icon: typeof Check;
  badgeClass: string;
} {
  if (state === 'subscribed') {
    return {
      label: 'Connected',
      description: 'Vantage can reach this device even while the app is closed.',
      icon: Check,
      badgeClass: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
    };
  }
  if (state === 'ready') {
    return {
      label: 'Ready',
      description: 'Enable once to let Vantage alert this device.',
      icon: BellRing,
      badgeClass: 'border-[var(--cc-accent)]/25 bg-[var(--cc-accent)]/10 text-[var(--cc-accent)]',
    };
  }
  if (state === 'livecontainer') {
    return {
      label: 'Home Screen needed',
      description: 'LiveContainer cannot receive remote push from Railway when Vantage is closed.',
      icon: Smartphone,
      badgeClass: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
    };
  }
  if (state === 'install-required') {
    return {
      label: 'Install first',
      description: 'iOS enables web push only for Vantage added to the Home Screen.',
      icon: Smartphone,
      badgeClass: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
    };
  }
  if (state === 'denied') {
    return {
      label: 'Blocked',
      description: 'Allow Vantage in iPhone Settings → Notifications, then try again.',
      icon: TriangleAlert,
      badgeClass: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
    };
  }
  if (state === 'not-configured') {
    return {
      label: 'Server setup',
      description: 'The Vantage push service is not configured on Railway yet.',
      icon: TriangleAlert,
      badgeClass: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
    };
  }
  if (state === 'unsupported') {
    return {
      label: 'Unavailable',
      description: 'This browser cannot register for Vantage background notifications.',
      icon: TriangleAlert,
      badgeClass: 'border-rose-400/25 bg-rose-400/10 text-rose-300',
    };
  }
  return {
    label: state === 'checking' ? 'Checking' : 'Retry needed',
    description:
      state === 'checking'
        ? 'Checking this device for Vantage notification support.'
        : 'Vantage could not verify this device notification channel.',
    icon: state === 'checking' ? BellRing : TriangleAlert,
    badgeClass: 'border-white/[0.12] bg-white/[0.05] text-muted-foreground',
  };
}

function primaryButtonClass(): string {
  return 'min-h-11 rounded-xl border border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/12 px-4 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--cc-accent)] transition active:scale-[0.98] hover:bg-[var(--cc-accent)]/20 disabled:opacity-40';
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = window.atob(`${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/'));
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}
