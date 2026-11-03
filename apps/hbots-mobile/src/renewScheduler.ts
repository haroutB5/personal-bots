export const RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ForegroundSource {
  readonly subscribe: (onForeground: () => void) => () => void;
}

export interface RenewSchedulerOptions {
  readonly run: () => Promise<void>;
  readonly onError: (cause: unknown) => void;
  readonly foreground: ForegroundSource;
  readonly intervalMs?: number;
}

export function startRenewScheduler(options: RenewSchedulerOptions): () => void {
  let inFlight = false;
  const tick = () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    options
      .run()
      .catch(options.onError)
      .finally(() => {
        inFlight = false;
      });
  };
  tick();
  const unsubscribe = options.foreground.subscribe(tick);
  const timer = setInterval(tick, options.intervalMs ?? RENEW_INTERVAL_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
