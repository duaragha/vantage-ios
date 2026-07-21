/**
 * Digest dispatch worker.
 *
 * Thin handler: call buildDigest() in @vantage/core, render the result
 * with formatDigestForTelegram, ship via @vantage/notify. Wrapped by
 * runJob() in routes/jobs.ts and cron.ts for idempotency.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  buildDigest,
  formatDigestForTelegram,
  type DigestKind,
  type DigestResult,
  type DigestKindLabel,
} from '@vantage/core';
import { queueTelegramDelivery } from '@vantage/db';
import { sendSelfAlert } from '@vantage/notify';

export interface DigestDispatchResult {
  kind: DigestKind;
  insightsCreated: number;
  insightsIds: number[];
  summary: string;
  failedSources: string[];
  tokens: DigestResult['tokens'];
  llmCallIds: number[];
  telegram: { ok: true; queued: true; deliveryId: number };
}

function deepLinkBase(): string {
  return process.env['DASHBOARD_BASE_URL'] ?? 'http://localhost:3000';
}

/**
 * Build the digest and persist its Telegram delivery. The dispatcher owns the
 * network attempt so transient failures cannot lose a completed digest.
 */
export async function runDigest(
  kind: DigestKind,
  log: FastifyBaseLogger | Console = console,
): Promise<DigestDispatchResult> {
  let digest: DigestResult;
  try {
    digest = await buildDigest(kind, { log });
  } catch (err) {
    // Digest build failed — fire a self-alert then rethrow so runJob records
    // the failure as a JobRun row.
    void sendSelfAlert('error', `Digest build failed: ${kind}`, {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const markdown = formatDigestForTelegram(
    kind as DigestKindLabel,
    digest.summary,
    digest.insights,
    {
      deepLinkBase: deepLinkBase(),
      failedSources: digest.failedSources,
    },
  );

  const delivery = await queueTelegramDelivery({
    dedupeKey: digestDeliveryKey(kind, digest),
    text: markdown,
    parseMode: 'Markdown',
    disableWebPagePreview: true,
    expiresAt: new Date(Date.now() + digestExpiryMs(kind)),
  });

  const baseResult = {
    kind,
    insightsCreated: digest.insights.length,
    insightsIds: digest.insights.map((i) => i.id),
    summary: digest.summary,
    failedSources: digest.failedSources,
    tokens: digest.tokens,
    llmCallIds: digest.llmCallIds,
  } as const;

  log.info?.(
    {
      kind,
      deliveryId: delivery.id,
      insights: digest.insights.length,
      failedSources: digest.failedSources,
    },
    'digest queued for Telegram delivery',
  );
  return {
    ...baseResult,
    telegram: { ok: true, queued: true, deliveryId: delivery.id },
  };
}

function digestDeliveryKey(kind: DigestKind, digest: DigestResult): string {
  const identity =
    digest.insights.length > 0
      ? `insights:${digest.insights.map((insight) => insight.id).join(',')}`
      : digest.llmCallIds.length > 0
        ? `llm:${digest.llmCallIds.join(',')}`
        : `hour:${new Date().toISOString().slice(0, 13)}`;
  return `digest:${kind}:${identity}`;
}

function digestExpiryMs(kind: DigestKind): number {
  if (kind === 'morning') return 12 * 60 * 60 * 1000;
  if (kind === 'evening') return 18 * 60 * 60 * 1000;
  return 3 * 24 * 60 * 60 * 1000;
}
