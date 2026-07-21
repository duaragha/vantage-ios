import { zonedDateKey } from '@vantage/db';

/** Earnings providers encode a report date at midnight UTC; it is not an instant. */
export function calendarEventDateKey(kind: string, occurredAt: Date, timezone: string): string {
  return kind === 'Earnings'
    ? occurredAt.toISOString().slice(0, 10)
    : zonedDateKey(occurredAt, timezone);
}

export function calendarArticleDateKey(publishedAt: Date): string {
  return publishedAt.toISOString().slice(0, 10);
}
