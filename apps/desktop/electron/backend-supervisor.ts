export type BackendState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'backing_off' | 'failed' | 'stopping';
interface Operations {
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  stateChanged(state: BackendState, error: string | null): void;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Backend operation cancelled.'));
    const cancel = () => { clearTimeout(timer); reject(new Error('Backend operation cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Serial ownership and a bounded restart budget; stop always cancels readiness first. */
export class BackendSupervisor {
  state: BackendState = 'stopped';
  lastError: string | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private restarting: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private attempts: number[] = [];
  private closed = false;

  constructor(private readonly operations: Operations, private readonly budget = 3, private readonly windowMs = 60000, private readonly backoffMs = 500) {}

  get restartAttempts(): number { return this.attempts.filter(at => Date.now() - at < this.windowMs).length; }

  private transition(state: BackendState, error: string | null = null): void {
    this.state = state;
    if (error !== null || state === 'ready') this.lastError = error;
    this.operations.stateChanged(state, this.lastError);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The application is shutting down.'));
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.state === 'ready') return Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    const operation = this.runStart(controller.signal);
    this.starting = operation;
    void operation.finally(() => { if (this.starting === operation) this.starting = null; }).catch(() => {});
    return operation;
  }

  private async runStart(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.attempts = this.attempts.filter(at => Date.now() - at < this.windowMs);
      if (this.attempts.length >= this.budget) {
        const error = 'Backend restart limit reached. Review diagnostics and retry in one minute.';
        this.transition('failed', error);
        throw new Error(error);
      }
      if (this.attempts.length) {
        this.transition('backing_off');
        await delay(this.backoffMs * 2 ** (this.attempts.length - 1), signal);
      }
      this.attempts.push(Date.now());
      this.transition('starting');
      try {
        await this.operations.start(signal);
        if (signal.aborted) throw new Error('Backend operation cancelled.');
        this.transition('ready');
        return;
      } catch (error) {
        // A failed probe/spawn never leaves an owned child behind before retry.
        try { await this.operations.stop(); }
        catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          this.transition('failed', message);
          throw new Error(message);
        }
        if (signal.aborted) throw new Error('Backend operation cancelled.');
        this.transition('degraded', error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error('Backend operation cancelled.');
  }

  stop(permanent = false): Promise<void> {
    if (permanent) this.closed = true;
    if (this.stopping) return this.stopping;
    this.controller?.abort();
    this.transition('stopping');
    const operation = (async () => {
      // Start observes cancellation and performs its own cleanup before stop repeats safely.
      if (this.starting) await this.starting.catch(() => {});
      try { await this.operations.stop(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.transition('failed', message);
        throw new Error(message);
      }
      this.transition('stopped');
    })();
    this.stopping = operation;
    void operation.finally(() => { if (this.stopping === operation) this.stopping = null; }).catch(() => {});
    return operation;
  }

  restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    // Deliberate healthy restarts are not crashes; repeated failed recoveries still
    // consume the circuit breaker and cannot be reset by clicking Retry.
    if (this.state === 'ready') this.attempts = [];
    const operation = (async () => { await this.stop(); await this.start(); })();
    this.restarting = operation;
    void operation.finally(() => { if (this.restarting === operation) this.restarting = null; }).catch(() => {});
    return operation;
  }

  crashed(message: string): Promise<void> {
    if (this.closed || ['stopped', 'stopping', 'starting', 'backing_off'].includes(this.state)) return Promise.resolve();
    this.transition('degraded', message);
    return this.start();
  }
}
