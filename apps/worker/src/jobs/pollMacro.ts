/**
 * Poll FRED macro series.
 *
 * Series: DGS10, FEDFUNDS, UNRATE, CPIAUCSL, VIXCLS.
 *
 * For each: pull latest observation (+previous). If the observation date or
 * value changed relative to the most recent Macro MarketEvent for that
 * series, write a new MarketEvent with `{ series, value, previousValue,
 * changePct }`. Dedup via payload.series + observationDate check against the
 * last 30 days of Macro events for the same series.
 */

import {
  prisma,
  createMarketEvent,
  EventKind,
  type Prisma,
} from '@vantage/db';
import { getFred } from '../lib/adapters.js';
import { FRED_SERIES, type FredShortcut } from '@vantage/sources';
import type { FastifyBaseLogger } from 'fastify';

export interface PollMacroResult {
  seriesChecked: number;
  changesDetected: number;
  failedSeries: string[];
}

const SERIES: FredShortcut[] = [
  'DGS10',
  'FEDFUNDS',
  'UNRATE',
  'CPIAUCSL',
  'VIXCLS',
  // Phase 16 — Canadian macro coverage.
  'DEXCAUS', // CAD per USD (daily). Drives FX conversion + rate signal for CA theses.
  'IRSTCI01CAM156N', // Canadian call-money rate (monthly) — BoC rate proxy.
];

export async function pollMacro(
  log: FastifyBaseLogger | Console = console,
): Promise<PollMacroResult> {
  const fred = getFred();
  let changes = 0;
  const failed: string[] = [];

  for (const series of SERIES) {
    const id = FRED_SERIES[series];
    try {
      // Request 2 latest obs so we can compute change.
      const points = await fred.getSeries(id, 2);
      if (points.length === 0) continue;
      const [latest, previous] = points; // desc order
      if (!latest || latest.value === null) continue;

      const ymdLatest = latest.date.toISOString().slice(0, 10);

      // Have we already emitted a Macro event for this series + date?
      const priorSame = await prisma.marketEvent.findFirst({
        where: {
          kind: EventKind.Macro,
          AND: [
            {
              payload: {
                path: ['series'],
                equals: id,
              },
            },
            {
              payload: {
                path: ['observationDate'],
                equals: ymdLatest,
              },
            },
          ],
        },
      });
      if (priorSame) continue;

      const prevValue = previous?.value ?? null;
      const changePct =
        prevValue !== null && prevValue !== 0
          ? Number(
              (((latest.value - prevValue) / Math.abs(prevValue)) * 100).toFixed(
                3,
              ),
            )
          : null;

      const payload: Prisma.InputJsonValue = {
        series: id,
        seriesShortcut: series,
        value: latest.value,
        previousValue: prevValue,
        changePct,
        observationDate: ymdLatest,
      };

      await createMarketEvent({
        kind: EventKind.Macro,
        ticker: null,
        occurredAt: latest.date,
        payload,
      });
      changes++;
    } catch (err) {
      log.warn?.(
        { series, err: err instanceof Error ? err.message : err },
        'fred poll failed for series',
      );
      failed.push(series);
    }
  }

  return {
    seriesChecked: SERIES.length,
    changesDetected: changes,
    failedSeries: failed,
  };
}
