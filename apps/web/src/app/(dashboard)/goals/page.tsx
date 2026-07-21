import * as React from 'react';
import { listGoals, loadGoalConflicts } from './data';
import { listAccounts } from '../accounts/data';
import { GoalsTable } from './GoalsTable';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ archived?: string }>;
}

export default async function GoalsPage({ searchParams }: PageProps): Promise<React.ReactElement> {
  const sp = await searchParams;
  const includeArchived = sp.archived === '1';
  let goals: Awaited<ReturnType<typeof listGoals>> = [];
  let accounts: Awaited<ReturnType<typeof listAccounts>> = [];
  let conflictResult: Awaited<ReturnType<typeof loadGoalConflicts>> = {
    conflicts: [],
    goalNames: new Map(),
  };
  let dbError: string | null = null;
  try {
    [goals, accounts, conflictResult] = await Promise.all([
      listGoals({ includeArchived }),
      listAccounts({ includeArchived: false }),
      loadGoalConflicts(),
    ]);
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  const { conflicts, goalNames } = conflictResult;
  const namesFor = (ids: number[]) =>
    ids
      .map((id) => goalNames.get(id))
      .filter((n): n is string => Boolean(n))
      .join(', ');

  return (
    <div className="cc-page space-y-6">
      <div>
        <h1 className="cc-page-title">Goals</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Set a target, get account + security recommendations, track progress.
        </p>
      </div>
      <DbErrorBanner message={dbError} />
      {conflicts.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-amber-300">
            Conflicts
          </div>
          <ul className="space-y-1.5 text-sm text-amber-200">
            {conflicts.map((c, i) => {
              const names = namesFor(c.goalIds);
              const label = names || `Goal IDs: ${c.goalIds.join(', ')}`;
              // Risk-vs-horizon override is a money-at-risk warning — render it in
              // rose so it reads as distinct from the (amber) coordination conflicts.
              const isRisk = c.kind === 'risk-horizon-override';
              return (
                <li
                  key={`${c.kind}-${i}`}
                  className={isRisk ? 'font-medium text-rose-300' : undefined}
                >
                  {c.message}
                  {c.goalIds.length ? (
                    <span className={isRisk ? 'text-rose-300/70' : 'text-amber-300/70'}>
                      {' '}
                      — {label}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <GoalsTable
        goals={goals}
        accounts={accounts.map((a) => ({ id: a.id, name: a.name, type: a.type }))}
        showArchived={includeArchived}
      />
    </div>
  );
}
