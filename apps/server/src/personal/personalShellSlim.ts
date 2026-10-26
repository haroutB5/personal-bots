/**
 * The slim shell: the Bots app asks for the environment shell without the
 * bot chats the owner archived, which are most of the threads on a long-lived
 * server (1,513 of 1,585 on the 1.66.97 data, 2.3 MB of the 2.4 MB shell).
 * The first screen never shows them; a bot's chat list, an open archived chat
 * and message search load them on demand through `personalBots.threadShells`.
 *
 * An archived chat that is working or waiting on the owner (an approval or a
 * question) stays in the shell, so a working bot still sorts to the top.
 *
 * Kill switch: PB_PERF_OFF=shell-omit-archived serves the full shell again
 * (perfFlags.ts). The client side has its own switch of the same name.
 */
import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { serverPerfOptimizationOn } from "./perfFlags.ts";

/** Whether an archived chat still belongs in the slim shell. */
export function archivedShellThreadNeeded(thread: OrchestrationThreadShell): boolean {
  if (thread.latestTurn?.state === "running") return true;
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return true;
  return thread.hasPendingApprovals || thread.hasPendingUserInput;
}

export function slimShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
  archivedThreadIds: ReadonlySet<string>,
): OrchestrationShellSnapshot {
  if (archivedThreadIds.size === 0) return snapshot;
  const threads = snapshot.threads.filter(
    (thread) => !archivedThreadIds.has(thread.id) || archivedShellThreadNeeded(thread),
  );
  return threads.length === snapshot.threads.length ? snapshot : { ...snapshot, threads };
}

/**
 * The ids of every archived bot chat. A failed read returns an empty set, so
 * the shell goes out whole rather than not at all.
 */
export const listArchivedBotThreadIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId"
    FROM personal_bot_threads
    WHERE archived_at IS NOT NULL
  `;
  return new Set(rows.map((row) => row.threadId)) as ReadonlySet<string>;
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("could not read archived bot chats; serving the full shell", {
      cause,
    }).pipe(Effect.as(new Set<string>() as ReadonlySet<string>)),
  ),
);

/** Slims `snapshot` when the client asked for it and the switch is on. */
export const maybeSlimShellSnapshot = (
  snapshot: OrchestrationShellSnapshot,
  requested: boolean,
): Effect.Effect<OrchestrationShellSnapshot, never, SqlClient.SqlClient> =>
  requested && serverPerfOptimizationOn("shell-omit-archived")
    ? listArchivedBotThreadIds.pipe(Effect.map((ids) => slimShellSnapshot(snapshot, ids)))
    : Effect.succeed(snapshot);

/** The thread ids `personalBots.threadShells` should return. */
export const listBotThreadIds = (input: {
  readonly botId?: string | undefined;
  readonly threadIds?: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const ids = new Set<string>(input.threadIds ?? []);
    if (input.botId !== undefined) {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM personal_bot_threads
        WHERE bot_id = ${input.botId}
      `;
      for (const row of rows) ids.add(row.threadId);
    }
    return ids as ReadonlySet<string>;
  });

/** The shells of `ids`, in the shell's own order. */
export function pickThreadShells(
  snapshot: OrchestrationShellSnapshot,
  ids: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThreadShell> {
  if (ids.size === 0) return [];
  return snapshot.threads.filter((thread) => ids.has(thread.id));
}
