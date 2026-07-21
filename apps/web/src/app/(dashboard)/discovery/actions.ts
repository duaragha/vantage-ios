/**
 * Discovery server actions — bootstrap proxy + recent-articles fetch.
 */

'use server';

import { prisma } from '@vantage/db';
import { callWorker } from '@/lib/worker';
import { componentLogger } from '@vantage/notify';

const log = componentLogger('web/actions/discovery');

/**
 * Proxy POST /jobs/bootstrap/:ticker to the worker using the server-side
 * worker secret — client never sees the secret.
 */
export async function bootstrapTickerAction(
  ticker: string,
): Promise<{ ok: boolean; error?: string; detail?: unknown }> {
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(normalized)) {
    return { ok: false, error: 'invalid ticker' };
  }
  const res = await callWorker(`/jobs/bootstrap/${normalized}`, {
    method: 'POST',
  });
  if (!res.ok) {
    log.warn({ status: res.status }, 'ticker bootstrap failed');
    return { ok: false, error: 'ticker bootstrap unavailable' };
  }
  return { ok: true, detail: res.data };
}

/**
 * Fetch 5 most-recent articles for a ticker — used by the discovery row's
 * "View news" expand toggle.
 */
export async function fetchRecentArticlesForTicker(
  ticker: string,
): Promise<Array<{ id: number; headline: string; publishedAt: string; source: string }>> {
  const normalized = ticker.trim().toUpperCase();
  if (!/^[A-Z.-]{1,8}$/.test(normalized)) return [];
  try {
    const rows = await prisma.article.findMany({
      where: {
        tickers: { has: normalized },
        satireBlocked: false,
      },
      orderBy: { publishedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        headline: true,
        publishedAt: true,
        source: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      headline: r.headline,
      publishedAt: r.publishedAt.toISOString(),
      source: r.source,
    }));
  } catch (err) {
    log.error({ err, ticker: normalized }, 'recent ticker articles failed');
    return [];
  }
}
