import React from 'react';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useTheme } from '@/components/ThemeProvider';

interface BackendStatusBannerProps {
  isReady: boolean;
  error: string | null;
  onRetry?: () => void;
}

export const BackendStatusBanner = ({ isReady, error, onRetry }: BackendStatusBannerProps) => {
  const { resolvedTheme } = useTheme();
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => setDismissed(false), [isReady, error]);
  
  if ((isReady && !error) || dismissed) return null;

  return (
    <div
      className={clsx(
        'fixed top-0 left-0 right-0 z-50 px-4 py-2 border-b transition-all duration-300',
        error
          ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
          : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <AlertCircle className={clsx(
            'w-5 h-5 flex-shrink-0',
            error ? 'text-red-500' : 'text-yellow-500'
          )} />
          <span className={clsx(
            'text-sm font-medium',
            error ? 'text-red-700 dark:text-red-300' : 'text-yellow-700 dark:text-yellow-300'
          )}>
            {error ? 'Backend Error' : 'Backend Starting...'}
          </span>
          {error && (
            <span className={clsx(
              'text-sm text-muted-foreground max-w-md truncate',
              error ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'
            )}>
              {error}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onRetry && (
            <button
              onClick={onRetry}
              className={clsx(
                'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors',
                error
                  ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300'
                  : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-300'
              )}
            >
              <RefreshCw className="w-4 h-4 mr-1" />
              Retry
            </button>
          )}
          <button
            onClick={() => setDismissed(true)}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
