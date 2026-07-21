const TORONTO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function torontoDateKey(date: Date): string {
  const parts = TORONTO_DATE.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Compare an HTML date-input value against the current Toronto calendar day. */
export function isTorontoDateKeyInPast(value: string, now: Date = new Date()): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value < torontoDateKey(now);
}

/** Weekdays elapsed after `from` through `to`, using Toronto calendar dates. */
export function torontoTradingDaysBetween(from: Date, to: Date): number {
  const start = new Date(`${torontoDateKey(from)}T00:00:00.000Z`);
  const end = new Date(`${torontoDateKey(to)}T00:00:00.000Z`);
  if (start >= end) return 0;

  let days = 0;
  while (start < end) {
    start.setUTCDate(start.getUTCDate() + 1);
    const day = start.getUTCDay();
    if (day !== 0 && day !== 6) days++;
  }
  return days;
}
