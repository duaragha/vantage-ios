/**
 * FrostedPanel — canonical command-center surface.
 *
 * Frosted-glass background (4% white over the dark base), 1px hairline border,
 * xl radius. Use wherever the spec asks for a panel — summary cards, data
 * tables, form containers, insight rows.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

interface FrostedPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: 'sm' | 'md' | 'lg' | 'none';
  as?: 'div' | 'section' | 'article';
}

export function FrostedPanel({
  className,
  padding = 'md',
  as: Tag = 'div',
  ...rest
}: FrostedPanelProps): React.ReactElement {
  const padMap = {
    none: '',
    sm: 'p-3',
    md: 'p-4 sm:p-5',
    lg: 'p-4 sm:p-6',
  } as const;
  return (
    <Tag
      className={cn(
        'relative rounded-xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl',
        padMap[padding],
        className,
      )}
      {...rest}
    />
  );
}
