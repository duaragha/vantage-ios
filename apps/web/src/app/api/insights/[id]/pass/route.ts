/**
 * POST /api/insights/:id/pass — mark insight Passed + create a PassCooldown.
 */

import { NextResponse } from 'next/server';
import {
  getSettings,
  markInsightStatus,
  prisma,
  setPassCooldown,
  type CooldownActionKind,
} from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';
import { normalizeInsightAction } from '@/lib/insightActions';

export const runtime = 'nodejs';
const log = componentLogger('web/api/insights/pass');

const ACTION_KINDS: readonly CooldownActionKind[] = ['buy', 'trim', 'rotate'];

function isCooldownKind(v: unknown): v is CooldownActionKind {
  return typeof v === 'string' && ACTION_KINDS.includes(v as CooldownActionKind);
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  try {
    const insight = await prisma.insight.findUnique({ where: { id: idNum } });
    if (!insight) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const action = normalizeInsightAction(insight.actionJson);
    const ticker = action?.ticker ?? null;
    const actionKind: CooldownActionKind =
      action?.type === 'rebalance' && (action.action === 'trim' || action.action === 'exit')
        ? 'trim'
        : isCooldownKind(action?.action)
          ? action.action
          : isCooldownKind(action?.type)
            ? action.type
            : 'buy';

    const settings = await getSettings();
    const days = settings?.passCooldownDays ?? 14;
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    // Rotation detection — when actionJson.type === 'rotation', cooldown BOTH
    // the trim side and the buy side so a passed rotation doesn't resurface
    // on either leg.
    const isRotation = action?.type === 'rotation';
    const trimTicker = action?.trimTicker ?? null;
    const buyTicker = action?.buyTicker ?? null;

    const sides: Array<{ ticker: string; kind: CooldownActionKind }> = [];
    if (isRotation) {
      if (trimTicker) sides.push({ ticker: trimTicker, kind: 'trim' });
      if (buyTicker) sides.push({ ticker: buyTicker, kind: 'buy' });
    } else if (ticker) {
      sides.push({ ticker, kind: actionKind });
    }

    for (const side of sides) {
      await setPassCooldown({
        ticker: side.ticker,
        actionKind: side.kind,
        until,
        insightId: idNum,
      });
    }

    const row = await markInsightStatus(idNum, 'Passed');
    return NextResponse.json({
      ok: true,
      id: row.id,
      status: row.status,
      cooldownUntil: sides.length > 0 ? until.toISOString() : null,
      ticker,
      actionKind,
      rotation: isRotation ? { trimTicker, buyTicker, cooldownSides: sides.length } : null,
    });
  } catch (err) {
    log.error({ err, insightId: idNum }, 'pass insight failed');
    return NextResponse.json({ error: 'could not update insight' }, { status: 500 });
  }
}
