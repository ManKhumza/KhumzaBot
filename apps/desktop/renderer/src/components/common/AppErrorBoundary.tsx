import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { userFacingError } from '@/utils/errors';

interface AppErrorBoundaryProps {
  children: ReactNode;
  resetKey?: string;
  variant?: 'app' | 'page';
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Renderer view failed:', userFacingError(error));
  }

  componentDidUpdate(previousProps: AppErrorBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private returnHome = () => {
    this.setState({ error: null });
    window.location.hash = '#/';
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={this.props.variant === 'page'
        ? 'flex min-h-full items-center justify-center bg-background p-6'
        : 'flex min-h-screen items-center justify-center bg-background p-6'}>
        <div className="w-full max-w-lg border border-border bg-card p-6 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-lg font-semibold">This view could not be displayed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Reload this view or open diagnostics to check the local services.
          </p>
          <code className="mt-4 block max-h-24 overflow-auto bg-muted p-3 text-left text-xs text-muted-foreground">
            {userFacingError(error, 'Unknown renderer error')}
          </code>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => { this.setState({ error: null }); window.location.hash = '#/diagnostics'; }} className="rounded-md border border-input px-4 py-2 text-sm">Diagnostics</button>
            <button
              type="button"
              onClick={this.returnHome}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent"
            >
              <Home className="h-4 w-4" />
              Overview
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <RefreshCw className="h-4 w-4" />
              Reload view
            </button>
          </div>
        </div>
      </div>
    );
  }
}
