export interface PositionLotInput {
  shares: number;
  costPerShare: number;
  acquiredAt: string | null;
  note: string | null;
}

export type PositionLotInputResult =
  | { ok: true; value: PositionLotInput & { acquiredAtDate: Date | null } }
  | { ok: false; error: string };

export function torontoDateKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function parsePositionLotInput(
  input: PositionLotInput,
  today: string = torontoDateKey(),
): PositionLotInputResult {
  const shares = Number(input.shares);
  if (!Number.isFinite(shares) || shares <= 0) {
    return { ok: false, error: 'shares must be a positive number' };
  }
  const costPerShare = Number(input.costPerShare);
  if (!Number.isFinite(costPerShare) || costPerShare < 0) {
    return { ok: false, error: 'cost per share must be zero or positive' };
  }

  const rawDate = input.acquiredAt?.trim() || null;
  let acquiredAtDate: Date | null = null;
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return { ok: false, error: 'purchase date must use YYYY-MM-DD' };
    }
    acquiredAtDate = new Date(`${rawDate}T00:00:00.000Z`);
    if (
      Number.isNaN(acquiredAtDate.getTime()) ||
      acquiredAtDate.toISOString().slice(0, 10) !== rawDate
    ) {
      return { ok: false, error: 'purchase date is invalid' };
    }
    if (rawDate > today) {
      return { ok: false, error: 'purchase date cannot be in the future' };
    }
  }

  const note = input.note?.trim() || null;
  if (note && note.length > 240) {
    return { ok: false, error: 'lot note must be 240 characters or fewer' };
  }

  return {
    ok: true,
    value: { shares, costPerShare, acquiredAt: rawDate, acquiredAtDate, note },
  };
}
