/**
 * A fresh provider session replaces the thread's old one: the reactor stops
 * the old session, and the old session's `session.exited` arrives afterwards.
 * When the new session runs on the same provider instance the exit looks
 * exactly like the new session's own, so the ingestion cannot tell them apart
 * by instance. The reactor marks the stop it is about to make; the ingestion
 * ignores the first exit of that session that follows, so the exit is not
 * read as "the turn ended" by a task, routine or group that caused the
 * restart (a steered task ended "interrupted" although its reply was coming).
 *
 * In memory, per process: a restart of the server loses a mark, and a mark
 * that nothing consumes expires.
 */

/** How long after the stop an exit still counts as the replaced session's. */
export const REPLACED_SESSION_EXIT_WINDOW_MS = 10_000;
/** Exit events carry the adapter's clock; a little slack covers ordering within one stop. */
const CLOCK_SLACK_MS = 2_000;

interface Mark {
  readonly provider: string;
  readonly instanceId: string | undefined;
  readonly atMs: number;
}

const marks = new Map<string, Mark>();

/** The reactor is about to stop `threadId`'s session so a fresh one can take its place. */
export function markSessionReplaced(input: {
  readonly threadId: string;
  readonly provider: string;
  readonly instanceId?: string | undefined;
  readonly nowMs: number;
}): void {
  marks.set(input.threadId, {
    provider: input.provider,
    instanceId: input.instanceId,
    atMs: input.nowMs,
  });
}

/**
 * Whether this exit is the one the reactor's stop caused (and uses it up).
 * It must name the same provider (and instance, when both name one) and
 * arrive inside the window; any other exit is the thread's own.
 */
export function consumeReplacedSessionExit(input: {
  readonly threadId: string;
  readonly provider: string;
  readonly instanceId?: string | undefined;
  readonly eventAtMs: number;
}): boolean {
  const mark = marks.get(input.threadId);
  if (mark === undefined) return false;
  const sameSession =
    mark.provider === input.provider &&
    (mark.instanceId === undefined ||
      input.instanceId === undefined ||
      mark.instanceId === input.instanceId);
  const inWindow =
    input.eventAtMs >= mark.atMs - CLOCK_SLACK_MS &&
    input.eventAtMs <= mark.atMs + REPLACED_SESSION_EXIT_WINDOW_MS;
  if (!inWindow) {
    marks.delete(input.threadId);
    return false;
  }
  if (!sameSession) return false;
  marks.delete(input.threadId);
  return true;
}

/** The pending mark for a thread, for tests. */
export const peekReplacedSession = (threadId: string): Mark | undefined => marks.get(threadId);

/** Forgets every mark, for tests. */
export const clearReplacedSessions = (): void => marks.clear();
