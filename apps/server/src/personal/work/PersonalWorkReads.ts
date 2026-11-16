import {
  PERSONAL_WORK_QUESTION_MAX_AGE_HOURS,
  PERSONAL_WORK_QUESTION_MAX_CHARS,
  PERSONAL_WORK_QUESTIONS_MAX,
  PERSONAL_WORK_SINCE_DAYS,
  PERSONAL_WORK_SINCE_MAX,
  MessageId,
  PersonalBotId,
  PersonalProjectId,
  PersonalTaskId,
  PersonalTaskSource,
  PersonalTaskStatus,
  ThreadId,
  PersonalTasksError,
  plainLine,
  splitChoices,
  type PersonalWorkEvent,
  type PersonalWorkQuestion,
  type PersonalWorkQuestionsResult,
  type PersonalWorkSinceInput,
  type PersonalWorkSinceResult,
  type WorkTaskRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersonalProjectionRelations } from "../engine/PersonalProjectionRelations.ts";
import { MARKED_UNREAD_GRACE_MS } from "../PersonalBotRepository.ts";

const TaskRow = Schema.Struct({
  taskId: PersonalTaskId,
  botId: PersonalBotId,
  threadId: Schema.NullOr(ThreadId),
  source: PersonalTaskSource,
  parentTaskId: Schema.NullOr(PersonalTaskId),
  title: Schema.String,
  status: PersonalTaskStatus,
  at: Schema.DateTimeUtcFromString,
});

const GoalRow = Schema.Struct({
  projectId: PersonalProjectId,
  name: Schema.String,
  leadBotId: Schema.NullOr(PersonalBotId),
  state: Schema.NullOr(Schema.Literals(["done", "dropped"])),
  at: Schema.DateTimeUtcFromString,
});

const TASK_COLUMNS = `
  t.task_id AS "taskId",
  t.bot_id AS "botId",
  t.thread_id AS "threadId",
  t.source AS "source",
  t.parent_task_id AS "parentTaskId",
  t.title AS "title",
  t.status AS "status"
`;

const fail = (operation: string) => (cause: unknown) =>
  new PersonalTasksError({ message: `Could not read the work digest (${operation}).`, cause });

const decodeAll = <S extends Schema.Top>(
  schema: S,
  operation: string,
  rows: ReadonlyArray<unknown>,
): Effect.Effect<ReadonlyArray<S["Type"]>, PersonalTasksError, S["DecodingServices"]> =>
  Effect.forEach(rows, (row) =>
    Schema.decodeUnknownEffect(schema)(row).pipe(Effect.mapError(fail(operation))),
  );

const taskRef = (row: typeof TaskRow.Type): WorkTaskRef => ({
  taskId: row.taskId,
  botId: row.botId,
  threadId: row.threadId,
  source: row.source,
  parentTaskId: row.parentTaskId,
  title: row.title,
});

const idOf = (event: PersonalWorkEvent): string =>
  event.kind === "goalOpened" || event.kind === "goalClosed" ? event.projectId : event.task.taskId;

/** Failures first, then closed goals, finished work, restarts, new goals, starts. */
const KIND_ORDER: Record<PersonalWorkEvent["kind"], number> = {
  taskFailed: 0,
  goalClosed: 1,
  taskDone: 2,
  taskRestarted: 3,
  goalOpened: 4,
  taskStarted: 5,
};

const newestFirst = (events: ReadonlyArray<PersonalWorkEvent>): ReadonlyArray<PersonalWorkEvent> =>
  events.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      idOf(left).localeCompare(idOf(right)),
  );

/**
 * What the Work tab's "Since you looked" box can say: work that finished, work
 * that failed, delegated work that started, work restarted after a stall, and
 * goals opened or closed. Reads the task rows and attempt history directly
 * because the live feed replays only the newest 20 finished tasks.
 */
export const since = (
  input: PersonalWorkSinceInput,
): Effect.Effect<PersonalWorkSinceResult, PersonalTasksError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const asOf = yield* DateTime.now;
    const floor = DateTime.subtract(asOf, { days: PERSONAL_WORK_SINCE_DAYS });
    const requested = DateTime.makeUnsafe(input.since);
    const from = DateTime.isLessThan(requested, floor) ? floor : requested;
    const sinceIso = DateTime.formatIso(from);

    const finishedRows = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT ${sql.literal(TASK_COLUMNS)}, COALESCE(t.completed_at, t.updated_at) AS "at"
      FROM personal_tasks t
      WHERE COALESCE(t.completed_at, t.updated_at) > ${sinceIso}
        AND (
          (t.status = 'completed' AND t.source = 'delegation')
          OR t.status IN ('failed', 'interrupted')
        )
    `.pipe(
      Effect.mapError(fail("finished tasks")),
      Effect.flatMap((rows) => decodeAll(TaskRow, "finished tasks", rows)),
    );

    const startedRows = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT ${sql.literal(TASK_COLUMNS)}, t.created_at AS "at"
      FROM personal_tasks t
      WHERE t.source = 'delegation' AND t.created_at > ${sinceIso}
    `.pipe(
      Effect.mapError(fail("started tasks")),
      Effect.flatMap((rows) => decodeAll(TaskRow, "started tasks", rows)),
    );

    const restartedRows = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT ${sql.literal(TASK_COLUMNS)}, next_attempt.started_at AS "at"
      FROM personal_task_attempts next_attempt
      JOIN personal_tasks t ON t.task_id = next_attempt.task_id
      JOIN personal_task_attempts prev_attempt
        ON prev_attempt.task_id = next_attempt.task_id
       AND prev_attempt.attempt = next_attempt.attempt - 1
      WHERE next_attempt.started_at > ${sinceIso}
        AND prev_attempt.ended_at IS NOT NULL
        AND prev_attempt.error_category IN ('interrupted', 'provider_error')
    `.pipe(
      Effect.mapError(fail("restarted tasks")),
      Effect.flatMap((rows) => decodeAll(TaskRow, "restarted tasks", rows)),
    );

    const openedRows = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT p.project_id AS "projectId", p.name AS "name", p.lead_bot_id AS "leadBotId",
             NULL AS "state", p.created_at AS "at"
      FROM personal_projects p
      WHERE p.created_at > ${sinceIso}
    `.pipe(
      Effect.mapError(fail("opened goals")),
      Effect.flatMap((rows) => decodeAll(GoalRow, "opened goals", rows)),
    );

    const closedRows = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT p.project_id AS "projectId", p.name AS "name", NULL AS "leadBotId",
             p.state AS "state", p.closed_at AS "at"
      FROM personal_projects p
      WHERE p.closed_at > ${sinceIso} AND p.state IN ('done', 'dropped')
    `.pipe(
      Effect.mapError(fail("closed goals")),
      Effect.flatMap((rows) => decodeAll(GoalRow, "closed goals", rows)),
    );

    const events: Array<PersonalWorkEvent> = [];
    for (const row of finishedRows) {
      events.push(
        row.status === "completed"
          ? { kind: "taskDone", at: row.at, task: taskRef(row) }
          : {
              kind: "taskFailed",
              at: row.at,
              task: taskRef(row),
              status: row.status === "interrupted" ? "interrupted" : "failed",
            },
      );
    }
    for (const row of startedRows) {
      events.push({ kind: "taskStarted", at: row.at, task: taskRef(row) });
    }
    for (const row of restartedRows) {
      events.push({ kind: "taskRestarted", at: row.at, task: taskRef(row) });
    }
    for (const row of openedRows) {
      if (row.leadBotId === null) continue;
      events.push({
        kind: "goalOpened",
        at: row.at,
        projectId: row.projectId,
        name: row.name,
        leadBotId: row.leadBotId,
      });
    }
    for (const row of closedRows) {
      if (row.state === null) continue;
      events.push({
        kind: "goalClosed",
        at: row.at,
        projectId: row.projectId,
        name: row.name,
        outcome: row.state,
      });
    }

    const sorted = newestFirst(events);
    const kept = sorted.slice(0, PERSONAL_WORK_SINCE_MAX);
    return { events: kept, omitted: sorted.length - kept.length, asOf };
  });

const QuestionRow = Schema.Struct({
  threadId: ThreadId,
  botId: PersonalBotId,
  messageId: MessageId,
  askedAt: Schema.DateTimeUtcFromString,
  /** When the owner last had the chat open; null when never. */
  lastViewedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** When the owner marked the chat unread; null when not. */
  markedUnreadAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Null when the bot hides previews. */
  text: Schema.NullOr(Schema.String),
  hidden: Schema.Number,
});

/**
 * The reply's asking line: its last sentence that ends in a question mark, else
 * its last line. Null when the block carried no words at all.
 */
const questionFromReply = (text: string): string | null => {
  const body = splitChoices(text).body;
  const lines = body
    .split(/\r?\n/)
    .map(plainLine)
    .filter((line) => line.length > 0);
  const asking = lines.findLast((line) => line.endsWith("?")) ?? lines.at(-1);
  if (asking === undefined) return null;
  if (asking.length <= PERSONAL_WORK_QUESTION_MAX_CHARS) return asking;
  return `${asking.slice(0, PERSONAL_WORK_QUESTION_MAX_CHARS - 1).trimEnd()}…`;
};

/**
 * Whether a question still waits for the owner: a chat never opened, a question
 * asked after the last view, or a chat marked unread after that view (the mark
 * counts from `MARKED_UNREAD_GRACE_MS` later, so the leave that follows
 * "Mark unread" does not clear it). Otherwise the owner has seen the chat.
 * All three times are server clock, compared as epoch millis.
 */
export function questionAwaitsOwner(row: {
  readonly askedAt: DateTime.Utc;
  readonly lastViewedAt: DateTime.Utc | null;
  readonly markedUnreadAt: DateTime.Utc | null;
}): boolean {
  if (row.lastViewedAt === null) return true;
  const viewedMs = DateTime.toEpochMillis(row.lastViewedAt);
  if (DateTime.toEpochMillis(row.askedAt) > viewedMs) return true;
  return (
    row.markedUnreadAt !== null &&
    DateTime.toEpochMillis(row.markedUnreadAt) + MARKED_UNREAD_GRACE_MS > viewedMs
  );
}

/**
 * Bot questions the owner can answer from the Work tab: each live bot chat's
 * newest message, when it is an assistant reply under 72 hours old that ends in
 * a choices block. Delegation task chats are left out because there the bot
 * answers its lead, and a group relay is not the owner's conversation. A chat
 * the owner opened since the question is left out too (`questionAwaitsOwner`).
 */
export const questions = (): Effect.Effect<
  PersonalWorkQuestionsResult,
  PersonalTasksError,
  SqlClient.SqlClient | PersonalProjectionRelations
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rel = yield* PersonalProjectionRelations;
    const asOf = yield* DateTime.now;
    const floor = DateTime.formatIso(
      DateTime.subtract(asOf, { hours: PERSONAL_WORK_QUESTION_MAX_AGE_HOURS }),
    );

    const rows = yield* sql<Readonly<Record<string, unknown>>>`
      SELECT
        t.thread_id AS "threadId",
        t.bot_id AS "botId",
        m.message_id AS "messageId",
        m.created_at AS "askedAt",
        t.last_viewed_at AS "lastViewedAt",
        t.marked_unread_at AS "markedUnreadAt",
        CASE WHEN COALESCE(b.hide_previews, 0) = 1 THEN NULL ELSE m.text END AS "text",
        COALESCE(b.hide_previews, 0) AS "hidden"
      FROM personal_bot_threads t
      JOIN personal_bots b ON b.bot_id = t.bot_id
      JOIN ${sql.unsafe(rel.threads)} p ON p.thread_id = t.thread_id
      JOIN ${sql.unsafe(rel.messages)} m ON m.message_id = (
        SELECT n.message_id
        FROM ${sql.unsafe(rel.messages)} n
        WHERE n.thread_id = t.thread_id AND n.role IN ('user', 'assistant')
        ORDER BY n.created_at DESC, n.message_id DESC
        LIMIT 1
      )
      WHERE t.archived_at IS NULL
        AND p.archived_at IS NULL
        AND p.deleted_at IS NULL
        AND b.deleted_at IS NULL
        AND b.enabled = 1
        AND m.role = 'assistant'
        AND m.created_at > ${floor}
        AND NOT EXISTS (
          SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = t.thread_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM personal_tasks task
          WHERE task.thread_id = t.thread_id AND task.source = 'delegation'
        )
      ORDER BY m.created_at DESC, m.message_id DESC
    `.pipe(
      Effect.mapError(fail("questions")),
      Effect.flatMap((found) => decodeAll(QuestionRow, "questions", found)),
    );

    const kept: PersonalWorkQuestion[] = [];
    for (const row of rows) {
      if (kept.length >= PERSONAL_WORK_QUESTIONS_MAX) break;
      // A question the owner has seen leaves the list before it can take a slot.
      if (!questionAwaitsOwner(row)) continue;
      const options = row.text === null ? null : splitChoices(row.text).options;
      if (options === null && row.hidden === 0) continue;
      kept.push({
        threadId: row.threadId,
        botId: row.botId,
        messageId: row.messageId,
        askedAt: row.askedAt,
        question: row.text === null ? null : questionFromReply(row.text),
        options: row.hidden === 0 ? options : null,
      });
    }
    return { questions: kept };
  });
