import React from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

export const LoadingScreen = ({ message = 'Loading...' }: { message?: string }) => (
  <div className="flex h-full items-center justify-center bg-background">
    <div className="flex flex-col items-center gap-4 text-center">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
      <p className="text-muted-foreground">{message}</p>
    </div>
  </div>
);

export const LoadingOverlay = ({ isLoading, children }: { isLoading: boolean; children: React.ReactNode }) => (
  <div className="relative">
    {children}
    {isLoading && (
      <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    )}
  </div>
);

export const Skeleton = ({ className = '' }: { className?: string }) => (
  <div
    className={clsx(
      'animate-pulse bg-muted rounded',
      className
    )}
  />
);