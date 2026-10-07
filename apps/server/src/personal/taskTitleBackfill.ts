/**
 * One-off rename of the task and routine chats made before 1.47.0 named new
 * task chats after their task: those chats are still on the "New chat"
 * placeholder.
 *
 * Each rename goes through the engine's own title command
 * (`thread.title.generate.complete`), which only replaces the title it was
 * told to expect and keeps the thread's `updatedAt`, so no chat moves in any
 * list. A chat renamed by anyone in the meantime is skipped, never overwritten.
 *
 * Runs once per data root: the marker in `personal_meta` is written only
 * after a pass with no failures, so a failed pass retries on the next start.
 */
import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersonalBotRepository } from "./PersonalBotRepository.ts";
import { uniqueAutomaticTitle, withChatTitleLock } from "./personalChatTitles.ts";
import { PERSONAL_THREAD_TITLE, personalTaskThreadTitle } from "./personalThreadTitles.ts";

export const TASK_TITLE_BACKFILL_META_KEY = "task-title-backfill-v1";
const COMMAND_TAG = "personal-task-title-backfill";

export interface TaskTitleBackfillCandidate {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly taskId: string;
  /** The title version seen at selection; the rename expects exactly this. */
  readonly expectedVersion: CommandId | null;
}

export type TaskTitleBackfillSkipReason = "gone" | "manual" | "changed";

export interface TaskTitleBackfillResult {
  readonly renamed: number;
  readonly skipped: Readonly<Record<TaskTitleBackfillSkipReason, number>>;
  readonly failed: number;
}

const LinkedThreadRow = Schema.Struct({
  threadId: Schema.String,
  taskId: Schema.String,
  taskTitle: Schema.String,
});

/**
 * Every live chat still titled "New chat" that a task names: through
 * `personal_tasks.thread_id` or an attempt's `provider_thread_id`. Group
 * chats are left out. A chat several tasks share takes the earliest task's
 * title (for a mixed chat, the routine run that created it).
 */
const selectLinkedThreads = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: LinkedThreadRow,
    execute: () => sql`
      WITH links AS (
        SELECT t.thread_id AS thread_id, t.task_id, t.created_at, t.title
          FROM personal_tasks t
         WHERE t.thread_id IS NOT NULL
        UNION
        SELECT a.provider_thread_id AS thread_id, t.task_id, t.created_at, t.title
          FROM personal_task_attempts a
          JOIN personal_tasks t ON t.task_id = a.task_id
      ),
      ranked AS (
        SELECT l.thread_id, l.task_id, l.title,
               ROW_NUMBER() OVER (
                 PARTITION BY l.thread_id ORDER BY l.created_at ASC, l.task_id ASC
               ) AS rank
          FROM links l
      )
      SELECT r.thread_id AS "threadId", r.task_id AS "taskId", r.title AS "taskTitle"
        FROM ranked r
        JOIN projection_threads p ON p.thread_id = r.thread_id
       WHERE r.rank = 1
         AND p.deleted_at IS NULL
         AND p.title = ${PERSONAL_THREAD_TITLE}
         AND r.thread_id NOT IN (SELECT g.thread_id FROM personal_groups g)
         AND r.thread_id NOT IN (
           SELECT m.thread_id FROM personal_group_members m WHERE m.thread_id IS NOT NULL
         )
       ORDER BY p.created_at ASC, r.thread_id ASC
    `,
  });

/**
 * The chats to rename, with the title version each one has right now. The
 * engine's thread shell is the judge: a manual title (even one reading
 * "New chat") is left alone.
 */
export const selectTaskTitleBackfill = Effect.fn("selectTaskTitleBackfill")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const snapshots = yield* ProjectionSnapshotQuery;
  const rows = yield* selectLinkedThreads(sql)(undefined);
  const candidates: Array<TaskTitleBackfillCandidate> = [];
  for (const row of rows) {
    const shell = yield* snapshots.getThreadShellById(row.threadId as ThreadId);
    if (Option.isNone(shell)) continue;
    const thread = shell.value;
    if (thread.title !== PERSONAL_THREAD_TITLE || thread.titleState?.source === "manual") continue;
    const title = personalTaskThreadTitle(row.taskTitle);
    if (title === PERSONAL_THREAD_TITLE) continue;
    candidates.push({
      threadId: thread.id,
      title,
      taskId: row.taskId,
      expectedVersion: thread.titleState?.version ?? null,
    });
  }
  return candidates;
});

/**
 * Renames each candidate through the engine, expecting the placeholder and
 * the version seen at selection. Reads each chat back to tell a rename from a
 * skip. Never fails: a chat that fails is counted and logged.
 */
export const renameTaskTitleBackfill = Effect.fn("renameTaskTitleBackfill")(function* (
  candidates: ReadonlyArray<TaskTitleBackfillCandidate>,
) {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const repository = yield* PersonalBotRepository;
  const crypto = yield* Crypto.Crypto;
  let renamed = 0;
  let failed = 0;
  const skipped: Record<TaskTitleBackfillSkipReason, number> = { gone: 0, manual: 0, changed: 0 };

  for (const candidate of candidates) {
    const outcome = yield* Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      // A bot's open chats have unique names: a taken task title gets a number.
      const title = yield* withChatTitleLock(
        Effect.gen(function* () {
          const unique = yield* uniqueAutomaticTitle(repository, {
            threadId: candidate.threadId,
            title: candidate.title,
          });
          yield* engine.dispatch({
            type: "thread.title.generate.complete",
            commandId: CommandId.make(`server:${COMMAND_TAG}:${uuid}`),
            threadId: candidate.threadId,
            title: unique,
            expectedTitle: PERSONAL_THREAD_TITLE,
            expectedVersion: candidate.expectedVersion,
            needsRefinement: false,
          });
          return unique;
        }),
      );
      const after = yield* snapshots.getThreadShellById(candidate.threadId);
      if (Option.isNone(after)) return "gone" as const;
      if (after.value.title === title && after.value.titleState?.source === "generated") {
        return "renamed" as const;
      }
      return after.value.titleState?.source === "manual"
        ? ("manual" as const)
        : ("changed" as const);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal task title backfill: rename failed", {
          threadId: candidate.threadId,
          taskId: candidate.taskId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as("failed" as const)),
      ),
    );
    if (outcome === "renamed") renamed += 1;
    else if (outcome === "failed") failed += 1;
    else skipped[outcome] += 1;
  }
  return { renamed, skipped, failed } satisfies TaskTitleBackfillResult;
});

/**
 * The startup job: does nothing once the marker is set; otherwise selects,
 * renames, logs one summary line and sets the marker only after a clean pass.
 * Returns null when the marker was already set.
 */
export const runTaskTitleBackfill = Effect.fn("runTaskTitleBackfill")(function* () {
  const repository = yield* PersonalBotRepository;
  const done = yield* repository.getMeta({ key: TASK_TITLE_BACKFILL_META_KEY });
  if (Option.isSome(done)) return null;

  const candidates = yield* selectTaskTitleBackfill();
  const result = yield* renameTaskTitleBackfill(candidates);
  const summary = {
    selected: candidates.length,
    renamed: result.renamed,
    skippedGone: result.skipped.gone,
    skippedManual: result.skipped.manual,
    skippedChanged: result.skipped.changed,
    failed: result.failed,
  };
  if (result.failed > 0) {
    yield* Effect.logWarning(
      "personal task title backfill: pass had failures, retrying on next start",
      summary,
    );
    return result;
  }
  yield* repository.setMeta({
    key: TASK_TITLE_BACKFILL_META_KEY,
    // When it completed; the counts are in the log line below.
    value: DateTime.formatIso(yield* DateTime.now),
  });
  yield* Effect.logInfo("personal task title backfill: done", summary);
  return result;
});

/** For the startup fork: logs anything unexpected instead of failing. */
export const runTaskTitleBackfillSafely = runTaskTitleBackfill().pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning("personal task title backfill failed, retrying on next start", {
          cause: Cause.pretty(cause),
        }),
  ),
  Effect.asVoid,
);
