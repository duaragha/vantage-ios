import { NextResponse } from 'next/server';
import { componentLogger } from '@vantage/notify';
import { loadCompareData } from '../../(dashboard)/compare/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const log = componentLogger('web/api/compare');

export async function GET(): Promise<Response> {
  try {
    const data = await loadCompareData();
    return NextResponse.json(
      {
        computedAt: data.computedAt,
        heldCount: data.heldCount,
        unheldCount: data.unheldCount,
        holdings: data.rows.filter((r) => r.held),
        discovered: data.rows.filter((r) => !r.held),
        topSwaps: data.swaps,
      },
      { status: 200 },
    );
  } catch (err) {
    log.error({ err }, 'compare API failed');
    return NextResponse.json({ error: 'compare data unavailable' }, { status: 500 });
  }
}
