// The task service's shared parts: its dependencies, the in-memory state of the dispatcher and the
// helpers every other part uses (task writes, work records, sensitive-site marks, parent hand-offs).
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PersonalTaskId,
  PersonalTaskWorkRecord,
  PersonalTasksError,
  ThreadId,
  type PersonalBotId,
  type PersonalTask,
} from "@t3tools/contracts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalModelFallback from "../PersonalModelFallbackService.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { secretRedactor } from "../secrets/secretRedaction.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import { emptyWorkRecord, recordAttemptEnd, recordSteer } from "./workRecord.ts";
import { type Changed } from "./taskShared.ts";
import { type BackgroundWait } from "./taskBackgroundPolicy.ts";
import { isTerminal } from "./taskSessionPolicy.ts";

export const makeTaskCore = () =>
  Effect.gen(function* () {
    const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
    const botRepository = yield* PersonalBotRepository.PersonalBotRepository;
    const bots = yield* PersonalBotService.PersonalBotService;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const messages = yield* ProjectionThreadMessageRepository;
    const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;
    // Work records live beside the task tables. Optional so a layer that has no
    // SQL client (a unit test of the dispatcher alone) simply keeps none.
    const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
    // Optional so the task service stays testable alone; the server always has it.
    const modelFallback = yield* Effect.serviceOption(PersonalModelFallback.PersonalModelFallback);
    const workStore = Option.map(sqlOption, (sql) => ({
      sql,
      exposures: makeSensitiveExposureStore(sql),
    }));
    const decodeWorkRecord = Schema.decodeUnknownOption(
      Schema.fromJsonString(PersonalTaskWorkRecord),
    );
    const encodeWorkRecord = Schema.encodeEffect(Schema.fromJsonString(PersonalTaskWorkRecord));

    // One owner per server process: a lease held by anyone else and past its
    // expiry belongs to a process that died mid-turn.
    const leaseOwner = `personal-tasks:${NodeCrypto.randomUUID()}`;
    const upserts = yield* PubSub.unbounded<PersonalTask>();
    // Serialises public mutations with dispatcher steps, so a claim never
    // interleaves with a cancel or a delegation on the same rows.
    const lock = yield* Semaphore.make(1);
    /** Slots held by work that is not a task (see `reserveExternalSlot`). In memory: a restart ends that work. */
    const externalSlots = new Set<string>();
    // Provider threads with an active attempt; filters the hot event stream.
    const activeThreadIds = new Set<string>();
    // When an attempt's turn first ended on a lost conversation (see PERSONAL_TASKS_RENEWAL_WAIT_MS).
    const renewalWaitSince = new Map<string, number>();
    // Threads whose waiting task queues once their provider session is gone.
    const resumingThreadIds = new Set<string>();
    // Threads with a queued task held back because a turn (usually the user's
    // own chat turn) is running there; their next session change re-pumps.
    const idleWaitThreadIds = new Set<string>();
    /**
     * When a thread's attempt last stopped owning it, in epoch ms. Read together
     * with `activeThreadIds` by `ownsThreadTurn`, so that question is answered
     * the same way before and after the attempt settles. Another reactor of the
     * same domain event can then decide without racing this one.
     */
    const settledThreadAtMs = new Map<string, number>();
    /**
     * Background work per provider thread with an active attempt. Held in
     * memory like the liveness registry it reads: after a restart that registry
     * is empty and the attempt is closed by its expired lease anyway.
     */
    const backgroundByThread = new Map<string, BackgroundWait>();

    const releaseThread = (threadId: string, nowMs: number) => {
      activeThreadIds.delete(threadId);
      backgroundByThread.delete(threadId);
      settledThreadAtMs.set(threadId, nowMs);
    };

    const fail = (message: string, cause?: unknown) =>
      new PersonalTasksError({ message, ...(cause === undefined ? {} : { cause }) });

    const toPublic =
      (operation: string) =>
      <A, R>(
        effect: Effect.Effect<
          A,
          PersonalTasksError | PersonalTaskRepository.PersonalTaskRepositoryError,
          R
        >,
      ) =>
        effect.pipe(
          Effect.mapError((error) =>
            error._tag === "PersonalTasksError"
              ? error
              : fail(`Personal tasks ${operation} failed.`, error),
          ),
        );

    const readWorkRecord = (taskId: PersonalTaskId) =>
      Option.match(workStore, {
        onNone: () => Effect.succeed(null as PersonalTaskWorkRecord | null),
        onSome: ({ sql }) =>
          sql<{ readonly recordJson: string }>`
            SELECT record_json AS "recordJson" FROM personal_task_work_records
            WHERE task_id = ${taskId}
          `.pipe(
            Effect.map((rows) =>
              rows[0] === undefined ? null : Option.getOrNull(decodeWorkRecord(rows[0].recordJson)),
            ),
            Effect.mapError((cause) => fail("Personal tasks could not read a work record.", cause)),
          ),
      });

    const writeWorkRecord = (taskId: PersonalTaskId, record: PersonalTaskWorkRecord) =>
      Option.match(workStore, {
        onNone: () => Effect.void,
        onSome: ({ sql }) =>
          encodeWorkRecord(record).pipe(
            Effect.flatMap(
              (json) => sql`
                INSERT INTO personal_task_work_records (task_id, record_json, updated_at)
                VALUES (${taskId}, ${json}, ${record.updatedAt})
                ON CONFLICT (task_id) DO UPDATE SET
                  record_json = excluded.record_json, updated_at = excluded.updated_at
              `,
            ),
            Effect.asVoid,
            Effect.mapError((cause) => fail("Personal tasks could not save a work record.", cause)),
          ),
      });

    /** Whether the task's tree (or its chat) had a site the user marked sensitive open. */
    const workRecordTainted = (task: PersonalTask) =>
      Option.match(workStore, {
        onNone: () => Effect.succeed(false),
        onSome: ({ exposures }) =>
          exposures
            .read([
              rootExposureKey(task.rootTaskId),
              ...(task.threadId === null ? [] : [threadExposureKey(task.threadId)]),
            ])
            .pipe(
              Effect.map((exposure) => exposure.sources.size > 0),
              // A record that cannot be read counts as tainted.
              Effect.orElseSucceed(() => true),
            ),
      });

    /**
     * A delegation carries what the delegating chat saw. A chat that had a site the user
     * marked sensitive open in an earlier request starts a new request (a new root) with
     * nothing under that root, so without this the tasks it delegates would keep work
     * records and summaries of text the chat took from that site. Groups do the same with
     * their transcript. Fails closed: if the mark cannot be carried, the delegation is refused.
     */
    const carryExposure = (
      fromKeys: ReadonlyArray<string>,
      rootTaskId: PersonalTask["rootTaskId"],
      refusal: string,
    ) =>
      Option.match(workStore, {
        onNone: () => Effect.void,
        onSome: ({ exposures }) =>
          exposures
            .copySources(fromKeys, rootExposureKey(rootTaskId))
            .pipe(Effect.mapError((cause) => fail(refusal, cause))),
      });

    const carryExposureToTree = (parent: PersonalTask, root: PersonalTask) =>
      carryExposure(
        [
          rootExposureKey(parent.rootTaskId),
          ...(parent.threadId === null ? [] : [threadExposureKey(parent.threadId)]),
        ],
        root.taskId,
        "Personal tasks could not carry the chat's sensitive-site mark to the new task, so nothing was delegated. Try again.",
      );

    /**
     * A steer carries what the steering chat has seen, the same way a delegation does: a
     * chat can open a sensitive site after it delegated, then steer with text from it.
     * Fails closed: the steer is refused when the mark cannot be carried.
     */
    const carryExposureFromSteerer = (threadId: ThreadId, target: PersonalTask) =>
      Effect.gen(function* () {
        const active = yield* activeAttemptForThread(threadId);
        const own =
          active !== null
            ? yield* repository.getTask(active.taskId)
            : yield* repository.latestTaskForThread(threadId);
        yield* carryExposure(
          [
            threadExposureKey(threadId),
            ...(Option.isSome(own) ? [rootExposureKey(own.value.rootTaskId)] : []),
          ],
          target.rootTaskId,
          "Personal tasks could not carry the chat's sensitive-site mark to the task, so the update was not sent. Try again.",
        );
      });

    /** The latest context size the thread's provider reported, in tokens. */
    const latestContextTokens = (threadId: ThreadId) =>
      Option.match(workStore, {
        onNone: () => Effect.succeed(null as number | null),
        onSome: ({ sql }) =>
          sql<{ readonly used: number | null }>`
            SELECT json_extract(payload_json, '$.usedTokens') AS "used"
            FROM projection_thread_activities
            WHERE thread_id = ${threadId} AND kind = 'context-window.updated'
            ORDER BY created_at DESC LIMIT 1
          `.pipe(
            Effect.map((rows) => (typeof rows[0]?.used === "number" ? rows[0].used : null)),
            Effect.orElseSucceed(() => null),
          ),
      });

    /**
     * Best effort, never fails the caller: a task that ended adds its status,
     * clipped result and the evidence it names to its record. Nothing is kept
     * from a tree that had a sensitive site open (the same rule as task
     * summaries in memory).
     */
    const recordWorkEnd = (task: PersonalTask) =>
      Effect.gen(function* () {
        if (Option.isNone(workStore) || !isTerminal(task.status)) return;
        if (yield* workRecordTainted(task)) return;
        const now = DateTime.formatIso(yield* DateTime.now);
        const current =
          (yield* readWorkRecord(task.taskId)) ?? emptyWorkRecord(task.objective, now);
        const next = recordAttemptEnd(
          current,
          {
            status: task.status,
            summary: task.result?.summary ?? null,
            message: task.errorMessage,
          },
          now,
        );
        if (next.lastStatus === current.lastStatus && next.lastResult === current.lastResult)
          return;
        yield* writeWorkRecord(task.taskId, next);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal task work record could not be updated", {
                taskId: task.taskId,
                cause: Cause.pretty(cause).slice(0, 1_000),
              }),
        ),
      );

    const recordWorkSteer = (task: PersonalTask, text: string) =>
      Effect.gen(function* () {
        if (Option.isNone(workStore) || (yield* workRecordTainted(task))) return;
        const now = DateTime.formatIso(yield* DateTime.now);
        const current =
          (yield* readWorkRecord(task.taskId)) ?? emptyWorkRecord(task.objective, now);
        yield* writeWorkRecord(task.taskId, recordSteer(current, text, now));
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal task work record could not take a steer", {
                taskId: task.taskId,
                cause: Cause.pretty(cause).slice(0, 1_000),
              }),
        ),
      );

    const publish = (changed: Changed) => {
      const latest = new Map<string, PersonalTask>();
      for (const task of changed) {
        latest.set(task.taskId, task);
      }
      return Effect.forEach(
        latest.values(),
        (task) =>
          PubSub.publish(upserts, task).pipe(
            Effect.andThen(isTerminal(task.status) ? recordWorkEnd(task) : Effect.void),
          ),
        { discard: true },
      );
    };

    const refreshActiveThreads = Effect.fn("PersonalTaskService.refreshActiveThreads")(
      function* () {
        const active = yield* repository.listActiveAttempts();
        activeThreadIds.clear();
        for (const attempt of active) {
          activeThreadIds.add(attempt.providerThreadId);
        }
        return active;
      },
    );

    const activeAttemptForThread = Effect.fn("PersonalTaskService.activeAttemptForThread")(
      function* (threadId: ThreadId) {
        const active = yield* repository.listActiveAttempts();
        return active.find((attempt) => attempt.providerThreadId === threadId) ?? null;
      },
    );

    const readSession = (threadId: ThreadId) =>
      snapshots.getThreadShellById(threadId).pipe(
        Effect.map((shell) => (Option.isSome(shell) ? shell.value.session : null)),
        Effect.mapError((cause) =>
          fail("Personal tasks could not read the thread session.", cause),
        ),
      );

    const requireTask = Effect.fn("PersonalTaskService.requireTask")(function* (
      taskId: PersonalTaskId,
    ) {
      const task = yield* repository.getTask(taskId);
      if (Option.isNone(task)) {
        return yield* fail(`Personal task '${taskId}' was not found.`);
      }
      return task.value;
    });

    const requireLiveBot = Effect.fn("PersonalTaskService.requireLiveBot")(function* (
      botId: PersonalBotId,
    ) {
      const live = yield* botRepository
        .listBots()
        .pipe(Effect.mapError((cause) => fail("Personal tasks bot lookup failed.", cause)));
      const bot = live.find((entry) => entry.botId === botId);
      if (bot === undefined) {
        return yield* fail(`Personal bot '${botId}' was not found.`);
      }
      return bot;
    });

    /**
     * The same test as {@link requireLiveBot}, but meant to run INSIDE the
     * transaction that inserts a task: the bot's `deleted_at` is read again on the
     * writing connection, so a `remove_bot` that committed after the first check
     * cannot leave a queued task on a removed bot. (SQLite runs one writer at a
     * time; a removal that commits between this read and the insert makes the
     * transaction fail rather than insert, and one that commits after sees the
     * task in its own busy check.)
     */
    const requireLiveBotInTransaction = Effect.fn(
      "PersonalTaskService.requireLiveBotInTransaction",
    )(function* (botId: PersonalBotId) {
      // `getBotById` returns tombstoned rows too, so the live list is the test.
      const live = yield* botRepository
        .listBots()
        .pipe(Effect.mapError((cause) => fail("Personal tasks bot lookup failed.", cause)));
      const bot = live.find((entry) => entry.botId === botId);
      if (bot === undefined) {
        return yield* fail(`Personal bot '${botId}' was not found.`);
      }
      return bot;
    });

    /** Writes `patch` while the row still has the status `task` was read with. */
    const writeTask = Effect.fn("PersonalTaskService.writeTask")(function* (
      changed: Changed,
      task: PersonalTask,
      patch: Partial<PersonalTask>,
    ) {
      // A task's result and error text come from what a bot said: a saved key it
      // printed is masked here too, in case it got past the provider event filter.
      const safePatch: Partial<PersonalTask> = {
        ...patch,
        ...(patch.result === undefined || patch.result === null
          ? {}
          : {
              result: { ...patch.result, summary: secretRedactor.redactText(patch.result.summary) },
            }),
        ...(typeof patch.errorMessage === "string"
          ? { errorMessage: secretRedactor.redactText(patch.errorMessage) }
          : {}),
      };
      const next: PersonalTask = { ...task, ...safePatch, updatedAt: yield* DateTime.now };
      const written = yield* repository.writeTask(next, task.status);
      if (!written) {
        return null;
      }
      changed.push(next);
      return next;
    });

    // A parent continues as soon as any child result is back, without waiting
    // for its siblings. A parent that is in a turn (or already queued) is left
    // alone: the result stays "returned" and the next claim, or the end of the
    // running turn, delivers everything returned so far in one continuation.
    // The status guard makes the wake idempotent: a second completion finds the
    // parent already queued.
    const wakeParent = Effect.fn("PersonalTaskService.wakeParent")(function* (
      changed: Changed,
      parentTaskId: PersonalTaskId,
    ) {
      const parent = yield* repository.getTask(parentTaskId);
      if (Option.isNone(parent) || parent.value.status !== "waiting_for_agent") {
        return;
      }
      const handoffs = yield* repository.listHandoffsByParent(parentTaskId);
      if (!handoffs.some((handoff) => handoff.status === "returned")) {
        return;
      }
      yield* writeTask(changed, parent.value, { status: "queued" });
    });

    /** Hands a terminal child's outcome to its parent's handoff row. */
    const returnToParent = Effect.fn("PersonalTaskService.returnToParent")(function* (
      changed: Changed,
      child: PersonalTask,
    ) {
      const handoff = yield* repository.getHandoffByChild(child.taskId);
      if (Option.isNone(handoff) || handoff.value.status !== "pending") {
        return;
      }
      const summary =
        child.status === "completed"
          ? (child.result?.summary ?? "")
          : `Task ${child.status}${child.errorMessage ? `: ${child.errorMessage}` : "."}`;
      yield* repository.writeHandoff({
        ...handoff.value,
        status: "returned",
        resultSummary: summary,
        updatedAt: yield* DateTime.now,
      });
      yield* wakeParent(changed, handoff.value.parentTaskId);
    });

    // A turn that ended cleanly: returned-but-undelivered results queue a
    // continuation first (even while other children are still running), then
    // open children park the task (releasing its slot, since the attempt has
    // ended), and otherwise the task is done. Only the last of these completes
    // the task and sends its summary to its own parent.
    const resolveAfterTurn = Effect.fn("PersonalTaskService.resolveAfterTurn")(function* (
      changed: Changed,
      task: PersonalTask,
      summary: string,
    ) {
      const handoffs = yield* repository.listHandoffsByParent(task.taskId);
      if (handoffs.some((handoff) => handoff.status === "returned")) {
        yield* writeTask(changed, task, { status: "queued" });
        return;
      }
      if (handoffs.some((handoff) => handoff.status === "pending")) {
        yield* writeTask(changed, task, { status: "waiting_for_agent" });
        return;
      }
      const completed = yield* writeTask(changed, task, {
        status: "completed",
        result: { summary },
        errorCategory: null,
        errorMessage: null,
        completedAt: yield* DateTime.now,
      });
      if (completed !== null) {
        yield* returnToParent(changed, completed);
      }
    });

    return {
      activeAttemptForThread,
      activeThreadIds,
      backgroundByThread,
      botRepository,
      bots,
      carryExposureFromSteerer,
      carryExposureToTree,
      engine,
      externalSlots,
      fail,
      idleWaitThreadIds,
      latestContextTokens,
      leaseOwner,
      liveness,
      lock,
      messages,
      modelFallback,
      publish,
      readSession,
      readWorkRecord,
      recordWorkSteer,
      refreshActiveThreads,
      releaseThread,
      renewalWaitSince,
      repository,
      requireLiveBot,
      requireLiveBotInTransaction,
      requireTask,
      resolveAfterTurn,
      resumingThreadIds,
      returnToParent,
      settledThreadAtMs,
      snapshots,
      toPublic,
      upserts,
      workRecordTainted,
      workStore,
      writeTask,
      writeWorkRecord,
    };
  });

export type TaskCore = Effect.Success<ReturnType<typeof makeTaskCore>>;
