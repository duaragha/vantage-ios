'use server';

import { revalidatePath } from 'next/cache';
import { PositionLotSource, Prisma, prisma, recomputePositionFromLots } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';
import { parsePositionLotInput, type PositionLotInput } from '@/lib/positionLotInput';

const log = componentLogger('web/actions/position-purchases');

export interface PurchaseActionResult {
  ok: boolean;
  error?: string;
}

async function authorized(): Promise<boolean> {
  return isAuthed();
}

function validId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function refreshPosition(ticker: string): void {
  revalidatePath('/portfolio');
  revalidatePath('/accounts');
  revalidatePath(`/positions/${ticker}`);
}

export async function createPurchaseLot(
  positionId: number,
  ticker: string,
  input: PositionLotInput,
): Promise<PurchaseActionResult> {
  if (!(await authorized())) return { ok: false, error: 'unauthorized' };
  if (!validId(positionId)) return { ok: false, error: 'invalid position id' };
  const parsed = parsePositionLotInput(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.acquiredAtDate === null) {
    return { ok: false, error: 'purchase date is required' };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const position = await tx.position.findUnique({
        where: { id: positionId },
        select: { id: true, ticker: true, closedAt: true },
      });
      if (!position || position.ticker !== ticker.toUpperCase()) {
        throw new Error('position not found');
      }
      if (position.closedAt) throw new Error('closed positions cannot receive purchases');
      await tx.positionLot.create({
        data: {
          positionId,
          shares: new Prisma.Decimal(parsed.value.shares),
          costPerShare: new Prisma.Decimal(parsed.value.costPerShare),
          acquiredAt: parsed.value.acquiredAtDate,
          note: parsed.value.note,
          source: PositionLotSource.Manual,
        },
      });
      await recomputePositionFromLots(positionId, tx);
    });
    refreshPosition(ticker);
    return { ok: true };
  } catch (err) {
    log.error({ err, positionId }, 'create purchase lot failed');
    return {
      ok: false,
      error:
        err instanceof Error && /closed positions|not found/.test(err.message)
          ? err.message
          : 'purchase could not be added',
    };
  }
}

export async function updatePurchaseLot(
  lotId: number,
  positionId: number,
  ticker: string,
  input: PositionLotInput,
): Promise<PurchaseActionResult> {
  if (!(await authorized())) return { ok: false, error: 'unauthorized' };
  if (!validId(lotId) || !validId(positionId)) return { ok: false, error: 'invalid lot id' };
  const parsed = parsePositionLotInput(input);
  if (!parsed.ok) return parsed;

  try {
    await prisma.$transaction(async (tx) => {
      const lot = await tx.positionLot.findFirst({
        where: { id: lotId, positionId, position: { ticker: ticker.toUpperCase() } },
        select: { id: true, disposedAt: true },
      });
      if (!lot) throw new Error('purchase lot not found');
      if (
        lot.disposedAt &&
        parsed.value.acquiredAtDate &&
        parsed.value.acquiredAtDate.getTime() > lot.disposedAt.getTime()
      ) {
        throw new Error('purchase date cannot be after the holding was closed');
      }
      await tx.positionLot.update({
        where: { id: lotId },
        data: {
          shares: new Prisma.Decimal(parsed.value.shares),
          costPerShare: new Prisma.Decimal(parsed.value.costPerShare),
          acquiredAt: parsed.value.acquiredAtDate,
          note: parsed.value.note,
        },
      });
      if (!lot.disposedAt) await recomputePositionFromLots(positionId, tx);
    });
    refreshPosition(ticker);
    return { ok: true };
  } catch (err) {
    log.error({ err, lotId, positionId }, 'update purchase lot failed');
    return {
      ok: false,
      error:
        err instanceof Error && /not found|cannot be after/.test(err.message)
          ? err.message
          : 'purchase could not be updated',
    };
  }
}

export async function deletePurchaseLot(
  lotId: number,
  positionId: number,
  ticker: string,
): Promise<PurchaseActionResult> {
  if (!(await authorized())) return { ok: false, error: 'unauthorized' };
  if (!validId(lotId) || !validId(positionId)) return { ok: false, error: 'invalid lot id' };

  try {
    await prisma.$transaction(async (tx) => {
      const lot = await tx.positionLot.findFirst({
        where: { id: lotId, positionId, position: { ticker: ticker.toUpperCase() } },
        select: { id: true, disposedAt: true },
      });
      if (!lot) throw new Error('purchase lot not found');
      if (!lot.disposedAt) {
        const activeCount = await tx.positionLot.count({
          where: { positionId, disposedAt: null },
        });
        if (activeCount <= 1) throw new Error('a holding must keep at least one active purchase');
      }
      await tx.positionLot.delete({ where: { id: lotId } });
      if (!lot.disposedAt) await recomputePositionFromLots(positionId, tx);
    });
    refreshPosition(ticker);
    return { ok: true };
  } catch (err) {
    log.error({ err, lotId, positionId }, 'delete purchase lot failed');
    return {
      ok: false,
      error:
        err instanceof Error && err.message.includes('at least one active purchase')
          ? err.message
          : 'purchase could not be removed',
    };
  }
}
