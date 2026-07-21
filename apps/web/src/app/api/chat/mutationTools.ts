/**
 * Chat mutation tools — Anthropic tool definitions + a server-side dispatcher
 * that turns a `tool_use` block into a Prisma write (or a confirm preview).
 *
 * The chat loop in route.ts already satisfied the client-side `news_search`
 * (Tavily) tool by appending a tool_result; these mutation tools plug into the
 * same loop. All writes go through the shared cores in lib/goalMutations.ts, so
 * validation + the confirm-before-write gate are identical to the form surface.
 *
 * Confirm-before-write is enforced HERE, server-side: for the modify/remove
 * tools the core returns a `status: 'preview'` (no DB write) unless the model
 * passes `confirm: true`. The system prompt tells the model to call once without
 * confirm, show the user the diff, then call again with confirm:true — but even
 * if it ignores that, nothing mutates without the explicit second call.
 *
 * Schemas are hand-written JSON Schema (matching packages/llm/src/tools.ts) to
 * keep the package dependency-light; the cores re-validate every field.
 */

import { componentLogger } from '@vantage/notify';
import {
  createGoalCore,
  updateGoalCore,
  archiveGoalCore,
  linkPositionCore,
  unlinkPositionCore,
  setContributionCore,
  addWatchlistCore,
  removeWatchlistCore,
  loadCurrentGoalState,
  type GoalInputForm,
  type ContributionFrequencyValue,
} from '@/lib/goalMutations';

const log = componentLogger('web/api/chat/mutations');

// ---------------------------------------------------------------------------
// Tool definitions (concise — every byte rides in the per-call tools block)
// ---------------------------------------------------------------------------

const GOAL_TYPE_ENUM = [
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
const FREQ_ENUM = ['Weekly', 'Biweekly', 'Monthly', 'Quarterly'];
const RISK_ENUM = ['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive'];
const STRATEGY_ENUM = ['Income', 'Growth', 'Balanced', 'Preservation'];
const STYLE_ENUM = ['Momentum', 'Breakout', 'ORB', 'MeanReversion', 'Scalping'];

/**
 * Structural tool-definition type — the shape Anthropic's Messages API expects
 * for a client-side tool. Declared locally so this file (in apps/web) doesn't
 * need a direct @anthropic-ai/sdk dependency; callClaude type-checks the array
 * at the call boundary in route.ts.
 */
interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const obj = (properties: Record<string, unknown>, required: string[]): ToolDef['input_schema'] => ({
  type: 'object',
  properties,
  required,
});

const CONFIRM_PROP = {
  confirm: {
    type: 'boolean',
    description: 'Leave false to preview the change; only set true after the user agrees.',
  },
};

export const MUTATION_TOOLS: ToolDef[] = [
  {
    name: 'create_goal',
    description:
      'Create a new financial goal. Executes directly (additive). For DayTrading goals you may pass tradingStyle; for buy-and-hold goals you may pass a contribution (DCA) schedule.',
    input_schema: obj(
      {
        name: { type: 'string' },
        type: { type: 'string', enum: GOAL_TYPE_ENUM },
        targetAmountCad: { type: 'number' },
        targetDate: { type: 'string', description: 'ISO date (YYYY-MM-DD), optional' },
        riskOverride: { type: 'string', enum: RISK_ENUM },
        strategy: { type: 'string', enum: STRATEGY_ENUM },
        tradingStyle: { type: 'string', enum: STYLE_ENUM, description: 'DayTrading only' },
        contributionAmountCad: { type: 'number' },
        contributionFrequency: { type: 'string', enum: FREQ_ENUM },
        contributionStartDate: { type: 'string', description: 'ISO date, optional' },
      },
      ['name', 'type', 'targetAmountCad'],
    ),
  },
  {
    name: 'update_goal',
    description:
      'Edit an existing goal. Confirm-before-write: call first WITHOUT confirm to get a before→after preview, show it, then call again with confirm:true.',
    input_schema: obj(
      {
        goalId: { type: 'number' },
        name: { type: 'string' },
        type: { type: 'string', enum: GOAL_TYPE_ENUM },
        targetAmountCad: { type: 'number' },
        targetDate: { type: ['string', 'null'], description: 'ISO date, or null to clear' },
        riskOverride: { type: ['string', 'null'], enum: [...RISK_ENUM, null] },
        strategy: { type: ['string', 'null'], enum: [...STRATEGY_ENUM, null] },
        tradingStyle: { type: ['string', 'null'], enum: [...STYLE_ENUM, null] },
        ...CONFIRM_PROP,
      },
      ['goalId'],
    ),
  },
  {
    name: 'archive_goal',
    description:
      'Soft-archive a goal (recoverable; never deletes). Confirm-before-write: preview first, then confirm:true.',
    input_schema: obj({ goalId: { type: 'number' }, ...CONFIRM_PROP }, ['goalId']),
  },
  {
    name: 'link_position_to_goal',
    description:
      'Link a holding to a goal at an allocation fraction (0–1). Confirm-before-write: preview first, then confirm:true. Warns if the position is over-allocated across goals.',
    input_schema: obj(
      {
        goalId: { type: 'number' },
        positionId: { type: 'number' },
        allocationPct: { type: 'number', description: 'Fraction 0–1 (e.g. 0.5 = 50%)' },
        ...CONFIRM_PROP,
      },
      ['goalId', 'positionId', 'allocationPct'],
    ),
  },
  {
    name: 'unlink_position_from_goal',
    description:
      'Remove a holding from a goal. Confirm-before-write: preview first, then confirm:true.',
    input_schema: obj(
      { goalId: { type: 'number' }, positionId: { type: 'number' }, ...CONFIRM_PROP },
      ['goalId', 'positionId'],
    ),
  },
  {
    name: 'set_goal_contribution',
    description:
      "Set a goal's recurring DCA contribution schedule. Confirm-before-write: preview first, then confirm:true. Not valid for DayTrading goals.",
    input_schema: obj(
      {
        goalId: { type: 'number' },
        amount: { type: 'number' },
        frequency: { type: 'string', enum: FREQ_ENUM },
        startDate: { type: 'string', description: 'ISO date, optional' },
        ...CONFIRM_PROP,
      },
      ['goalId', 'amount', 'frequency'],
    ),
  },
  {
    name: 'add_watchlist',
    description: 'Add a ticker to the watchlist. Executes directly.',
    input_schema: obj({ ticker: { type: 'string' } }, ['ticker']),
  },
  {
    name: 'remove_watchlist',
    description: 'Remove a ticker from the watchlist. Executes directly (reversible).',
    input_schema: obj({ ticker: { type: 'string' } }, ['ticker']),
  },
];

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(MUTATION_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Build the optional-field patch for create/update, only including keys the
 * model actually supplied so undefined-vs-null semantics in the cores hold.
 */
function pickGoalPatch(input: Json): Partial<GoalInputForm> {
  const patch: Partial<GoalInputForm> = {};
  if ('name' in input) patch.name = String(input['name']);
  if ('type' in input) patch.type = input['type'] as GoalInputForm['type'];
  if ('targetAmountCad' in input) patch.targetAmountCad = asNum(input['targetAmountCad']) as number;
  if ('targetDate' in input) patch.targetDate = (input['targetDate'] ?? null) as string | null;
  if ('riskOverride' in input)
    patch.riskOverride = (input['riskOverride'] ?? null) as GoalInputForm['riskOverride'];
  if ('strategy' in input)
    patch.strategy = (input['strategy'] ?? null) as GoalInputForm['strategy'];
  if ('tradingStyle' in input)
    patch.tradingStyle = (input['tradingStyle'] ?? null) as GoalInputForm['tradingStyle'];
  return patch;
}

/**
 * Log a chat-initiated mutation. Structured server log only (no new table per
 * spec). `before`/`after` are the diff so the change is fully auditable.
 */
function logMutation(tool: string, outcome: { status?: string; ok: boolean }, detail: Json): void {
  log.info(
    {
      event: 'chat-mutation',
      tool,
      status: outcome.status ?? (outcome.ok ? 'ok' : 'error'),
      ...detail,
    },
    `chat mutation ${tool} → ${outcome.status ?? (outcome.ok ? 'ok' : 'error')}`,
  );
}

export interface MutationToolResult {
  json: Json;
  isError: boolean;
}

/**
 * Execute one mutation tool_use. Returns the JSON payload to send back as the
 * tool_result content + whether it should be flagged is_error. Throws nothing —
 * all failures come back as `{ ok: false, error }` so the model can recover.
 */
export async function handleMutationTool(
  name: string,
  rawInput: unknown,
): Promise<MutationToolResult> {
  const input = (rawInput ?? {}) as Json;
  const confirm = input['confirm'] === true;

  try {
    switch (name) {
      case 'create_goal': {
        const goalName = asStr(input['name']);
        const type = input['type'] as GoalInputForm['type'] | undefined;
        const targetAmountCad = asNum(input['targetAmountCad']);
        if (!goalName || !type || targetAmountCad === undefined) {
          return err('create_goal requires name, type, and targetAmountCad.');
        }
        const formInput: GoalInputForm = {
          name: goalName,
          type,
          targetAmountCad,
          targetDate: asStr(input['targetDate']) ?? null,
          isWithdrawal: false,
          riskOverride: (input['riskOverride'] ?? null) as GoalInputForm['riskOverride'],
          strategy: (input['strategy'] ?? null) as GoalInputForm['strategy'],
          tradingStyle: (input['tradingStyle'] ?? null) as GoalInputForm['tradingStyle'],
          contributionAmountCad: asNum(input['contributionAmountCad']) ?? null,
          contributionFrequency: (input['contributionFrequency'] ??
            null) as ContributionFrequencyValue | null,
          contributionStartDate: asStr(input['contributionStartDate']) ?? null,
        };
        const res = await createGoalCore(formInput);
        logMutation('create_goal', res, {
          goalName,
          type,
          targetAmountCad,
          ...(res.ok ? { goalId: res.id } : { error: res.error }),
        });
        return res.ok ? ok({ created: true, goalId: res.id, name: goalName }) : err(res.error);
      }

      case 'update_goal': {
        const goalId = asNum(input['goalId']);
        if (goalId === undefined) return err('update_goal requires goalId.');
        const patch = pickGoalPatch(input);
        const res = await updateGoalCore(goalId, patch, confirm);
        logMutation('update_goal', res, {
          goalId,
          confirm,
          diff: 'diff' in res ? res.diff : undefined,
          ...(res.ok ? {} : { error: res.error }),
        });
        return toolResult(res);
      }

      case 'archive_goal': {
        const goalId = asNum(input['goalId']);
        if (goalId === undefined) return err('archive_goal requires goalId.');
        const res = await archiveGoalCore(goalId, confirm);
        logMutation('archive_goal', res, {
          goalId,
          confirm,
          ...(res.ok ? {} : { error: res.error }),
        });
        return toolResult(res);
      }

      case 'link_position_to_goal': {
        const goalId = asNum(input['goalId']);
        const positionId = asNum(input['positionId']);
        const allocationPct = asNum(input['allocationPct']);
        if (goalId === undefined || positionId === undefined || allocationPct === undefined) {
          return err('link_position_to_goal requires goalId, positionId, allocationPct.');
        }
        const res = await linkPositionCore(goalId, positionId, allocationPct, confirm);
        logMutation('link_position_to_goal', res, {
          goalId,
          positionId,
          allocationPct,
          confirm,
          ...(res.ok ? {} : { error: res.error }),
        });
        if (res.ok && res.status === 'written') {
          return ok({
            linked: true,
            overAllocated: res.overAllocated,
            totalAllocation: res.totalAllocation,
            ...(res.overAllocated
              ? {
                  warning: `This position is now allocated ${Math.round(res.totalAllocation * 100)}% across goals (over 100%).`,
                }
              : {}),
          });
        }
        return toolResult(res);
      }

      case 'unlink_position_from_goal': {
        const goalId = asNum(input['goalId']);
        const positionId = asNum(input['positionId']);
        if (goalId === undefined || positionId === undefined) {
          return err('unlink_position_from_goal requires goalId and positionId.');
        }
        const res = await unlinkPositionCore(goalId, positionId, confirm);
        logMutation('unlink_position_from_goal', res, {
          goalId,
          positionId,
          confirm,
          ...(res.ok ? {} : { error: res.error }),
        });
        return toolResult(res);
      }

      case 'set_goal_contribution': {
        const goalId = asNum(input['goalId']);
        const amount = asNum(input['amount']);
        const frequency = input['frequency'] as ContributionFrequencyValue | undefined;
        if (goalId === undefined || amount === undefined || !frequency) {
          return err('set_goal_contribution requires goalId, amount, frequency.');
        }
        const res = await setContributionCore(
          goalId,
          amount,
          frequency,
          asStr(input['startDate']) ?? null,
          confirm,
        );
        logMutation('set_goal_contribution', res, {
          goalId,
          amount,
          frequency,
          confirm,
          diff: 'diff' in res ? res.diff : undefined,
          ...(res.ok ? {} : { error: res.error }),
        });
        return toolResult(res);
      }

      case 'add_watchlist': {
        const ticker = asStr(input['ticker']);
        if (!ticker) return err('add_watchlist requires ticker.');
        const res = await addWatchlistCore(ticker, null, 'user');
        logMutation('add_watchlist', res, {
          ticker,
          ...(res.ok ? { normalized: res.ticker } : { error: res.error }),
        });
        return res.ok ? ok({ added: true, ticker: res.ticker }) : err(res.error);
      }

      case 'remove_watchlist': {
        const ticker = asStr(input['ticker']);
        if (!ticker) return err('remove_watchlist requires ticker.');
        const res = await removeWatchlistCore(ticker);
        logMutation('remove_watchlist', res, {
          ticker,
          ...(res.ok ? { removed: res.removed } : { error: res.error }),
        });
        return res.ok ? ok({ removed: res.removed > 0, ticker: res.ticker }) : err(res.error);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error({ event: 'chat-mutation-throw', tool: name, err: message }, 'mutation tool threw');
    return err('The requested change could not be completed.');
  }
}

// Map a ConfirmOutcome into the tool_result JSON. A preview is NOT an error —
// it's the intended "show the user, then confirm" path.
function toolResult(
  res:
    | { ok: true; status: 'preview'; diff: unknown; summary: string }
    | { ok: true; status: 'written'; diff?: unknown }
    | { ok: false; error: string },
): MutationToolResult {
  if (!res.ok) return err(res.error);
  if (res.status === 'preview') {
    return ok({
      status: 'preview',
      requiresConfirmation: true,
      summary: res.summary,
      diff: res.diff,
    });
  }
  return ok({ status: 'written', ...(res.diff ? { diff: res.diff } : {}) });
}

function ok(json: Json): MutationToolResult {
  return { json: { ok: true, ...json }, isError: false };
}
function err(error: string): MutationToolResult {
  return { json: { ok: false, error }, isError: true };
}

// Re-export so route.ts can surface goal IDs in a "what can I act on" hint if
// needed later; kept here to avoid a second import path.
export { loadCurrentGoalState };
