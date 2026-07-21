/**
 * Watchlist server actions.
 */

'use server';

import { revalidatePath } from 'next/cache';
import { addWatchlistCore, removeWatchlistCore } from '@/lib/goalMutations';

export async function addWatchlist(
  ticker: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await addWatchlistCore(ticker, reason, 'user');
  if (res.ok) revalidatePath('/watchlist');
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function removeWatchlist(
  ticker: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await removeWatchlistCore(ticker);
  if (res.ok) revalidatePath('/watchlist');
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
