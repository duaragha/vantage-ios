/**
 * POST /api/positions/:id/close — soft-close a position.
 */

import { NextResponse } from 'next/server';
import { closePosition } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';

export const runtime = 'nodejs';
const log = componentLogger('web/api/positions/close');

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
    const row = await closePosition(idNum);
    return NextResponse.json({ ok: true, id: row.id, ticker: row.ticker });
  } catch (err) {
    log.error({ err, positionId: idNum }, 'close position failed');
    return NextResponse.json({ error: 'could not close position' }, { status: 500 });
  }
}
