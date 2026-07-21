/**
 * Off-peak polling cadence policy.
 *
 * The cron expressions in cron.ts keep their original (peak) frequency; these
 * gates decide which ticks actually run based on the US-market clock, so
 * off-hours ticks skip before any JobRun row or provider call happens. Every
 * gate fails open (returns true) on anything it cannot classify — cadence is
 * an optimization, never a correctness layer.
 *
 * All decisions use the America/New_York clock. The cron timezone is
 * America/Toronto, which shares the same UTC offset year-round.
 */

interface EasternClock {
  /** e.g. 'Mon' */
  weekday: string;
  hour: number;
  minute: number;
  /** ISO calendar date in ET, e.g. '2026-07-03' */
  dateKey: string;
}

export function easternClock(now: Date): EasternClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const hourRaw = Number(get('hour'));
  return {
    weekday: get('weekday'),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(get('minute')),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * NYSE full-closure holidays (ET dates). Past the table's horizon we treat
 * every day as a trading day — polling a closed market is waste, but not
 * polling an open one loses data, so the list rots safe.
 */
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
]);

export function isUsMarketHoliday(now: Date): boolean {
  return US_MARKET_HOLIDAYS.has(easternClock(now).dateKey);
}

/**
 * poll.prices tick gate. The cron fires per-minute across 04:00-19:59 ET;
 * this keeps the per-minute cadence only where it earns its cost:
 *   - regular session (with a small margin, 9:25-16:04 ET): every minute
 *   - pre/after-hours: every 5 minutes (IEX extended-hours prints are thin)
 *   - US market holidays: every 15 minutes (TSX may still be open, so held
 *     Canadian names keep a pulse via the yfinance path)
 */
export function pricePollDue(now: Date): boolean {
  const clock = easternClock(now);
  if (isUsMarketHoliday(now)) return clock.minute % 15 === 0;
  const minutes = clock.hour * 60 + clock.minute;
  const inRegularSession = minutes >= 9 * 60 + 25 && minutes < 16 * 60 + 5;
  if (inRegularSession) return true;
  return clock.minute % 5 === 0;
}

export interface QuietHoursSpec {
  /** Quiet window start, ET minutes-of-day (window may cross midnight). */
  quietStartMinute: number;
  /** Quiet window end, ET minutes-of-day (exclusive). */
  quietEndMinute: number;
  /** During the quiet window, run only when ET minute % cadence === 0. */
  quietCadenceMinutes: number;
}

/**
 * Generic overnight thinning gate: full cadence during the day, reduced
 * cadence inside the quiet window. Sources that publish nothing overnight
 * (EDGAR closes intake at 22:00 ET; newsrooms sleep) don't need 5-minute
 * polling at 3am.
 */
export function offPeakPollDue(now: Date, spec: QuietHoursSpec): boolean {
  const clock = easternClock(now);
  const minutes = clock.hour * 60 + clock.minute;
  const inQuiet =
    spec.quietStartMinute > spec.quietEndMinute
      ? minutes >= spec.quietStartMinute || minutes < spec.quietEndMinute
      : minutes >= spec.quietStartMinute && minutes < spec.quietEndMinute;
  if (!inQuiet) return true;
  return clock.minute % spec.quietCadenceMinutes === 0;
}

/** 22:00-06:00 ET, one tick per 30 minutes. For the 5-minute pollers. */
export const OVERNIGHT_EVERY_30M: QuietHoursSpec = {
  quietStartMinute: 22 * 60,
  quietEndMinute: 6 * 60,
  quietCadenceMinutes: 30,
};

/** 22:00-06:00 ET, one tick per hour. For the 15-minute pollers. */
export const OVERNIGHT_HOURLY: QuietHoursSpec = {
  quietStartMinute: 22 * 60,
  quietEndMinute: 6 * 60,
  quietCadenceMinutes: 60,
};

/**
 * pollFilings polls three EDGAR forms per ticker. 8-K needs the 5-minute
 * cadence (catalyst latency); 10-Q/10-K are slow-moving, so their extra 2/3 of
 * the request volume runs only on the top-of-hour tick.
 */
export function includeQuarterlyFilingForms(now: Date): boolean {
  return easternClock(now).minute < 5;
}
