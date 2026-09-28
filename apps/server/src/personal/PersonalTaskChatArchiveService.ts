import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import {
  decideTaskChatArchive,
  TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL,
  TASK_CHAT_AUTO_ARCHIVE_META_KEY,
  TASK_CHAT_AUTO_ARCHIVE_SWEEP_MS,
  taskChatAutoArchiveEnabled,
  type TaskChatArchiveCandidate,
} from "./taskChatAutoArchivePolicy.ts";

/**
 * Archives a chat made for a delegated task once the task has finished and
 * the chat has sat idle and unopened for 30 minutes (Harout: bots were left
 * with 30+ chats from finished tasks).
 *
 * Which chats and when: `taskChatAutoArchivePolicy.ts`. The archive itself is
 * the manual one (`PersonalBotService.archiveThread`): the link row gets
 * archived_at and the chat's session stops; nothing is deleted, the task page
 * still opens the chat and Unarchive works. `auto_archived_at` marks a chat
 * this sweep archived, so one the owner unarchives is never archived again.
 *
 * A sweep at startup and every 5 minutes; all state is in the database, so a
 * restart just runs the next sweep. One log line per sweep.
 */
export class PersonalTaskChatArchive extends Context.Service<
  PersonalTaskChatArchive,
  {
    /** Starts the sweep loop (once now, then every 5 minutes). Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One sweep. Returns how many chats it archived. */
    readonly sweep: Effect.Effect<number>;
  }
>()("t3/personal/PersonalTaskChatArchiveService/PersonalTaskChatArchive") {}

export type PersonalTaskChatArchiveShape = PersonalTaskChatArchive["Service"];

interface CandidateRow extends Omit<TaskChatArchiveCandidate, "pendingRequests"> {
  readonly pendingRequests: number | null;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  // A startup sweep and a timed one never overlap.
  const lock = yield* Semaphore.make(1);

  const enabled = repository.getMeta({ key: TASK_CHAT_AUTO_ARCHIVE_META_KEY }).pipe(
    Effect.map((stored) => taskChatAutoArchiveEnabled(Option.getOrNull(stored))),
    // An unreadable setting archives nothing this round.
    Effect.orElseSucceed(() => false),
  );

  const archiveOne = (candidate: CandidateRow, nowMs: number) =>
    Effect.gen(function* () {
      const threadId = candidate.threadId as ThreadId;
      // Fresh live state: the row's session status comes from the same
      // projection, but background work only lives in the shell.
      const shell = yield* projections.getThreadShellById(threadId);
      if (Option.isNone(shell)) return false;
      const thread = shell.value;
      const decision = decideTaskChatArchive(
        {
          ...candidate,
          sessionStatus: thread.session?.status ?? candidate.sessionStatus,
          activeTurnId: thread.session?.activeTurnId ?? candidate.activeTurnId,
          pendingRequests: candidate.pendingRequests ?? 0,
        },
        nowMs,
        {
          backgroundWork: thread.backgroundLiveness != null,
          latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
        },
      );
      if (decision.kind !== "archive") return false;
      yield* bots.archiveThread({ threadId, archived: true });
      const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      yield* sql`
        UPDATE personal_bot_threads
        SET auto_archived_at = ${now}
        WHERE thread_id = ${threadId} AND auto_archived_at IS NULL
      `;
      return true;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal task chat auto-archive failed for a chat", {
              threadId: candidate.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );

  const runSweep = Effect.gen(function* () {
    if (!(yield* enabled)) {
      yield* Effect.logInfo("personal task chat auto-archive sweep: off in Settings");
      return 0;
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const candidates = yield* sql.unsafe<CandidateRow>(TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL);
    let archived = 0;
    for (const candidate of candidates) {
      if (yield* archiveOne(candidate, nowMs)) archived += 1;
    }
    yield* Effect.logInfo("personal task chat auto-archive sweep", {
      archived,
      finishedTaskChats: candidates.length,
    });
    return archived;
  }).pipe(
    lock.withPermits(1),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal task chat auto-archive sweep failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(0)),
    ),
  );

  const start: PersonalTaskChatArchiveShape["start"] = Effect.fn("PersonalTaskChatArchive.start")(
    function* () {
      yield* forkParked(
        runSweep.pipe(
          Effect.repeat(Schedule.spaced(TASK_CHAT_AUTO_ARCHIVE_SWEEP_MS)),
          Effect.asVoid,
        ),
      );
    },
  );

  return { start, sweep: runSweep } satisfies PersonalTaskChatArchiveShape;
});

export const layer = Layer.effect(PersonalTaskChatArchive, make);
