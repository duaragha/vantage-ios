/**
 * Shared goal + watchlist mutation core.
 *
 * Single source of truth for the validation, before→after diff, confirm-gating,
 * and Prisma writes behind goal/watchlist mutations. BOTH the form-bound server
 * actions (apps/web/src/app/(dashboard)/goals/actions.ts +
 * watchlist/actions.ts) and the chat tool-use loop (apps/web/src/app/api/chat/
 * route.ts) call into here so validation never diverges between the two surfaces.
 *
 * Confirm-before-write contract (enforced server-side, not by prompt alone):
 * the "modify"/"remove" mutations accept `confirm?: boolean`. When confirm is
 * falsy the function validates, computes the exact field-level diff, and returns
 * a `{ status: 'preview' }` result WITHOUT touching the database. Only a second
 * call with `confirm: true` performs the write. `previewGoalUpdate` /
 * `diffGoalUpdate` / the per-field normalizers are pure (no Prisma at call time)
 * so the gating logic is unit-testable without a database.
 *
 * Validation uses the existing hand-rolled normalizers (the repo deliberately
 * avoids a schema-lib dependency — see packages/llm/src/tools.ts header); the
 * `normalize*` helpers here are the canonical schema for goal input.
 */

import { prisma, Prisma } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { torontoDateKey } from './marketTime';

const log = componentLogger('web/lib/goal-mutations');

function mutationFailure(operation: string, err: unknown): Err {
  log.error({ err, operation }, 'goal/watchlist mutation failed');
  return { ok: false, error: `${operation} could not be completed` };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalTypeValue =
  | 'Withdrawal'
  | 'DownPayment'
  | 'Vacation'
  | 'TaxBill'
  | 'EmergencyFund'
  | 'Income'
  | 'Retirement'
  | 'Education'
  | 'Custom'
  | 'DayTrading';

export type RiskOverrideValue = 'VeryLow' | 'Low' | 'Moderate' | 'High' | 'Aggressive';
export type StrategyValue = 'Income' | 'Growth' | 'Balanced' | 'Preservation';
export type TradingStyleValue = 'Momentum' | 'Breakout' | 'ORB' | 'MeanReversion' | 'Scalping';
export type ContributionFrequencyValue = 'Weekly' | 'Biweekly' | 'Monthly' | 'Quarterly';

export interface GoalInputForm {
  name: string;
  type: GoalTypeValue;
  targetAmountCad: number;
  targetDate: Date | string | null;
  isWithdrawal: boolean;
  notes?: string | null;
  riskOverride?: RiskOverrideValue | null;
  strategy?: StrategyValue | null;
  tradingStyle?: TradingStyleValue | null;
  contributionAmountCad?: number | null;
  contributionFrequency?: ContributionFrequencyValue | null;
  contributionStartDate?: Date | string | null;
  accountId?: number | null;
}

export const GOAL_TYPES: readonly GoalTypeValue[] = [
  'Withdrawal',
  'DownPayment',
  'Vacation',
  'TaxBill',
  'EmergencyFund',
  'Income',
  'Retirement',
  'Education',
  'Custom',
  'DayTrading',
];
export const RISK_VALUES: readonly RiskOverrideValue[] = [
  'VeryLow',
  'Low',
  'Moderate',
  'High',
  'Aggressive',
];
export const STRATEGY_VALUES: readonly StrategyValue[] = [
  'Income',
  'Growth',
  'Balanced',
  'Preservation',
];
export const TRADING_STYLES: readonly TradingStyleValue[] = [
  'Momentum',
  'Breakout',
  'ORB',
  'MeanReversion',
  'Scalping',
];
const CONTRIBUTION_FREQUENCIES = new Set<ContributionFrequencyValue>([
  'Weekly',
  'Biweekly',
  'Monthly',
  'Quarterly',
]);

// Result/Ok/ConfirmOutcome use `& T` where T defaults to an empty record so
// the "no extra fields" members type cleanly. `Record<string, never>` can't be
// used as the default — it forces every key to `never` and breaks the union.
type Empty = Record<never, never>;
export type Ok<T extends object = Empty> = { ok: true } & T;
export type Err = { ok: false; error: string };
export type Result<T extends object = Empty> = Ok<T> | Err;

/** A single field-level before→after change in a confirm preview. */
export interface FieldDiff {
  field: string;
  from: string;
  to: string;
}

/**
 * Outcome of a confirm-gated mutation. `preview` means nothing was written and
 * the caller should surface `diff`/`summary` for the user to approve; `written`
 * means the change was applied.
 */
export type ConfirmOutcome<T extends object = Empty> =
  | { ok: true; status: 'preview'; diff: FieldDiff[]; summary: string }
  | ({ ok: true; status: 'written' } & T)
  | Err;

// ---------------------------------------------------------------------------
// Pure normalizers (DB-free — safe to unit test)
// ---------------------------------------------------------------------------

export interface NormalizedContribution {
  amount: Prisma.Decimal | null;
  frequency: ContributionFrequencyValue | null;
  startDate: Date | null;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Normalize a calendar date to midnight UTC without changing its date key. */
export function parseGoalCalendarDate(input: Date | string): Date | null {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const raw = input.trim();
  if (!raw) return null;
  if (DATE_ONLY_RE.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10) === raw ? parsed : null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function calendarDateKey(input: Date | string): string | null {
  return parseGoalCalendarDate(input)?.toISOString().slice(0, 10) ?? null;
}

/**
 * Validate the DCA contribution schedule as a unit. Amount + frequency are
 * all-or-nothing. DayTrading goals never carry a schedule.
 */
export function normalizeContribution(
  input: Pick<
    GoalInputForm,
    'type' | 'contributionAmountCad' | 'contributionFrequency' | 'contributionStartDate'
  >,
): Result<{ value: NormalizedContribution }> {
  if (input.type === 'DayTrading') {
    return { ok: true, value: { amount: null, frequency: null, startDate: null } };
  }

  const rawAmount = input.contributionAmountCad;
  const rawFreq = input.contributionFrequency ?? null;
  const hasAmount = rawAmount != null && rawAmount !== 0;
  const hasFreq = rawFreq != null;

  if (!hasAmount && !hasFreq) {
    return { ok: true, value: { amount: null, frequency: null, startDate: null } };
  }
  if (hasAmount && (!Number.isFinite(rawAmount as number) || (rawAmount as number) <= 0)) {
    return { ok: false, error: 'Contribution amount must be a positive number.' };
  }
  if (hasAmount && !hasFreq) {
    return { ok: false, error: 'Select a contribution frequency.' };
  }
  if (hasFreq && !CONTRIBUTION_FREQUENCIES.has(rawFreq as ContributionFrequencyValue)) {
    return { ok: false, error: 'Invalid contribution frequency.' };
  }
  if (hasFreq && !hasAmount) {
    return { ok: false, error: 'Enter a contribution amount.' };
  }

  let startDate: Date | null = null;
  if (input.contributionStartDate) {
    startDate = parseGoalCalendarDate(input.contributionStartDate);
    if (!startDate) {
      return { ok: false, error: 'Invalid contribution start date.' };
    }
  }

  return {
    ok: true,
    value: {
      amount: new Prisma.Decimal(rawAmount as number),
      frequency: rawFreq,
      startDate,
    },
  };
}

export interface NormalizedGoalCreate {
  name: string;
  type: GoalTypeValue;
  targetAmountCad: Prisma.Decimal;
  targetDate: Date | null;
  isWithdrawal: boolean;
  notes: string | null;
  riskOverride: RiskOverrideValue | null;
  strategy: StrategyValue | null;
  tradingStyle: TradingStyleValue | null;
  contributionAmountCad: Prisma.Decimal | null;
  contributionFrequency: ContributionFrequencyValue | null;
  contributionStartDate: Date | null;
  accountId: number | null;
}

function isDateInPast(inputDate: Date | string): boolean {
  const key = calendarDateKey(inputDate);
  return key !== null && key < torontoDateKey(new Date());
}

/** Full create-path validation. Mirrors the legacy normalizeInput exactly. */
export function normalizeGoalCreate(input: GoalInputForm): Result<{ data: NormalizedGoalCreate }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!GOAL_TYPES.includes(input.type)) return { ok: false, error: 'Invalid goal type.' };
  if (!Number.isFinite(input.targetAmountCad) || input.targetAmountCad <= 0) {
    return { ok: false, error: 'Target amount must be a positive number.' };
  }
  let targetDate: Date | null = null;
  if (input.targetDate) {
    targetDate = parseGoalCalendarDate(input.targetDate);
    if (!targetDate) return { ok: false, error: 'Invalid target date.' };
    if (isDateInPast(targetDate)) return { ok: false, error: 'Target date cannot be in the past.' };
  }
  if (input.riskOverride != null && !RISK_VALUES.includes(input.riskOverride)) {
    return { ok: false, error: 'Invalid risk override.' };
  }
  if (input.strategy != null && !STRATEGY_VALUES.includes(input.strategy)) {
    return { ok: false, error: 'Invalid strategy.' };
  }
  if (input.tradingStyle != null && !TRADING_STYLES.includes(input.tradingStyle)) {
    return { ok: false, error: 'Invalid trading style.' };
  }
  const contribution = normalizeContribution(input);
  if (!contribution.ok) return contribution;
  return {
    ok: true,
    data: {
      name,
      type: input.type,
      targetAmountCad: new Prisma.Decimal(input.targetAmountCad),
      targetDate,
      isWithdrawal: !!input.isWithdrawal,
      notes: input.notes ?? null,
      riskOverride: input.riskOverride ?? null,
      strategy: input.strategy ?? null,
      // tradingStyle only persists for DayTrading goals; cleared otherwise.
      tradingStyle: input.type === 'DayTrading' ? (input.tradingStyle ?? null) : null,
      contributionAmountCad: contribution.value.amount,
      contributionFrequency: contribution.value.frequency,
      contributionStartDate: contribution.value.startDate,
      accountId: input.accountId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Update validation + diff (pure)
// ---------------------------------------------------------------------------

/** Current goal state used to compute the before→after diff for an update. */
export interface CurrentGoalState {
  name: string;
  type: GoalTypeValue;
  targetAmountCad: number;
  targetDate: Date | null;
  isWithdrawal: boolean;
  notes: string | null;
  riskOverride: RiskOverrideValue | null;
  strategy: StrategyValue | null;
  tradingStyle: TradingStyleValue | null;
  contributionAmountCad: number | null;
  contributionFrequency: ContributionFrequencyValue | null;
  contributionStartDate: Date | null;
  accountId: number | null;
}

function fmtDate(d: Date | string | null | undefined): string {
  if (d == null) return '(none)';
  return calendarDateKey(d) ?? '(invalid)';
}

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '(none)';
  if (v instanceof Date) return fmtDate(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function pushDiff(out: FieldDiff[], field: string, from: unknown, to: unknown): void {
  const fromS = fmtVal(from);
  const toS = fmtVal(to);
  if (fromS !== toS) out.push({ field, from: fromS, to: toS });
}

export interface ValidatedGoalUpdate {
  /** Prisma update payload — only contains fields that were in the patch. */
  data: Prisma.GoalUpdateInput;
  /** Human-readable before→after diff for the confirm preview. */
  diff: FieldDiff[];
}

/**
 * Validate a partial goal update against the current state, returning the
 * Prisma update payload AND the field-level diff. Pure: no DB write. The
 * contribution-schedule + tradingStyle clearing rules match updateGoal exactly.
 */
export function validateGoalUpdate(
  current: CurrentGoalState,
  patch: Partial<GoalInputForm>,
): Result<ValidatedGoalUpdate> {
  const data: Prisma.GoalUpdateInput = {};
  const diff: FieldDiff[] = [];

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return { ok: false, error: 'Name cannot be empty.' };
    data.name = name;
    pushDiff(diff, 'name', current.name, name);
  }
  // The effective type after this patch — drives contribution/style clearing.
  const effectiveType: GoalTypeValue = patch.type ?? current.type;
  if (patch.type !== undefined) {
    if (!GOAL_TYPES.includes(patch.type)) return { ok: false, error: 'Invalid goal type.' };
    data.type = patch.type;
    pushDiff(diff, 'type', current.type, patch.type);
  }
  if (patch.targetAmountCad !== undefined) {
    if (!Number.isFinite(patch.targetAmountCad) || patch.targetAmountCad <= 0) {
      return { ok: false, error: 'Target amount must be a positive number.' };
    }
    data.targetAmountCad = new Prisma.Decimal(patch.targetAmountCad);
    pushDiff(diff, 'targetAmountCad', current.targetAmountCad, patch.targetAmountCad);
  }
  if (patch.targetDate !== undefined) {
    if (patch.targetDate === null) {
      data.targetDate = null;
      pushDiff(diff, 'targetDate', current.targetDate, null);
    } else {
      const d = parseGoalCalendarDate(patch.targetDate);
      if (!d) return { ok: false, error: 'Invalid target date.' };
      if (isDateInPast(d)) return { ok: false, error: 'Target date cannot be in the past.' };
      data.targetDate = d;
      pushDiff(diff, 'targetDate', current.targetDate, d);
    }
  }
  if (patch.isWithdrawal !== undefined) {
    data.isWithdrawal = patch.isWithdrawal;
    pushDiff(diff, 'isWithdrawal', current.isWithdrawal, patch.isWithdrawal);
  }
  if (patch.notes !== undefined) {
    data.notes = patch.notes;
    pushDiff(diff, 'notes', current.notes, patch.notes);
  }
  if (patch.riskOverride !== undefined) {
    if (patch.riskOverride != null && !RISK_VALUES.includes(patch.riskOverride)) {
      return { ok: false, error: 'Invalid risk override.' };
    }
    data.riskOverride = patch.riskOverride;
    pushDiff(diff, 'riskOverride', current.riskOverride, patch.riskOverride);
  }
  if (patch.strategy !== undefined) {
    if (patch.strategy != null && !STRATEGY_VALUES.includes(patch.strategy)) {
      return { ok: false, error: 'Invalid strategy.' };
    }
    data.strategy = patch.strategy;
    pushDiff(diff, 'strategy', current.strategy, patch.strategy);
  }

  // tradingStyle: only valid on DayTrading. Switching type away clears it.
  if (patch.type !== undefined && patch.type !== 'DayTrading') {
    data.tradingStyle = null;
    pushDiff(diff, 'tradingStyle', current.tradingStyle, null);
  } else if (patch.tradingStyle !== undefined) {
    if (patch.tradingStyle != null && !TRADING_STYLES.includes(patch.tradingStyle)) {
      return { ok: false, error: 'Invalid trading style.' };
    }
    data.tradingStyle = patch.tradingStyle;
    pushDiff(diff, 'tradingStyle', current.tradingStyle, patch.tradingStyle);
  }

  // Contribution schedule. Switching TO DayTrading clears the whole trio.
  if (effectiveType === 'DayTrading' && patch.type === 'DayTrading') {
    data.contributionAmountCad = null;
    data.contributionFrequency = null;
    data.contributionStartDate = null;
    pushDiff(diff, 'contributionAmountCad', current.contributionAmountCad, null);
    pushDiff(diff, 'contributionFrequency', current.contributionFrequency, null);
    pushDiff(diff, 'contributionStartDate', current.contributionStartDate, null);
  } else if (
    patch.contributionAmountCad !== undefined ||
    patch.contributionFrequency !== undefined ||
    patch.contributionStartDate !== undefined
  ) {
    const contribution = normalizeContribution({
      type: effectiveType,
      contributionAmountCad: patch.contributionAmountCad ?? null,
      contributionFrequency: patch.contributionFrequency ?? null,
      contributionStartDate: patch.contributionStartDate ?? null,
    });
    if (!contribution.ok) return contribution;
    data.contributionAmountCad = contribution.value.amount;
    data.contributionFrequency = contribution.value.frequency;
    data.contributionStartDate = contribution.value.startDate;
    pushDiff(
      diff,
      'contributionAmountCad',
      current.contributionAmountCad,
      contribution.value.amount == null ? null : Number(contribution.value.amount),
    );
    pushDiff(
      diff,
      'contributionFrequency',
      current.contributionFrequency,
      contribution.value.frequency,
    );
    pushDiff(
      diff,
      'contributionStartDate',
      current.contributionStartDate,
      contribution.value.startDate,
    );
  }

  if (patch.accountId !== undefined) {
    data.account =
      patch.accountId === null ? { disconnect: true } : { connect: { id: patch.accountId } };
    pushDiff(diff, 'accountId', current.accountId, patch.accountId);
  }

  return { ok: true, data, diff };
}

/** Render a diff as a one-line human summary for the model/UI. */
export function summarizeDiff(goalName: string, diff: FieldDiff[]): string {
  if (diff.length === 0) return `No changes to "${goalName}".`;
  const parts = diff.map((d) => `${d.field}: ${d.from} → ${d.to}`);
  return `Update "${goalName}": ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Confirm-gating decision (pure)
// ---------------------------------------------------------------------------

/**
 * The core confirm-before-write gate, factored out so it's unit-testable
 * without a database. Given whether the caller confirmed, decide whether to
 * (a) return a preview (no write) or (b) signal that the write should proceed.
 *
 * Returns `{ proceed: false, preview }` when confirm is falsy — the caller MUST
 * NOT write in that case. Returns `{ proceed: true }` only when confirm===true.
 */
export function gateConfirm(
  confirm: boolean | undefined,
  diff: FieldDiff[],
  summary: string,
):
  | { proceed: false; preview: { status: 'preview'; diff: FieldDiff[]; summary: string } }
  | { proceed: true } {
  if (confirm === true) return { proceed: true };
  return { proceed: false, preview: { status: 'preview', diff, summary } };
}

// ---------------------------------------------------------------------------
// DB-backed mutation cores (called by BOTH server actions and chat tools)
// ---------------------------------------------------------------------------

/** Snapshot the goal's editable fields into the diff-friendly shape. */
export async function loadCurrentGoalState(
  goalId: number,
): Promise<(CurrentGoalState & { name: string }) | null> {
  const g = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!g) return null;
  return {
    name: g.name,
    type: g.type as GoalTypeValue,
    targetAmountCad: Number(g.targetAmountCad),
    targetDate: g.targetDate,
    isWithdrawal: g.isWithdrawal,
    notes: g.notes,
    riskOverride: g.riskOverride as RiskOverrideValue | null,
    strategy: g.strategy as StrategyValue | null,
    tradingStyle: g.tradingStyle as TradingStyleValue | null,
    contributionAmountCad: g.contributionAmountCad == null ? null : Number(g.contributionAmountCad),
    contributionFrequency: g.contributionFrequency as ContributionFrequencyValue | null,
    contributionStartDate: g.contributionStartDate,
    accountId: g.accountId,
  };
}

/** Create a goal (additive — no confirm gate). */
export async function createGoalCore(input: GoalInputForm): Promise<Result<{ id: number }>> {
  const v = normalizeGoalCreate(input);
  if (!v.ok) return v;
  try {
    const row = await prisma.goal.create({ data: v.data });
    return { ok: true, id: row.id };
  } catch (e) {
    return mutationFailure('Goal creation', e);
  }
}

/**
 * Update a goal behind the confirm gate. With confirm falsy → returns a preview
 * (diff) and writes nothing. With confirm===true → writes and returns 'written'.
 */
export async function updateGoalCore(
  goalId: number,
  patch: Partial<GoalInputForm>,
  confirm?: boolean,
): Promise<ConfirmOutcome<{ diff: FieldDiff[] }>> {
  const current = await loadCurrentGoalState(goalId);
  if (!current) return { ok: false, error: `Goal #${goalId} not found.` };

  const v = validateGoalUpdate(current, patch);
  if (!v.ok) return v;
  if (v.diff.length === 0) {
    return { ok: false, error: 'No editable fields supplied (nothing would change).' };
  }

  const summary = summarizeDiff(current.name, v.diff);
  const gate = gateConfirm(confirm, v.diff, summary);
  if (!gate.proceed) return { ok: true, ...gate.preview };

  try {
    await prisma.goal.update({ where: { id: goalId }, data: v.data });
    return { ok: true, status: 'written', diff: v.diff };
  } catch (e) {
    return mutationFailure('Goal update', e);
  }
}

/** Archive (soft) a goal behind the confirm gate. Never hard-deletes. */
export async function archiveGoalCore(goalId: number, confirm?: boolean): Promise<ConfirmOutcome> {
  const g = await prisma.goal.findUnique({
    where: { id: goalId },
    select: { name: true, archivedAt: true },
  });
  if (!g) return { ok: false, error: `Goal #${goalId} not found.` };
  if (g.archivedAt) return { ok: false, error: `Goal "${g.name}" is already archived.` };

  const diff: FieldDiff[] = [{ field: 'archivedAt', from: '(active)', to: 'archived' }];
  const summary = `Archive goal "${g.name}" (soft — it can be restored later).`;
  const gate = gateConfirm(confirm, diff, summary);
  if (!gate.proceed) return { ok: true, ...gate.preview };

  try {
    await prisma.goal.update({ where: { id: goalId }, data: { archivedAt: new Date() } });
    return { ok: true, status: 'written' };
  } catch (e) {
    return mutationFailure('Goal archive', e);
  }
}

/**
 * Link a position to a goal behind the confirm gate. Reuses the existing
 * over-allocation guard: returns `overAllocated`/`totalAllocation` so the
 * caller can warn when this position is now committed beyond 100% of itself.
 */
export async function linkPositionCore(
  goalId: number,
  positionId: number,
  allocation: number,
  confirm?: boolean,
): Promise<ConfirmOutcome<{ overAllocated: boolean; totalAllocation: number }>> {
  if (!Number.isFinite(allocation) || allocation <= 0 || allocation > 1) {
    return { ok: false, error: 'Allocation must be between 0 and 1.' };
  }
  const [goal, position, existing] = await Promise.all([
    prisma.goal.findUnique({ where: { id: goalId }, select: { name: true } }),
    prisma.position.findUnique({ where: { id: positionId }, select: { ticker: true } }),
    prisma.goalPosition.findUnique({
      where: { goalId_positionId: { goalId, positionId } },
      select: { allocation: true },
    }),
  ]);
  if (!goal) return { ok: false, error: `Goal #${goalId} not found.` };
  if (!position) return { ok: false, error: `Position #${positionId} not found.` };

  const fromPct = existing ? `${Math.round(Number(existing.allocation) * 100)}%` : '(unlinked)';
  const toPct = `${Math.round(allocation * 100)}%`;
  const diff: FieldDiff[] = [
    { field: `${position.ticker} allocation → ${goal.name}`, from: fromPct, to: toPct },
  ];
  const summary = existing
    ? `Change ${position.ticker}'s allocation to "${goal.name}" from ${fromPct} to ${toPct}.`
    : `Link ${position.ticker} to "${goal.name}" at ${toPct} allocation.`;
  const gate = gateConfirm(confirm, diff, summary);
  if (!gate.proceed) return { ok: true, ...gate.preview };

  try {
    await prisma.goalPosition.upsert({
      where: { goalId_positionId: { goalId, positionId } },
      update: { allocation: new Prisma.Decimal(allocation) },
      create: { goalId, positionId, allocation: new Prisma.Decimal(allocation) },
    });
    const links = await prisma.goalPosition.findMany({
      where: { positionId },
      select: { allocation: true },
    });
    const totalAllocation = links.reduce((s, l) => s + Number(l.allocation), 0);
    return {
      ok: true,
      status: 'written',
      overAllocated: totalAllocation > 1.0 + 1e-6,
      totalAllocation,
    };
  } catch (e) {
    return mutationFailure('Position link', e);
  }
}

/** Unlink a position from a goal behind the confirm gate. */
export async function unlinkPositionCore(
  goalId: number,
  positionId: number,
  confirm?: boolean,
): Promise<ConfirmOutcome> {
  const [goal, link] = await Promise.all([
    prisma.goal.findUnique({ where: { id: goalId }, select: { name: true } }),
    prisma.goalPosition.findUnique({
      where: { goalId_positionId: { goalId, positionId } },
      include: { position: { select: { ticker: true } } },
    }),
  ]);
  if (!goal) return { ok: false, error: `Goal #${goalId} not found.` };
  if (!link)
    return { ok: false, error: `Position #${positionId} is not linked to "${goal.name}".` };

  const ticker = link.position.ticker;
  const diff: FieldDiff[] = [
    {
      field: `${ticker} → ${goal.name}`,
      from: `${Math.round(Number(link.allocation) * 100)}% linked`,
      to: 'unlinked',
    },
  ];
  const summary = `Unlink ${ticker} from "${goal.name}".`;
  const gate = gateConfirm(confirm, diff, summary);
  if (!gate.proceed) return { ok: true, ...gate.preview };

  try {
    await prisma.goalPosition.delete({
      where: { goalId_positionId: { goalId, positionId } },
    });
    return { ok: true, status: 'written' };
  } catch (e) {
    return mutationFailure('Position unlink', e);
  }
}

/** Set/replace a goal's DCA contribution schedule behind the confirm gate. */
export async function setContributionCore(
  goalId: number,
  amount: number,
  frequency: ContributionFrequencyValue,
  startDate: Date | string | null,
  confirm?: boolean,
): Promise<ConfirmOutcome<{ diff: FieldDiff[] }>> {
  const current = await loadCurrentGoalState(goalId);
  if (!current) return { ok: false, error: `Goal #${goalId} not found.` };
  if (current.type === 'DayTrading') {
    return { ok: false, error: 'DayTrading goals do not use a DCA contribution schedule.' };
  }
  // Route through validateGoalUpdate so the all-or-nothing rules + diff are shared.
  return updateGoalCore(
    goalId,
    {
      contributionAmountCad: amount,
      contributionFrequency: frequency,
      contributionStartDate: startDate,
    },
    confirm,
  );
}

// ---------------------------------------------------------------------------
// Watchlist cores (direct — additive / trivially reversible)
// ---------------------------------------------------------------------------

const TICKER_RE = /^[A-Z.-]{1,8}$/;

export function normalizeTicker(ticker: string): Result<{ ticker: string }> {
  const normalized = (ticker ?? '').trim().toUpperCase();
  if (!TICKER_RE.test(normalized)) return { ok: false, error: 'Invalid ticker.' };
  return { ok: true, ticker: normalized };
}

export async function addWatchlistCore(
  ticker: string,
  reason: string | null,
  addedBy: 'user' | 'agent' = 'user',
): Promise<Result<{ ticker: string }>> {
  const v = normalizeTicker(ticker);
  if (!v.ok) return v;
  try {
    await prisma.watchlist.upsert({
      where: { ticker: v.ticker },
      create: { ticker: v.ticker, reason: reason?.trim() || null, addedBy },
      update: { reason: reason?.trim() || null, addedBy },
    });
    return { ok: true, ticker: v.ticker };
  } catch (e) {
    return mutationFailure('Watchlist update', e);
  }
}

export async function removeWatchlistCore(
  ticker: string,
): Promise<Result<{ ticker: string; removed: number }>> {
  const v = normalizeTicker(ticker);
  if (!v.ok) return v;
  try {
    const res = await prisma.watchlist.deleteMany({ where: { ticker: v.ticker } });
    return { ok: true, ticker: v.ticker, removed: res.count };
  } catch (e) {
    return mutationFailure('Watchlist removal', e);
  }
}
