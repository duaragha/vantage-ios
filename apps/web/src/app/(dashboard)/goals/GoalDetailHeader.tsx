'use client';

import * as React from 'react';
import { GoalBadge } from '@/components/GoalBadge';
import { EditGoalForm, type EditGoalInitial } from './EditGoalForm';

export function GoalDetailHeader({
  initial,
  accounts,
  notes,
}: {
  initial: EditGoalInitial;
  accounts: Array<{ id: number; name: string; type: string }>;
  notes: string | null;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);

  if (editing) {
    return <EditGoalForm initial={initial} accounts={accounts} onCancel={() => setEditing(false)} />;
  }

  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-medium">
          {initial.name} <GoalBadge type={initial.type} />
        </h1>
        {notes ? <p className="mt-1 text-sm text-zinc-400">{notes}</p> : null}
      </div>
      <button
        onClick={() => setEditing(true)}
        className="rounded border border-white/[0.08] px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.04]"
      >
        Edit goal
      </button>
    </div>
  );
}
