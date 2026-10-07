// Reading tasks: detail, lists, the live feed, history, the work record and the chat history.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { type PersonalTask, type PersonalTaskDetail } from "@t3tools/contracts";
import { serverPerfOptimizationOn } from "../perfFlags.ts";
import { applyWorkRecordPatch, emptyWorkRecord } from "./workRecord.ts";
import {
  TASK_HISTORY_DEFAULT_LIMIT,
  TASK_HISTORY_MAX_LIMIT,
  TASK_RELATED_MAX_IDS,
  TASK_REPLAY_TERMINAL_LIMIT,
  TASK_REPLAY_TERMINAL_LIMIT_FULL,
  toTaskSummary,
} from "./taskResultPolicy.ts";
import type { TaskCore } from "./taskCore.ts";
import type { PersonalTaskService } from "./PersonalTaskService.ts";

export const makeTaskQueries = (core: TaskCore) => {
  const {
    activeAttemptForThread,
    fail,
    lock,
    readWorkRecord,
    repository,
    requireTask,
    toPublic,
    upserts,
    workRecordTainted,
    workStore,
    writeWorkRecord,
  } = core;

  const get: PersonalTaskService["Service"]["get"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId);
      const [attempts, children, handoff] = yield* Effect.all([
        repository.listAttempts(task.taskId),
        repository.listHandoffsByParent(task.taskId),
        repository.getHandoffByChild(task.taskId),
      ]);
      const workRecord = yield* readWorkRecord(task.taskId).pipe(Effect.orElseSucceed(() => null));
      return {
        task,
        attempts: [...attempts],
        children: [...children],
        handoff: Option.getOrNull(handoff),
        workRecord,
      } satisfies PersonalTaskDetail;
    }).pipe(toPublic("get"));

  const workRecord: PersonalTaskService["Service"]["workRecord"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId);
      return yield* readWorkRecord(task.taskId);
    }).pipe(toPublic("workRecord"));

  const updateWorkRecord: PersonalTaskService["Service"]["updateWorkRecord"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          if (yield* workRecordTainted(task)) {
            return yield* fail(
              "This task's chat had a site the user marked sensitive open, so nothing from it is kept in a work record. Put it in your result instead.",
            );
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const current =
            (yield* readWorkRecord(task.taskId)) ?? emptyWorkRecord(task.objective, now);
          const next = applyWorkRecordPatch(current, input.patch, now);
          yield* writeWorkRecord(task.taskId, next);
          return next;
        }),
      )
      .pipe(toPublic("updateWorkRecord"));

  const taskForThread: PersonalTaskService["Service"]["taskForThread"] = (input) =>
    Effect.gen(function* () {
      const attempt = yield* activeAttemptForThread(input.threadId);
      return attempt === null
        ? Option.none<PersonalTask>()
        : yield* repository.getTask(attempt.taskId);
    }).pipe(toPublic("taskForThread"));

  const recordNotifyDecision: PersonalTaskService["Service"]["recordNotifyDecision"] = (input) =>
    repository
      .recordNotifyDecision(input)
      .pipe(
        Effect.andThen(repository.getNotifyState(input.taskId)),
        toPublic("recordNotifyDecision"),
      );

  const CHAT_HISTORY_TEXT_CHARS = 1_200;
  const chatHistory: PersonalTaskService["Service"]["chatHistory"] = (input) =>
    Effect.gen(function* () {
      if (Option.isNone(workStore)) return { messages: [], hasMore: false };
      const { sql } = workStore.value;
      const limit = Math.min(20, Math.max(1, Math.floor(input.limit)));
      const before =
        input.beforeMessageId === undefined
          ? []
          : yield* sql<{ readonly at: string }>`
              SELECT created_at AS "at" FROM projection_thread_messages
              WHERE message_id = ${input.beforeMessageId} AND thread_id = ${input.threadId}
            `;
      const beforeAt = before[0]?.at ?? null;
      const needle = input.query?.trim() ?? "";
      const rows = yield* sql<{
        readonly messageId: string;
        readonly role: string;
        readonly at: string;
        readonly text: string;
      }>`
        SELECT message_id AS "messageId", role, created_at AS "at", text
        FROM projection_thread_messages
        WHERE thread_id = ${input.threadId} AND role IN ('user', 'assistant')
          AND is_streaming = 0
          AND ${beforeAt === null ? sql`1 = 1` : sql`created_at < ${beforeAt}`}
          AND ${needle.length === 0 ? sql`1 = 1` : sql`instr(lower(text), lower(${needle})) > 0`}
        ORDER BY created_at DESC
        LIMIT ${limit + 1}
      `;
      return {
        messages: rows.slice(0, limit).map((row) => ({
          messageId: row.messageId,
          role: row.role,
          at: row.at,
          text:
            row.text.length <= CHAT_HISTORY_TEXT_CHARS
              ? row.text
              : `${row.text.slice(0, CHAT_HISTORY_TEXT_CHARS)} [...]`,
          clipped: row.text.length > CHAT_HISTORY_TEXT_CHARS,
        })),
        hasMore: rows.length > limit,
      };
    }).pipe(
      Effect.mapError((cause) => fail("Personal tasks could not read the chat.", cause)),
      toPublic("chatHistory"),
    );

  const list: PersonalTaskService["Service"]["list"] = (filter) =>
    repository.listTasks(filter).pipe(
      Effect.map((tasks) => ({ tasks: [...tasks] })),
      toPublic("list"),
    );

  // Subscribe before reading the replay so no change falls in between; a
  // task changed in that window is sent twice, which upserts absorb.
  const subscribe: PersonalTaskService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const summaries = serverPerfOptimizationOn("task-summaries");
      const subscription = yield* PubSub.subscribe(upserts);
      // A phone PWA reconnects constantly; replaying every task ever would
      // grow without bound, so finished history is capped here.
      const current = yield* repository
        .listForReplay(summaries ? TASK_REPLAY_TERMINAL_LIMIT : TASK_REPLAY_TERMINAL_LIMIT_FULL)
        .pipe(toPublic("subscribe"));
      return Stream.concat(
        Stream.fromIterable(current),
        Stream.fromSubscription(subscription),
      ).pipe(
        Stream.map((task) => ({
          type: "upsert" as const,
          task: summaries ? toTaskSummary(task) : task,
        })),
      );
    }),
  );

  const history: PersonalTaskService["Service"]["history"] = (input) => {
    const limit = Math.min(
      TASK_HISTORY_MAX_LIMIT,
      Math.max(1, Math.floor(input.limit ?? TASK_HISTORY_DEFAULT_LIMIT)),
    );
    // One extra row says whether another page exists.
    return repository.listTerminalPage({ before: input.before ?? null, limit: limit + 1 }).pipe(
      Effect.map((tasks) => ({
        tasks: tasks.slice(0, limit).map(toTaskSummary),
        hasMore: tasks.length > limit,
      })),
      toPublic("history"),
    );
  };

  const related: PersonalTaskService["Service"]["related"] = (input) =>
    repository
      .listRelated({
        threadId: input.threadId ?? null,
        taskIds: (input.taskIds ?? []).slice(0, TASK_RELATED_MAX_IDS),
      })
      .pipe(
        Effect.map((tasks) => ({ tasks: tasks.map(toTaskSummary) })),
        toPublic("related"),
      );

  return {
    chatHistory,
    get,
    history,
    list,
    recordNotifyDecision,
    related,
    subscribe,
    taskForThread,
    updateWorkRecord,
    workRecord,
  };
};

export type TaskQueries = ReturnType<typeof makeTaskQueries>;
