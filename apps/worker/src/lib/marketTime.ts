const EASTERN_TIMEZONE = 'America/New_York';

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function easternParts(date: Date): DateTimeParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: EASTERN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = value('hour');
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: hour === 24 ? 0 : hour,
    minute: value('minute'),
    second: value('second'),
  };
}

/** UTC instant corresponding to midnight in America/New_York for `date`. */
export function startOfEasternDay(date: Date): Date {
  const local = easternParts(date);
  const desired = Date.UTC(local.year, local.month - 1, local.day);
  let candidate = desired;

  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = easternParts(new Date(candidate));
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    const correction = desired - shownAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

export function easternDateKey(date: Date): string {
  const parts = easternParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Store an Eastern calendar day in a timezone-neutral DATE-compatible instant. */
export function easternCalendarDate(date: Date): Date {
  return new Date(`${easternDateKey(date)}T00:00:00.000Z`);
}
