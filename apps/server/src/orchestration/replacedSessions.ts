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
 * The mark is set before the stop (the exit can arrive before `stopSession`
 * returns) and taken back with {@link unmarkSessionReplaced} when the stop
 * turned out to stop nothing, so no exit is awaited that will never come.
 * Several marks may wait on one thread (two fresh restarts close together):
 * an exit uses up the oldest one that matches.
 *
 * In memory, per process: a restart of the server loses a mark, and a mark
 * that nothing consumes expires.
 */

/** How long after the stop an exit still counts as the replaced session's. */
export const REPLACED_SESSION_EXIT_WINDOW_MS = 30_000;
/** Exit events carry the adapter's clock; a little slack covers ordering within one stop. */
const CLOCK_SLACK_MS = 2_000;
/** Marks kept per thread: more than this is a loop, and the oldest go first. */
const MAX_MARKS_PER_THREAD = 8;

interface Mark {
  readonly id: number;
  readonly provider: string;
  readonly instanceId: string | undefined;
  readonly atMs: number;
}

const marks = new Map<string, Array<Mark>>();
let nextId = 1;

/** The reactor is about to stop `threadId`'s session so a fresh one can take its place. Returns the mark's id. */
export function markSessionReplaced(input: {
  readonly threadId: string;
  readonly provider: string;
  readonly instanceId?: string | undefined;
  readonly nowMs: number;
}): number {
  const id = nextId++;
  const list = marks.get(input.threadId) ?? [];
  list.push({ id, provider: input.provider, instanceId: input.instanceId, atMs: input.nowMs });
  marks.set(input.threadId, list.slice(-MAX_MARKS_PER_THREAD));
  return id;
}

/** The stop that mark `id` announced stopped nothing: no exit will come for it. */
export function unmarkSessionReplaced(threadId: string, id: number): void {
  const list = marks.get(threadId);
  if (list === undefined) return;
  const rest = list.filter((mark) => mark.id !== id);
  if (rest.length === 0) marks.delete(threadId);
  else marks.set(threadId, rest);
}

/**
 * Whether this exit is the one a reactor stop caused (and uses that mark up).
 * It must name the same provider (and instance, when both name one) and arrive
 * inside the mark's window; the oldest matching mark is the one used, and
 * expired marks are dropped on the way. Any other exit is the thread's own.
 */
export function consumeReplacedSessionExit(input: {
  readonly threadId: string;
  readonly provider: string;
  readonly instanceId?: string | undefined;
  readonly eventAtMs: number;
}): boolean {
  const list = marks.get(input.threadId);
  if (list === undefined) return false;
  const live = list.filter(
    (mark) => input.eventAtMs <= mark.atMs + REPLACED_SESSION_EXIT_WINDOW_MS,
  );
  const match = live
    .toSorted((a, b) => a.atMs - b.atMs || a.id - b.id)
    .find(
      (mark) =>
        input.eventAtMs >= mark.atMs - CLOCK_SLACK_MS &&
        mark.provider === input.provider &&
        (mark.instanceId === undefined ||
          input.instanceId === undefined ||
          mark.instanceId === input.instanceId),
    );
  const rest = match === undefined ? live : live.filter((mark) => mark.id !== match.id);
  if (rest.length === 0) marks.delete(input.threadId);
  else marks.set(input.threadId, rest);
  return match !== undefined;
}

/** The pending marks for a thread, oldest first, for tests. */
export const peekReplacedSessions = (threadId: string): ReadonlyArray<Mark> =>
  (marks.get(threadId) ?? []).toSorted((a, b) => a.atMs - b.atMs || a.id - b.id);

/** The oldest pending mark for a thread, for tests. */
export const peekReplacedSession = (threadId: string): Mark | undefined =>
  peekReplacedSessions(threadId)[0];

/** Forgets every mark, for tests. */
export const clearReplacedSessions = (): void => marks.clear();
