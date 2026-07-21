/**
 * AddPositionButton — opens the Position form drawer.
 *
 * Client-only wrapper because the server-rendered portfolio page needs a
 * trigger that toggles a drawer without requiring a route change.
 */

'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { Drawer } from '@/components/Drawer';
import { PositionForm } from '@/components/PositionForm';
import type { AccountListItem } from '@/app/(dashboard)/accounts/data';

export function AddPositionButton({
  accounts,
}: {
  accounts?: AccountListItem[];
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-md border border-[var(--cc-accent)]/30 bg-gradient-to-b from-[var(--cc-accent)]/20 to-transparent px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--cc-accent)] transition hover:from-[var(--cc-accent)]/30"
      >
        <Plus className="size-3.5" />
        Add position
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Add position"
        description="Manual entry. For bulk paste, use the Import page."
      >
        <PositionForm
          mode="create"
          onDone={() => setOpen(false)}
          accounts={accounts}
        />
      </Drawer>
    </>
  );
}
