/**
 * Number / currency formatters. Everything right-aligned + tabular-nums on the
 * call-site; these just hand back the canonical string.
 */

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtUsdSigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * Format a number with a currency symbol. USD uses `$` (matches fmtUsd output
 * exactly); CAD uses `C$` so the portfolio table can show native-currency
 * prints next to the USD conversion without ambiguity.
 */
export function fmtMoney(
  n: number | null | undefined,
  currency: 'USD' | 'CAD' | string,
  digits = 2,
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const prefix = currency === 'CAD' ? 'C$' : '$';
  return `${prefix}${n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtMoneySigned(
  n: number | null | undefined,
  currency: 'USD' | 'CAD' | string,
  digits = 2,
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${fmtMoney(Math.abs(n), currency, digits)}`;
}

/**
 * Average dollar-volume for the day-trade scanner. Below $1B reads as whole
 * millions ("$324M"); at/above $1B it rolls up to "$X.XB" ("$17490M" → "$17.5B")
 * so the deepest books don't render as an unreadable five-digit million figure.
 */
export function fmtDollarVolume(
  n: number | null | undefined,
  currency: 'USD' | 'CAD' | string = 'USD',
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const prefix = currency === 'CAD' ? 'C$' : '$';
  const m = n / 1_000_000;
  return m >= 1_000 ? `${prefix}${(m / 1_000).toFixed(1)}B` : `${prefix}${m.toFixed(0)}M`;
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function fmtShares(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  // Whole shares get no decimal; fractional shares show up to 4 digits.
  if (Math.floor(abs) === abs) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function pnlTone(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'text-zinc-300';
  return n > 0 ? 'text-emerald-400' : 'text-rose-400';
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

/** Format a database calendar date without shifting it through local time. */
export function fmtCalendarDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format an instant as an unambiguous US-market wall-clock time in ET, e.g.
 * "4:57 PM ET" — or "Tue 4:57 PM ET" when it's not the same ET calendar day as
 * `now`. Used for the day-trade scanner's "as of" stamp so the time is always
 * the actual ET trade time (no double-tz-shift: Intl converts the instant to
 * America/New_York directly). `now` defaults to the current instant; pass it to
 * keep server/client renders deterministic if needed.
 */
export function fmtEtClockTime(
  d: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  const TZ = 'America/New_York';
  const time = date.toLocaleTimeString('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  // Same ET calendar day as now? Compare the en-CA date strings in ET.
  const dayOf = (x: Date): string => x.toLocaleDateString('en-CA', { timeZone: TZ });
  if (dayOf(date) === dayOf(now)) return `${time} ET`;
  const weekday = date.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  return `${weekday} ${time} ET`;
}

export function fmtTimeAgo(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}
