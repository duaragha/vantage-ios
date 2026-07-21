import { NextResponse } from 'next/server';
import { prisma } from '@vantage/db';
import { componentLogger } from '@vantage/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const log = componentLogger('web/api/backtest/id');

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  try {
    const row = await prisma.backtestRun.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(row);
  } catch (err) {
    log.error({ err, backtestId: id }, 'backtest read failed');
    return NextResponse.json({ error: 'backtest unavailable' }, { status: 500 });
  }
}
