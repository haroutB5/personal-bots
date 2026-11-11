import type { WorkingThread } from "./workingThreads";

export type StopAttempt =
  | { readonly kind: "stopping" }
  | { readonly kind: "failed"; readonly message: string };

export type StopAttempts = ReadonlyMap<string, StopAttempt>;

export interface StopRow {
  readonly threadId: string;
  readonly botName: string;
  readonly title: string;
  readonly state: "idle" | "stopping" | "failed";
  /** Shown under a failed row. */
  readonly message: string | null;
  /** The Stop button takes a tap. A row that is stopping waits for the server. */
  readonly canStop: boolean;
  readonly buttonLabel: string;
}

export type StopListView =
  | { readonly kind: "empty"; readonly headline: string }
  | { readonly kind: "list"; readonly headline: string; readonly rows: ReadonlyArray<StopRow> };

export const EMPTY_HEADLINE = "Nothing is working right now.";

export function beginStop(attempts: StopAttempts, threadId: string): StopAttempts {
  return new Map(attempts).set(threadId, { kind: "stopping" });
}

export function failStop(attempts: StopAttempts, threadId: string, message: string): StopAttempts {
  return new Map(attempts).set(threadId, { kind: "failed", message });
}

/** Forgets attempts for chats that are no longer running: the stop worked, or the turn ended alone. */
export function pruneAttempts(
  attempts: StopAttempts,
  threads: ReadonlyArray<WorkingThread>,
): StopAttempts {
  const running = new Set(threads.map((thread) => thread.threadId));
  const kept = [...attempts].filter(([threadId]) => running.has(threadId));
  return kept.length === attempts.size ? attempts : new Map(kept);
}

function headline(count: number): string {
  return count === 1 ? "1 bot working" : `${count} bots working`;
}

/** The Stop list screen as plain data. One row per working chat. */
export function stopListView(
  threads: ReadonlyArray<WorkingThread>,
  attempts: StopAttempts,
): StopListView {
  if (threads.length === 0) return { kind: "empty", headline: EMPTY_HEADLINE };
  const rows = threads.map((thread): StopRow => {
    const attempt = attempts.get(thread.threadId);
    const state = attempt?.kind ?? "idle";
    return {
      threadId: thread.threadId,
      botName: thread.botName,
      title: thread.title,
      state,
      message: attempt?.kind === "failed" ? attempt.message : null,
      canStop: state !== "stopping",
      buttonLabel: state === "stopping" ? "Stopping…" : state === "failed" ? "Try again" : "Stop",
    };
  });
  return { kind: "list", headline: headline(new Set(threads.map((t) => t.botId)).size), rows };
}
