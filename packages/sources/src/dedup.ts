/**
 * Dedup cluster-key hasher.
 *
 * Produces a deterministic SHA-1 hex key so "same story from five outlets
 * within a ~6h window" collapses to a single cluster. The key is intentionally
 * coarse: ticker-anchored, time-bucketed, and whitespace/punctuation-insensitive
 * on the first 120 chars of the headline.
 *
 * Signature: sha1(normalize(headline.slice(0,120)) + roundTime(publishedAt,6h) + primaryTicker)
 */

import { createHash } from 'node:crypto';

/** Lowercase, strip punctuation (non-alphanumeric), collapse whitespace. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Floor a Date to the nearest N-hour boundary in UTC and return an ISO string.
 * E.g. roundTime(2026-04-19T14:37Z, 6) => '2026-04-19T12:00:00.000Z'.
 */
export function roundTime(date: Date, intervalHours: number): string {
  if (intervalHours <= 0 || !Number.isFinite(intervalHours)) {
    throw new Error('intervalHours must be > 0');
  }
  const intervalMs = intervalHours * 3_600_000;
  const floored = Math.floor(date.getTime() / intervalMs) * intervalMs;
  return new Date(floored).toISOString();
}

/**
 * Deterministic cluster key for an article.
 * Two articles with the same primary ticker, same 6-hour bucket, and
 * equivalent normalized headline prefix land in the same cluster.
 */
export function clusterKey(
  headline: string,
  publishedAt: Date,
  primaryTicker: string,
): string {
  const head = normalize(headline.slice(0, 120));
  const bucket = roundTime(publishedAt, 6);
  const ticker = primaryTicker.toUpperCase().trim();
  return createHash('sha1').update(`${head}|${bucket}|${ticker}`).digest('hex');
}
