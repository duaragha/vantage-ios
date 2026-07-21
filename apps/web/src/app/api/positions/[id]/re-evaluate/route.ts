/**
 * POST /api/positions/:id/re-evaluate — smart endpoint.
 *
 * If the position has no thesis yet: bootstrap it (30d news + 2q filings +
 * synthesize pillars) then immediately evaluate. If a thesis exists: just
 * re-evaluate against the latest article window.
 *
 * One button on the UI, handles both cold-start and running-position cases.
 */

import { NextResponse } from 'next/server';
import { callWorker } from '@/lib/worker';
import { prisma } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';

export const runtime = 'nodejs';
const log = componentLogger('web/api/positions/re-evaluate');

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
    const position = await prisma.position.findUnique({
      where: { id: idNum },
      select: { ticker: true, thesis: { select: { id: true } } },
    });
    if (!position) {
      return NextResponse.json({ error: 'position not found' }, { status: 404 });
    }

    // No thesis yet: bootstrap, which also runs an initial evaluation.
    if (!position.thesis) {
      const res = await callWorker<{ result: unknown }>(
        `/jobs/bootstrap/${encodeURIComponent(position.ticker)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        log.warn(
          { positionId: idNum, status: res.status, workerError: res.error },
          'bootstrap failed',
        );
        return NextResponse.json({ error: 'position evaluation unavailable' }, { status: 502 });
      }
      return NextResponse.json({ mode: 'bootstrap', result: res.data });
    }

    // Existing thesis: plain re-evaluate.
    const res = await callWorker(`/jobs/thesis/evaluate/${idNum}`, {
      method: 'POST',
    });
    if (!res.ok) {
      log.warn(
        { positionId: idNum, status: res.status, workerError: res.error },
        'evaluation failed',
      );
      return NextResponse.json({ error: 'position evaluation unavailable' }, { status: 502 });
    }
    return NextResponse.json({ mode: 'evaluate', result: res.data });
  } catch (err) {
    log.error({ err, positionId: idNum }, 'position re-evaluation failed');
    return NextResponse.json({ error: 'position evaluation unavailable' }, { status: 500 });
  }
}
