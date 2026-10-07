import * as NodeCrypto from "node:crypto";

import { CommandId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import { unarchivedChatTitle, withChatTitleLock } from "./personalChatTitles.ts";
import {
  ARCHIVED_BUSY_CHATS_SQL,
  decideTaskChatArchive,
  TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL,
  TASK_CHAT_AUTO_ARCHIVE_META_KEY,
  TASK_CHAT_AUTO_ARCHIVE_SWEEP_MS,
  TASK_CHAT_OPEN_WORK_SQL,
  taskChatAutoArchiveEnabled,
  type TaskChatArchiveCandidate,
} from "./taskChatAutoArchivePolicy.ts";
import { withStallJob } from "../observability/stallJobs.ts";

/**
 * Archives finished delegated-task chats after 48 idle hours. Routine-run
 * chats archive after opening and 48 idle hours, or after 48 hours unread.
 *
 * Which chats and when: `taskChatAutoArchivePolicy.ts`. The archive itself is
 * the manual one (`PersonalBotService.archiveThread`): the link row gets
 * archived_at and the chat's session stops; nothing is deleted, the task page
 * still opens the chat and Unarchive works. `auto_archived_at` marks a chat
 * this sweep archived, so one the owner unarchives is never archived again.
 *
 * A sweep at startup and every 5 minutes; all state is in the database, so a
 * restart just runs the next sweep. One log line per sweep.
 *
 * The other direction: a chat that gets a new turn is unarchived (link
 * `archived_at` and `auto_archived_at` cleared), so a reopened or steered
 * task, a routine run or the owner's message is never working out of sight
 * (QA's reopened bug hunt ran for an hour in an archived chat while its row
 * said Ready). One place covers every source: the turn-start event. Each
 * sweep also unarchives an archived chat whose newer turn is still running,
 * whatever the Settings toggle says.
 */
export class PersonalTaskChatArchive extends Context.Service<
  PersonalTaskChatArchive,
  {
    /** Starts the sweep loop (once now, then every 5 minutes). Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One sweep. Returns how many chats it archived. */
    readonly sweep: Effect.Effect<number>;
    /**
     * A turn is starting on this chat: unarchive it if it is archived (not a
     * group relay). True when it was archived.
     */
    readonly unarchiveForTurn: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/personal/PersonalTaskChatArchiveService/PersonalTaskChatArchive") {}

export type PersonalTaskChatArchiveShape = PersonalTaskChatArchive["Service"];

interface CandidateRow extends Omit<TaskChatArchiveCandidate, "pendingRequests"> {
  readonly pendingRequests: number | null;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
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
      // The candidate list was read at the start of the sweep; a task reopened
      // since then has work again.
      const [openWork] = yield* sql.unsafe<{ readonly open: number | boolean }>(
        TASK_CHAT_OPEN_WORK_SQL,
        [threadId, threadId],
      );
      if (openWork !== undefined && Boolean(openWork.open)) return false;
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

  const unarchiveForTurn: PersonalTaskChatArchiveShape["unarchiveForTurn"] = (threadId) =>
    Effect.gen(function* () {
      // Every turn start lands here; only an archived chat has anything to do.
      const link = yield* repository.getThreadLink({ threadId });
      if (Option.isNone(link) || link.value.archivedAt === null) return false;
      return yield* withChatTitleLock(
        Effect.gen(function* () {
          // Another open chat of the bot may have taken the name while this one
          // was archived: it comes back with the lowest free number after it.
          const shell = yield* projections.getThreadShellById(threadId);
          const renamedTo = Option.isSome(shell)
            ? yield* unarchivedChatTitle(repository, { threadId, title: shell.value.title })
            : null;
          if (renamedTo !== null) {
            yield* engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(
                `personal-bots:thread.unarchive-title:${threadId}:${NodeCrypto.randomUUID()}`,
              ),
              threadId,
              title: renamedTo,
            });
          }
          const rows = yield* sql<{ readonly threadId: string }>`
            UPDATE personal_bot_threads
            SET archived_at = NULL, auto_archived_at = NULL
            WHERE thread_id = ${threadId}
              AND archived_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM personal_group_members gm WHERE gm.thread_id = ${threadId}
              )
            RETURNING thread_id AS "threadId"
          `;
          if (rows.length === 0) return false;
          yield* Effect.logInfo("personal chat unarchived: a turn started in it", {
            threadId,
            renamed: renamedTo !== null,
          });
          return true;
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal chat unarchive on turn start failed", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
      ),
    );

  /** Archived chats whose newer turn is still running (`ARCHIVED_BUSY_CHATS_SQL`). */
  const healArchivedBusy = Effect.gen(function* () {
    const busy = yield* sql.unsafe<{ readonly threadId: string }>(ARCHIVED_BUSY_CHATS_SQL);
    let healed = 0;
    for (const row of busy) {
      if (yield* unarchiveForTurn(row.threadId as ThreadId)) healed += 1;
    }
    return healed;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal archived busy chat check failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(0)),
    ),
  );

  const runSweep = Effect.gen(function* () {
    yield* healArchivedBusy;
    if (!(yield* enabled)) {
      yield* Effect.logInfo("personal task chat auto-archive sweep: off in Settings");
      return 0;
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const candidates = yield* sql.unsafe<CandidateRow>(TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL);
    let archived = 0;
    let archivedTaskChats = 0;
    let archivedRoutineChats = 0;
    for (const candidate of candidates) {
      if (yield* archiveOne(candidate, nowMs)) {
        archived += 1;
        if (candidate.chatKind === "routine") archivedRoutineChats += 1;
        else archivedTaskChats += 1;
      }
    }
    yield* Effect.logInfo("personal task chat auto-archive sweep", {
      archived,
      archivedTaskChats,
      archivedRoutineChats,
      finishedTaskChats: candidates.filter((chat) => chat.chatKind === "delegation").length,
      finishedRoutineChats: candidates.filter((chat) => chat.chatKind === "routine").length,
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
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          event.type === "thread.turn-start-requested"
            ? unarchiveForTurn(event.payload.threadId).pipe(Effect.asVoid)
            : Effect.void,
        ),
      );
      yield* forkParked(
        runSweep.pipe(
          withStallJob("job:task-chat-archive-sweep"),
          Effect.repeat(Schedule.spaced(TASK_CHAT_AUTO_ARCHIVE_SWEEP_MS)),
          Effect.asVoid,
        ),
      );
    },
  );

  return { start, sweep: runSweep, unarchiveForTurn } satisfies PersonalTaskChatArchiveShape;
});

export const layer = Layer.effect(PersonalTaskChatArchive, make);
