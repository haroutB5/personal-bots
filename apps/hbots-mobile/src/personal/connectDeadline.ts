export interface DisposableSession {
  readonly dispose: () => Promise<void>;
}

/** Longer than a healthy connect, short enough to retry inside the 15 s budget. */
export const CONNECT_DEADLINE_MS = 5_000;

export class ConnectDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`The connection attempt timed out after ${String(deadlineMs)} ms.`);
    this.name = "ConnectDeadlineError";
  }
}

/**
 * Bounds the whole connect attempt, not just the socket open. The deadline
 * aborts the attempt so a hung socket cannot queue every later retry.
 */
export function connectWithDeadline<T extends DisposableSession>(
  connect: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number = CONNECT_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new ConnectDeadlineError(deadlineMs));
    }, deadlineMs);
    connect(controller.signal).then(
      (session) => {
        if (settled) {
          void session.dispose();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(session);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
