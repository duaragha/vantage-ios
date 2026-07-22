import { Prisma, type Position, type PositionLot } from '@prisma/client';
import { prisma } from './client.js';

type DecimalInput = Prisma.Decimal | number | string;

export interface PositionLotAggregate {
  shares: Prisma.Decimal;
  avgCost: Prisma.Decimal;
}

type AggregateLot = Pick<PositionLot, 'shares' | 'costPerShare' | 'disposedAt'>;

/** Compute the current holding snapshot from acquisition lots that remain active. */
export function aggregateActivePositionLots(
  lots: ReadonlyArray<
    | AggregateLot
    | {
        shares: DecimalInput;
        costPerShare: DecimalInput;
        disposedAt?: Date | null;
      }
  >,
): PositionLotAggregate | null {
  let shares = new Prisma.Decimal(0);
  let cost = new Prisma.Decimal(0);

  for (const lot of lots) {
    if (lot.disposedAt) continue;
    const lotShares = new Prisma.Decimal(lot.shares);
    const lotCost = new Prisma.Decimal(lot.costPerShare);
    if (lotShares.lessThanOrEqualTo(0)) throw new Error('position lot shares must be positive');
    if (lotCost.lessThan(0)) throw new Error('position lot cost must be nonnegative');
    shares = shares.plus(lotShares);
    cost = cost.plus(lotShares.mul(lotCost));
  }

  if (shares.lessThanOrEqualTo(0)) return null;
  return { shares, avgCost: cost.div(shares) };
}

type PositionLotClient = Pick<Prisma.TransactionClient, 'position' | 'positionLot'>;

/** Re-materialize Position.shares/avgCost after a lot mutation. */
export async function recomputePositionFromLots(
  positionId: number,
  client: PositionLotClient = prisma,
): Promise<Position> {
  const lots = await client.positionLot.findMany({
    where: { positionId, disposedAt: null },
    select: { shares: true, costPerShare: true, disposedAt: true },
  });
  const aggregate = aggregateActivePositionLots(lots);
  if (!aggregate) throw new Error('an open position must have at least one active purchase lot');
  return client.position.update({
    where: { id: positionId },
    data: { shares: aggregate.shares, avgCost: aggregate.avgCost },
  });
}

/** Soft-close the holding and its active lots in one transaction. */
export function closePositionWithLots(id: number, closedAt: Date = new Date()): Promise<Position> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.position.update({ where: { id }, data: { closedAt } });
    await tx.positionLot.updateMany({
      where: { positionId: id, disposedAt: null },
      data: { disposedAt: closedAt },
    });
    return row;
  });
}
