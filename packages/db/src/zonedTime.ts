/** Timezone-aware query boundaries that do not depend on the process `TZ`. */

export const DEFAULT_TIMEZONE = 'America/Toronto';

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
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

function zonedWallTimeToInstant(wall: ZonedParts, timezone: string): Date {
  const desiredAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  let candidate = desiredAsUtc;

  // Correct the UTC-shaped wall time by the zone offset at the candidate.
  // Repeating handles the offset changing between the initial guess and the
  // target instant, including daylight-saving transition days.
  for (let attempt = 0; attempt < 4; attempt++) {
    const shown = partsInZone(new Date(candidate), timezone);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    const correction = desiredAsUtc - shownAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }

  return new Date(candidate);
}

/** UTC instant corresponding to local midnight for `date` in `timezone`. */
export function startOfZonedDay(
  date: Date = new Date(),
  timezone: string = DEFAULT_TIMEZONE,
): Date {
  const local = partsInZone(date, timezone);
  return zonedWallTimeToInstant({ ...local, hour: 0, minute: 0, second: 0 }, timezone);
}

/** UTC instant corresponding to the first local midnight of the local month. */
export function startOfZonedMonth(
  date: Date = new Date(),
  timezone: string = DEFAULT_TIMEZONE,
): Date {
  const local = partsInZone(date, timezone);
  return zonedWallTimeToInstant({ ...local, day: 1, hour: 0, minute: 0, second: 0 }, timezone);
}

/** Local midnight `days` calendar days away from `date` in `timezone`. */
export function addZonedDays(date: Date, days: number, timezone: string = DEFAULT_TIMEZONE): Date {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const local = partsInZone(date, timezone);
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return zonedWallTimeToInstant(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timezone,
  );
}

/** YYYY-MM-DD calendar key for `date` in `timezone`. */
export function zonedDateKey(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const local = partsInZone(date, timezone);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

/**
 * UTC bounds for rows that encode a calendar date as midnight UTC rather than
 * a real instant, such as an earnings provider's report date.
 */
export function utcDateOnlyRange(
  asOf: Date = new Date(),
  startOffsetDays = 0,
  dayCount = 1,
  timezone: string = DEFAULT_TIMEZONE,
): { start: Date; end: Date } {
  if (!Number.isInteger(startOffsetDays)) {
    throw new RangeError('startOffsetDays must be an integer');
  }
  if (!Number.isInteger(dayCount) || dayCount < 1) {
    throw new RangeError('dayCount must be a positive integer');
  }
  const localMidnight = startOfZonedDay(asOf, timezone);
  const startKey = zonedDateKey(addZonedDays(localMidnight, startOffsetDays, timezone), timezone);
  const endKey = zonedDateKey(
    addZonedDays(localMidnight, startOffsetDays + dayCount, timezone),
    timezone,
  );
  return {
    start: new Date(`${startKey}T00:00:00.000Z`),
    end: new Date(`${endKey}T00:00:00.000Z`),
  };
}
