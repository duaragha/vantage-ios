'use server';

import { revalidatePath } from 'next/cache';
import { prisma, type AccountType } from '@vantage/db';
import {
  CURATED_POOL,
  deriveRiskTolerance,
  loadIncomeYieldOverrides,
  loadLatestDiscoveryScoresByTicker,
  loadTopDiscoveryPicks,
  recommendAccount,
  recommendSecurities,
  type GoalInput,
} from '@vantage/core/goals';
import { loadAccountSummaries } from '@vantage/core/accounts';
import { callClaude, HAIKU_MODEL } from '@vantage/llm';
import {
  createGoalCore,
  updateGoalCore,
  archiveGoalCore,
  linkPositionCore,
  unlinkPositionCore,
  normalizeGoalCreate,
  type GoalInputForm as GoalMutationInput,
} from '@/lib/goalMutations';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/actions/goals');

// Re-export the canonical input shape so existing UI imports keep working.
export type GoalInputForm = GoalMutationInput;

function revalidateGoals(id?: number): void {
  revalidatePath('/goals');
  if (id !== undefined) revalidatePath(`/goals/${id}`);
  revalidatePath('/portfolio');
}

export async function createGoal(
  input: GoalInputForm,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const res = await createGoalCore(input);
  if (res.ok) revalidateGoals();
  return res;
}

export async function updateGoal(
  id: number,
  input: Partial<GoalInputForm>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Server actions are the trusted form surface — confirm directly so the
  // form-edit UX is unchanged. The confirm gate is for the chat surface.
  const res = await updateGoalCore(id, input, true);
  if (!res.ok) return res;
  revalidateGoals(id);
  return { ok: true };
}

export async function archiveGoal(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await archiveGoalCore(id, true);
  if (!res.ok) return res;
  revalidateGoals(id);
  return { ok: true };
}

export async function unarchiveGoal(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await prisma.goal.update({ where: { id }, data: { archivedAt: null } });
    revalidatePath('/goals');
    revalidatePath(`/goals/${id}`);
    return { ok: true };
  } catch (e) {
    log.error({ err: e, goalId: id }, 'restore goal failed');
    return { ok: false, error: 'goal could not be restored' };
  }
}

export async function deleteGoal(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // Cascade clears GoalPosition + GoalSnapshot.
    await prisma.goal.delete({ where: { id } });
    revalidatePath('/goals');
    revalidatePath('/portfolio');
    return { ok: true };
  } catch (e) {
    log.error({ err: e, goalId: id }, 'delete goal failed');
    return { ok: false, error: 'goal could not be deleted' };
  }
}

export async function linkPositionToGoal(
  positionId: number,
  goalId: number,
  allocation: number = 1.0,
): Promise<
  { ok: true; overAllocated: boolean; totalAllocation: number } | { ok: false; error: string }
> {
  const res = await linkPositionCore(goalId, positionId, allocation, true);
  if (!res.ok) return res;
  if (res.status !== 'written') return { ok: false, error: 'unexpected preview' };
  revalidateGoals(goalId);
  return { ok: true, overAllocated: res.overAllocated, totalAllocation: res.totalAllocation };
}

export async function unlinkPositionFromGoal(
  positionId: number,
  goalId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await unlinkPositionCore(goalId, positionId, true);
  if (!res.ok) return res;
  revalidateGoals(goalId);
  return { ok: true };
}

export async function updateAllocation(
  positionId: number,
  goalId: number,
  allocation: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return linkPositionToGoal(positionId, goalId, allocation);
}

export interface SuggestForGoalResult {
  account: {
    rankedTypes: string[];
    bestAccountId: number | null;
    bestAccountName: string | null;
    rationale: string;
    warning?: string;
  };
  securities: Array<{
    ticker: string;
    name: string;
    currency: 'CAD' | 'USD';
    reason: string;
    fitScore: number;
  }>;
}

// ---------------------------------------------------------------------------
// AI questionnaire helper — Haiku-backed 3-question mapper to (strategy,
// riskOverride, isWithdrawal). Tax handling stays AUTOMATIC inside the engine;
// the system prompt explicitly forbids any tax discussion in the response.
// ---------------------------------------------------------------------------

export interface SuggestGoalStrategyAnswers {
  purpose: string;
  volatility: string;
  dateStrictness: string;
}

export interface SuggestGoalStrategyResult {
  strategy: 'Income' | 'Growth' | 'Balanced' | 'Preservation';
  riskOverride: 'VeryLow' | 'Low' | 'Moderate' | 'High' | 'Aggressive' | null;
  isWithdrawal: boolean;
  rationale: string;
}

const STRATEGY_VALUES = new Set(['Income', 'Growth', 'Balanced', 'Preservation']);
const RISK_VALUES = new Set(['VeryLow', 'Low', 'Moderate', 'High', 'Aggressive']);

function fallbackStrategy(reason: string): SuggestGoalStrategyResult {
  return { strategy: 'Balanced', riskOverride: null, isWithdrawal: false, rationale: reason };
}

export async function suggestGoalStrategy(
  answers: SuggestGoalStrategyAnswers,
): Promise<SuggestGoalStrategyResult> {
  const purpose = (answers.purpose ?? '').trim().slice(0, 1000);
  const volatility = (answers.volatility ?? '').trim().slice(0, 1000);
  const dateStrictness = (answers.dateStrictness ?? '').trim().slice(0, 1000);

  if (!purpose && !volatility && !dateStrictness) {
    return fallbackStrategy('No answers provided — defaulting to Balanced.');
  }

  const system =
    'You map 3 questionnaire answers to a goal strategy + risk override. ' +
    'Return JSON only: { strategy, riskOverride, isWithdrawal, rationale }. ' +
    'strategy ∈ {Income, Growth, Balanced, Preservation}. ' +
    'riskOverride ∈ {VeryLow, Low, Moderate, High, Aggressive} or null. ' +
    'isWithdrawal is a boolean (true if the user intends to spend down toward the target date). ' +
    'rationale is a short (≤2 sentence) plain-English explanation, no markdown. ' +
    'Do not include any tax discussion — tax is handled automatically by the engine. ' +
    'Output JSON only with no surrounding prose.';
  const userContent = `\nQ1 (purpose): ${purpose}\nQ2 (volatility): ${volatility}\nQ3 (date strictness): ${dateStrictness}`;

  let raw = '';
  try {
    const result = await callClaude({
      model: HAIKU_MODEL,
      system,
      messages: [{ role: 'user', content: userContent }],
      maxTokens: 256,
      purpose: 'chat',
    });
    for (const block of result.response.content) {
      if (block.type === 'text') raw += block.text;
    }
  } catch (err) {
    log.error({ err }, 'goal strategy helper failed');
    return fallbackStrategy("Couldn't reach the strategy helper — defaulting to Balanced.");
  }

  // Extract JSON — model may wrap with prose or code fences despite instructions.
  const jsonText = extractJson(raw);
  if (!jsonText) return fallbackStrategy("Couldn't parse — defaulting to Balanced.");

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const strategy = String(parsed.strategy ?? '');
    if (!STRATEGY_VALUES.has(strategy)) {
      return fallbackStrategy("Couldn't parse — defaulting to Balanced.");
    }
    const riskRaw = parsed.riskOverride;
    const riskOverride =
      riskRaw === null || riskRaw === undefined || !RISK_VALUES.has(String(riskRaw))
        ? null
        : (String(riskRaw) as SuggestGoalStrategyResult['riskOverride']);
    const isWithdrawal = parsed.isWithdrawal === true;
    const rationale =
      typeof parsed.rationale === 'string' && parsed.rationale.length > 0
        ? parsed.rationale.slice(0, 400)
        : 'Suggestion based on your answers.';
    return {
      strategy: strategy as SuggestGoalStrategyResult['strategy'],
      riskOverride,
      isWithdrawal,
      rationale,
    };
  } catch {
    return fallbackStrategy("Couldn't parse — defaulting to Balanced.");
  }
}

/** Pull the first JSON object out of a model response, tolerating code fences + leading prose. */
function extractJson(text: string): string | null {
  if (!text) return null;
  // Strip code fences if any.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenceMatch ? fenceMatch[1]! : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

export async function suggestForGoal(input: GoalInputForm): Promise<SuggestForGoalResult> {
  const v = normalizeGoalCreate(input);
  if (!v.ok) {
    return {
      account: { rankedTypes: [], bestAccountId: null, bestAccountName: null, rationale: v.error },
      securities: [],
    };
  }
  const goalInput: GoalInput = {
    id: 0,
    name: v.data.name,
    type: v.data.type,
    targetAmountCad: Number(v.data.targetAmountCad),
    targetDate: v.data.targetDate,
    isWithdrawal: v.data.isWithdrawal,
    riskOverride: v.data.riskOverride ?? null,
    strategy: v.data.strategy ?? null,
    tradingStyle: v.data.tradingStyle ?? null,
    accountId: v.data.accountId ?? null,
  };
  const accounts = await loadAccountSummaries();
  const recAccount = recommendAccount(goalInput, accounts);
  const best = recAccount.bestAccountId
    ? await prisma.account.findUnique({
        where: { id: recAccount.bestAccountId },
        select: { id: true, name: true, type: true },
      })
    : null;
  const effectiveAccountType = (best?.type ?? recAccount.rankedTypes[0]) as AccountType | undefined;
  const risk = deriveRiskTolerance(goalInput);
  const wantsDiscovery = risk === 'High' || risk === 'Aggressive';
  const curatedTickers = CURATED_POOL.map((security) => security.ticker);
  const [discoveryPicks, discoveryScoreByTicker, incomeYieldByTicker] = await Promise.all([
    wantsDiscovery
      ? loadTopDiscoveryPicks({
          limit: 8,
          excludeTickers: curatedTickers,
          risk,
          ...(effectiveAccountType ? { accountType: effectiveAccountType } : {}),
          ...(goalInput.strategy ? { strategy: goalInput.strategy } : {}),
        }).catch((err) => {
          log.warn({ err }, 'goal preview discovery picks unavailable; using curated pool');
          return [];
        })
      : Promise.resolve([]),
    loadLatestDiscoveryScoresByTicker(curatedTickers).catch((err) => {
      log.warn({ err }, 'goal preview discovery scores unavailable; using neutral scores');
      return {};
    }),
    loadIncomeYieldOverrides(curatedTickers).catch((err) => {
      log.warn({ err }, 'goal preview live yields unavailable; using reviewed estimates');
      return {};
    }),
  ]);
  const recSec = recommendSecurities(goalInput, {
    limit: wantsDiscovery ? 10 : 5,
    ...(effectiveAccountType ? { goalAccountType: effectiveAccountType } : {}),
    ...(discoveryPicks.length > 0 ? { discoveryPicks } : {}),
    ...(Object.keys(discoveryScoreByTicker).length > 0 ? { discoveryScoreByTicker } : {}),
    ...(Object.keys(incomeYieldByTicker).length > 0 ? { incomeYieldByTicker } : {}),
  });
  return {
    account: {
      rankedTypes: recAccount.rankedTypes,
      bestAccountId: recAccount.bestAccountId,
      bestAccountName: best ? best.name : null,
      rationale: recAccount.rationale,
      ...(recAccount.warning ? { warning: recAccount.warning } : {}),
    },
    securities: recSec.map((s) => ({
      ticker: s.security.ticker,
      name: s.security.name,
      currency: s.security.currency,
      reason: s.reason,
      fitScore: s.fitScore,
    })),
  };
}
