/**
 * Startup cannot sit on "Starting" for good. A native call that never answers gives up
 * after a deadline, and a step that fails or gives up is tried again with a growing wait.
 */

/** The updater snapshot is only a hint at launch. Past this the app starts without it. */
export const SNAPSHOT_DEADLINE_MS = 2_000;
/** Reading the saved session. Past this it fails (it is never read as "signed out"). */
export const SESSION_DEADLINE_MS = 5_000;
export const RETRY_FIRST_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 30_000;

export class DeadlineError extends Error {
  constructor(readonly label: string) {
    super(`${label} did not answer in time.`);
    this.name = "DeadlineError";
  }
}

/** Settles with `work`, or rejects with a [DeadlineError] when it takes longer than `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/** `work`'s value, or `fallback` when it takes longer than `ms` or fails. */
export function orFallbackAfter<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return withDeadline(work, ms, "A startup step").catch(() => fallback);
}

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_FIRST_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

export type StartStep = "done" | "retry";

/**
 * Runs `step` now, and again after a growing wait for as long as it answers "retry" or throws.
 * A step that answers "done" ends it. Returns a function that stops any pending retry.
 */
export function startWithRetry(step: (attempt: number) => Promise<StartStep>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (attempt: number) => {
    timer = null;
    step(attempt).then(
      (result) => {
        if (result === "retry") later(attempt);
      },
      () => later(attempt),
    );
  };
  const later = (attempt: number) => {
    if (stopped) return;
    timer = setTimeout(() => run(attempt + 1), retryDelayMs(attempt));
  };
  run(0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
