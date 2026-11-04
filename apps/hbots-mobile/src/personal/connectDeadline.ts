export interface DisposableSession {
  readonly dispose: () => Promise<void>;
}

/** Longer than a healthy connect, short enough to retry inside the 15 s budget. */
export const CONNECT_DEADLINE_MS = 8_000;

export class ConnectDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`The connection attempt timed out after ${String(deadlineMs)} ms.`);
    this.name = "ConnectDeadlineError";
  }
}

/**
 * Bounds the whole connect attempt, not just the socket open. A protocol layer
 * that waits forever leaves the app stuck on "connecting" with no watchdog and
 * no retry. A session that arrives after the deadline is disposed, so a late
 * attempt cannot leak a second socket.
 */
export function connectWithDeadline<T extends DisposableSession>(
  connect: () => Promise<T>,
  deadlineMs: number = CONNECT_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ConnectDeadlineError(deadlineMs));
    }, deadlineMs);
    connect().then(
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
