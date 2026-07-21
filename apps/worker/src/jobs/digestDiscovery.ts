/**
 * Discovery digest dispatch worker — Phase 15.
 *
 * Wraps `buildDiscoveryDigest` from @vantage/core, renders the result
 * with `formatDiscoveryDigestForTelegram`, and ships via @vantage/notify.
 *
 * Runs weekly (Saturday 10am America/Toronto) and on-demand via
 * POST /jobs/digest/discovery.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  buildDiscoveryDigest,
  formatDiscoveryDigestForTelegram,
  type BuildDiscoveryDigestResult,
} from '@vantage/core';
import { prisma, queueTelegramDelivery } from '@vantage/db';
import { sendSelfAlert } from '@vantage/notify';

export interface DiscoveryDispatchResult {
  insightsCreated: number;
  insightsIds: number[];
  summary: string;
  failedSources: string[];
  tokens: BuildDiscoveryDigestResult['tokens'];
  llmCallIds: number[];
  telegram: { ok: true; queued: true; deliveryId: number };
}

function deepLinkBase(): string {
  return process.env['DASHBOARD_BASE_URL'] ?? 'http://localhost:3000';
}

export async function runDiscoveryDigest(
  log: FastifyBaseLogger | Console = console,
): Promise<DiscoveryDispatchResult> {
  let digest: BuildDiscoveryDigestResult;
  try {
    digest = await buildDiscoveryDigest({ log });
  } catch (err) {
    void sendSelfAlert('error', 'Discovery digest build failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Re-hydrate the insights with their actionJson so the Telegram formatter
  // can pick the rotation icon for dual-ticker cards.
  const hydrated =
    digest.insights.length > 0
      ? await prisma.insight.findMany({
          where: { id: { in: digest.insights.map((i) => i.id) } },
          select: {
            id: true,
            kind: true,
            title: true,
            body: true,
            confidence: true,
            actionJson: true,
          },
        })
      : [];

  const markdown = formatDiscoveryDigestForTelegram(digest.summary, hydrated, {
    deepLinkBase: deepLinkBase(),
    failedSources: digest.failedSources,
  });

  const identity =
    digest.insights.length > 0
      ? `insights:${digest.insights.map((insight) => insight.id).join(',')}`
      : digest.llmCallIds.length > 0
        ? `llm:${digest.llmCallIds.join(',')}`
        : `hour:${new Date().toISOString().slice(0, 13)}`;
  const delivery = await queueTelegramDelivery({
    dedupeKey: `digest:discovery:${identity}`,
    text: markdown,
    parseMode: 'Markdown',
    disableWebPagePreview: true,
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
  });

  const base = {
    insightsCreated: digest.insights.length,
    insightsIds: digest.insights.map((i) => i.id),
    summary: digest.summary,
    failedSources: digest.failedSources,
    tokens: digest.tokens,
    llmCallIds: digest.llmCallIds,
  } as const;

  log.info?.(
    { deliveryId: delivery.id, insights: digest.insights.length },
    'discovery digest queued for Telegram delivery',
  );
  return {
    ...base,
    telegram: { ok: true, queued: true, deliveryId: delivery.id },
  };
}
