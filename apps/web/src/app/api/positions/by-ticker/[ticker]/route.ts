/**
 * GET /api/positions/by-ticker/:ticker — returns a serialized Position + Thesis.
 * Used by the edit drawer on the position detail page.
 */

import { NextResponse } from 'next/server';
import { findPositionsByTicker, findThesisByPositionId } from '@vantage/db';
import { componentLogger } from '@vantage/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const log = componentLogger('web/api/positions/by-ticker');

export async function GET(
  req: Request,
  ctx: { params: Promise<{ ticker: string }> },
): Promise<Response> {
  const { ticker } = await ctx.params;
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(normalized)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const rawPositionId = new URL(req.url).searchParams.get('positionId');
  const requestedPositionId = rawPositionId ? Number(rawPositionId) : null;
  if (
    requestedPositionId !== null &&
    (!Number.isInteger(requestedPositionId) || requestedPositionId <= 0)
  ) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  try {
    const positions = await findPositionsByTicker(normalized);
    const position =
      requestedPositionId !== null
        ? positions.find((candidate) => candidate.id === requestedPositionId)
        : (positions.find((candidate) => candidate.closedAt === null) ?? positions[0]);
    if (!position) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const thesis = await findThesisByPositionId(position.id);
    return NextResponse.json({
      position: {
        ...position,
        shares: position.shares.toString(),
        avgCost: position.avgCost.toString(),
        stopLoss: position.stopLoss?.toString() ?? null,
        priceTarget: position.priceTarget?.toString() ?? null,
      },
      thesis: thesis
        ? {
            ...thesis,
            pillars: thesis.pillars,
            riskFactors: thesis.riskFactors,
          }
        : null,
    });
  } catch (err) {
    log.error({ err, ticker: normalized, positionId: requestedPositionId }, 'position read failed');
    return NextResponse.json({ error: 'position unavailable' }, { status: 500 });
  }
}
