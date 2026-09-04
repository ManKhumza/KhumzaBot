import React, { forwardRef } from 'react';
import { clsx } from 'clsx';

export const ScrollArea = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={clsx('relative overflow-auto', className)}
      {...props}
    >
      {children}
    </div>
  )
);

ScrollArea.displayName = 'ScrollArea';