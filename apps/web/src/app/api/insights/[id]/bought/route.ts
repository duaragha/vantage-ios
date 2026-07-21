/**
 * POST /api/insights/:id/bought — marks an insight as Bought.
 *
 * The actual Position creation happens via the PositionForm server action;
 * this endpoint is called from the form on successful submit to close the
 * loop on the feed.
 */

import { NextResponse } from 'next/server';
import { markInsightStatus } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';

export const runtime = 'nodejs';
const log = componentLogger('web/api/insights/bought');

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
    const row = await markInsightStatus(idNum, 'Bought');
    return NextResponse.json({ ok: true, id: row.id, status: row.status });
  } catch (err) {
    log.error({ err, insightId: idNum }, 'mark insight bought failed');
    return NextResponse.json({ error: 'could not update insight' }, { status: 500 });
  }
}
