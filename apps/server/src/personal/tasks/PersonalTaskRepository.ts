import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";

import {
  PersonalBotId,
  PersonalDelegationBrief,
  PersonalHandoffStatus,
  PersonalTaskId,
  PersonalTaskResult,
  PersonalTaskSource,
  PersonalTaskStatus,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  type PersonalHandoff,
  type PersonalTask,
  type PersonalTaskAttempt,
  type PersonalTaskListInput,
  PERSONAL_TASK_TERMINAL_STATUSES,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type PersonalTaskRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const TaskDbRow = Schema.Struct({
  taskId: PersonalTaskId,
  rootTaskId: PersonalTaskId,
  parentTaskId: Schema.NullOr(PersonalTaskId),
  botId: PersonalBotId,
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  objective: Schema.String,
  acceptanceCriteria: Schema.String,
  expectedOutput: Schema.String,
  status: PersonalTaskStatus,
  source: PersonalTaskSource,
  idempotencyKey: TrimmedNonEmptyString,
  depth: Schema.Number,
  maxDepth: Schema.Number,
  maxChildren: Schema.Number,
  result: Schema.NullOr(Schema.fromJsonString(PersonalTaskResult)),
  errorCategory: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  availableAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const AttemptDbRow = Schema.Struct({
  taskId: PersonalTaskId,
  attempt: Schema.Number,
  providerThreadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  leaseOwner: Schema.String,
  leaseExpiresAt: Schema.DateTimeUtcFromString,
  heartbeatAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  errorCategory: Schema.NullOr(Schema.String),
  resumable: Schema.Number,
});

const HandoffDbRow = Schema.Struct({
  parentTaskId: PersonalTaskId,
  childTaskId: PersonalTaskId,
  brief: Schema.fromJsonString(PersonalDelegationBrief),
  dependencies: Schema.fromJsonString(Schema.Array(PersonalTaskId)),
  resultSummary: Schema.NullOr(Schema.String),
  status: PersonalHandoffStatus,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const isSqlError = Schema.is(SqlError.SqlError);
const decodeTaskRow = Schema.decodeUnknownEffect(TaskDbRow);
const decodeAttemptRow = Schema.decodeUnknownEffect(AttemptDbRow);
const decodeHandoffRow = Schema.decodeUnknownEffect(HandoffDbRow);

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);
const isoOrNull = (value: DateTime.Utc | null) => (value === null ? null : iso(value));

const TASK_COLUMNS = `
  task_id AS "taskId",
  root_task_id AS "rootTaskId",
  parent_task_id AS "parentTaskId",
  bot_id AS "botId",
  thread_id AS "threadId",
  title AS "title",
  objective AS "objective",
  acceptance_criteria AS "acceptanceCriteria",
  expected_output AS "expectedOutput",
  status AS "status",
  source AS "source",
  idempotency_key AS "idempotencyKey",
  depth AS "depth",
  max_depth AS "maxDepth",
  max_children AS "maxChildren",
  result_json AS "result",
  error_category AS "errorCategory",
  error_message AS "errorMessage",
  available_at AS "availableAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt"
`;

const ATTEMPT_COLUMNS = `
  task_id AS "taskId",
  attempt AS "attempt",
  provider_thread_id AS "providerThreadId",
  turn_id AS "turnId",
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  heartbeat_at AS "heartbeatAt",
  started_at AS "startedAt",
  ended_at AS "endedAt",
  error_category AS "errorCategory",
  resumable AS "resumable"
`;

const HANDOFF_COLUMNS = `
  parent_task_id AS "parentTaskId",
  child_task_id AS "childTaskId",
  brief_json AS "brief",
  dependencies_json AS "dependencies",
  result_summary AS "resultSummary",
  status AS "status",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class PersonalTaskRepository extends Context.Service<
  PersonalTaskRepository,
  {
    /** Runs `effect` in one SQLite transaction. */
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PersonalTaskRepositoryError, R>;
    /** Inserts unless the idempotency key exists. Returns whether it inserted. */
    readonly insertTask: (
      task: PersonalTask,
    ) => Effect.Effect<boolean, PersonalTaskRepositoryError>;
    readonly getTask: (
      taskId: PersonalTaskId,
    ) => Effect.Effect<Option.Option<PersonalTask>, PersonalTaskRepositoryError>;
    readonly getTaskByIdempotencyKey: (
      key: string,
    ) => Effect.Effect<Option.Option<PersonalTask>, PersonalTaskRepositoryError>;
    readonly listTasks: (
      filter: PersonalTaskListInput,
    ) => Effect.Effect<ReadonlyArray<PersonalTask>, PersonalTaskRepositoryError>;
    /**
     * The subscribe replay: every non-terminal task plus the newest
     * `terminalLimit` finished ones, newest first. Older history stays
     * reachable through `listTasks`.
     */
    readonly listForReplay: (
      terminalLimit: number,
    ) => Effect.Effect<ReadonlyArray<PersonalTask>, PersonalTaskRepositoryError>;
    /** Every task below `taskId`, following parent links by task id. */
    readonly listDescendants: (
      taskId: PersonalTaskId,
    ) => Effect.Effect<ReadonlyArray<PersonalTask>, PersonalTaskRepositoryError>;
    readonly countTasksInRoot: (
      rootTaskId: PersonalTaskId,
    ) => Effect.Effect<number, PersonalTaskRepositoryError>;
    /**
     * Writes every mutable column of `task`, only while the row still has
     * `expectedStatus`. Returns whether the row was written.
     */
    readonly writeTask: (
      task: PersonalTask,
      expectedStatus: PersonalTask["status"],
    ) => Effect.Effect<boolean, PersonalTaskRepositoryError>;
    /** Queued tasks, plus rate-limited tasks whose backoff has elapsed, oldest first. */
    readonly listClaimable: (
      now: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<PersonalTask>, PersonalTaskRepositoryError>;
    readonly insertAttempt: (
      attempt: PersonalTaskAttempt,
    ) => Effect.Effect<void, PersonalTaskRepositoryError>;
    readonly writeAttempt: (
      attempt: PersonalTaskAttempt,
    ) => Effect.Effect<void, PersonalTaskRepositoryError>;
    readonly listAttempts: (
      taskId: PersonalTaskId,
    ) => Effect.Effect<ReadonlyArray<PersonalTaskAttempt>, PersonalTaskRepositoryError>;
    /** Attempts with no end: the occupied execution slots. */
    readonly listActiveAttempts: () => Effect.Effect<
      ReadonlyArray<PersonalTaskAttempt>,
      PersonalTaskRepositoryError
    >;
    readonly heartbeat: (input: {
      readonly leaseOwner: string;
      readonly now: DateTime.Utc;
      readonly leaseExpiresAt: DateTime.Utc;
    }) => Effect.Effect<void, PersonalTaskRepositoryError>;
    readonly insertHandoff: (
      handoff: PersonalHandoff,
    ) => Effect.Effect<void, PersonalTaskRepositoryError>;
    readonly writeHandoff: (
      handoff: PersonalHandoff,
    ) => Effect.Effect<void, PersonalTaskRepositoryError>;
    readonly getHandoffByChild: (
      childTaskId: PersonalTaskId,
    ) => Effect.Effect<Option.Option<PersonalHandoff>, PersonalTaskRepositoryError>;
    readonly listHandoffsByParent: (
      parentTaskId: PersonalTaskId,
    ) => Effect.Effect<ReadonlyArray<PersonalHandoff>, PersonalTaskRepositoryError>;
    /** The most recently created task that ran on `threadId`. */
    readonly latestTaskForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersonalTask>, PersonalTaskRepositoryError>;
    readonly insertResumeNote: (
      note: PersonalTaskResumeNote,
    ) => Effect.Effect<void, PersonalTaskRepositoryError>;
    readonly listUndeliveredNotes: (
      taskId: PersonalTaskId,
    ) => Effect.Effect<ReadonlyArray<PersonalTaskResumeNote>, PersonalTaskRepositoryError>;
    readonly markNotesDelivered: (
      taskId: PersonalTaskId,
      now: DateTime.Utc,
    ) => Effect.Effect<void, PersonalTaskRepositoryError>;
    /** User- or browser-waiting tasks that have an undelivered resume note. */
    readonly listTasksAwaitingResume: () => Effect.Effect<
      ReadonlyArray<PersonalTask>,
      PersonalTaskRepositoryError
    >;
  }
>()("t3/personal/tasks/PersonalTaskRepository") {}

/** Text a task's next turn opens with; `restartSession` waits for a fresh provider process. */
export interface PersonalTaskResumeNote {
  readonly noteId: string;
  readonly taskId: PersonalTaskId;
  readonly text: string;
  readonly restartSession: boolean;
  readonly createdAt: DateTime.Utc;
}

const ResumeNoteDbRow = Schema.Struct({
  noteId: Schema.String,
  taskId: PersonalTaskId,
  text: Schema.String,
  restartSession: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
});
const decodeResumeNoteRow = Schema.decodeUnknownEffect(ResumeNoteDbRow);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const sqlError = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation: `PersonalTaskRepository.${operation}`, cause });

  const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
    PersistenceDecodeError.fromSchemaError(`PersonalTaskRepository.${operation}`, cause);

  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) => effect.pipe(Effect.mapError(sqlError(operation)));

  const decodeTasks = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) => decodeTaskRow(row).pipe(Effect.mapError(decodeError(operation))));

  const firstTask = (operation: string, rows: ReadonlyArray<unknown>) =>
    decodeTasks(operation, rows.slice(0, 1)).pipe(
      Effect.map((tasks) => Option.fromNullishOr(tasks[0])),
    );

  const toAttempt = (row: typeof AttemptDbRow.Type): PersonalTaskAttempt => ({
    ...row,
    resumable: row.resumable === 1,
  });

  const decodeAttempts = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeAttemptRow(row).pipe(Effect.mapError(decodeError(operation)), Effect.map(toAttempt)),
    );

  const decodeHandoffs = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeHandoffRow(row).pipe(Effect.mapError(decodeError(operation))),
    );

  const transaction: PersonalTaskRepository["Service"]["transaction"] = (effect) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) => (isSqlError(error) ? sqlError("transaction")(error) : error)),
      );

  const insertTask: PersonalTaskRepository["Service"]["insertTask"] = (task) =>
    query(
      "insertTask",
      sql`
        INSERT INTO personal_tasks (
          task_id, root_task_id, parent_task_id, bot_id, thread_id, title, objective,
          acceptance_criteria, expected_output, status, source, idempotency_key, depth,
          max_depth, max_children, result_json, error_category, error_message, available_at,
          created_at, updated_at, started_at, completed_at
        )
        VALUES (
          ${task.taskId}, ${task.rootTaskId}, ${task.parentTaskId}, ${task.botId},
          ${task.threadId}, ${task.title}, ${task.objective}, ${task.acceptanceCriteria},
          ${task.expectedOutput}, ${task.status}, ${task.source}, ${task.idempotencyKey},
          ${task.depth}, ${task.maxDepth}, ${task.maxChildren},
          ${task.result === null ? null : JSON.stringify(task.result)},
          ${task.errorCategory}, ${task.errorMessage}, ${isoOrNull(task.availableAt)},
          ${iso(task.createdAt)}, ${iso(task.updatedAt)}, ${isoOrNull(task.startedAt)},
          ${isoOrNull(task.completedAt)}
        )
        ON CONFLICT(idempotency_key) DO NOTHING
        RETURNING task_id AS "taskId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const getTask: PersonalTaskRepository["Service"]["getTask"] = (taskId) =>
    query(
      "getTask",
      sql`SELECT ${sql.literal(TASK_COLUMNS)} FROM personal_tasks WHERE task_id = ${taskId}`,
    ).pipe(Effect.flatMap((rows) => firstTask("getTask", rows)));

  const getTaskByIdempotencyKey: PersonalTaskRepository["Service"]["getTaskByIdempotencyKey"] = (
    key,
  ) =>
    query(
      "getTaskByIdempotencyKey",
      sql`SELECT ${sql.literal(TASK_COLUMNS)} FROM personal_tasks WHERE idempotency_key = ${key}`,
    ).pipe(Effect.flatMap((rows) => firstTask("getTaskByIdempotencyKey", rows)));

  const listTasks: PersonalTaskRepository["Service"]["listTasks"] = (filter) => {
    const conditions = [
      filter.statuses !== undefined && filter.statuses.length > 0
        ? sql.in("status", filter.statuses)
        : undefined,
      filter.botId !== undefined ? sql`bot_id = ${filter.botId}` : undefined,
      filter.rootTaskId !== undefined ? sql`root_task_id = ${filter.rootTaskId}` : undefined,
    ].filter((condition) => condition !== undefined);
    return query(
      "listTasks",
      sql`
        SELECT ${sql.literal(TASK_COLUMNS)}
        FROM personal_tasks
        ${conditions.length > 0 ? sql`WHERE ${sql.and(conditions)}` : sql``}
        ORDER BY created_at DESC, rowid DESC
      `,
    ).pipe(Effect.flatMap((rows) => decodeTasks("listTasks", rows)));
  };

  const listForReplay: PersonalTaskRepository["Service"]["listForReplay"] = (terminalLimit) =>
    query(
      "listForReplay",
      sql`
        SELECT ${sql.literal(TASK_COLUMNS)} FROM (
          SELECT *, rowid AS row_order FROM personal_tasks
          WHERE NOT (${sql.in("status", PERSONAL_TASK_TERMINAL_STATUSES)})
          UNION ALL
          SELECT * FROM (
            SELECT *, rowid AS row_order FROM personal_tasks
            WHERE ${sql.in("status", PERSONAL_TASK_TERMINAL_STATUSES)}
            ORDER BY created_at DESC, rowid DESC
            LIMIT ${terminalLimit}
          )
        )
        ORDER BY created_at DESC, row_order DESC
      `,
    ).pipe(Effect.flatMap((rows) => decodeTasks("listForReplay", rows)));

  const listDescendants: PersonalTaskRepository["Service"]["listDescendants"] = (taskId) =>
    query(
      "listDescendants",
      sql`
        WITH RECURSIVE descendants(task_id) AS (
          SELECT task_id FROM personal_tasks WHERE parent_task_id = ${taskId}
          UNION
          SELECT t.task_id FROM personal_tasks t
          JOIN descendants d ON t.parent_task_id = d.task_id
        )
        SELECT ${sql.literal(TASK_COLUMNS)}
        FROM personal_tasks
        WHERE task_id IN (SELECT task_id FROM descendants)
        ORDER BY depth ASC, created_at ASC, rowid ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeTasks("listDescendants", rows)));

  const countTasksInRoot: PersonalTaskRepository["Service"]["countTasksInRoot"] = (rootTaskId) =>
    query<{ readonly count: number }>(
      "countTasksInRoot",
      sql`SELECT COUNT(*) AS "count" FROM personal_tasks WHERE root_task_id = ${rootTaskId}`,
    ).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

  const writeTask: PersonalTaskRepository["Service"]["writeTask"] = (task, expectedStatus) =>
    query(
      "writeTask",
      sql`
        UPDATE personal_tasks
        SET thread_id = ${task.threadId},
            status = ${task.status},
            result_json = ${task.result === null ? null : JSON.stringify(task.result)},
            error_category = ${task.errorCategory},
            error_message = ${task.errorMessage},
            available_at = ${isoOrNull(task.availableAt)},
            updated_at = ${iso(task.updatedAt)},
            started_at = ${isoOrNull(task.startedAt)},
            completed_at = ${isoOrNull(task.completedAt)}
        WHERE task_id = ${task.taskId}
          AND status = ${expectedStatus}
        RETURNING task_id AS "taskId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const listClaimable: PersonalTaskRepository["Service"]["listClaimable"] = (now) =>
    query(
      "listClaimable",
      sql`
        SELECT ${sql.literal(TASK_COLUMNS)}
        FROM personal_tasks
        WHERE status = 'queued'
           OR (status = 'rate_limited' AND (available_at IS NULL OR available_at <= ${iso(now)}))
        ORDER BY created_at ASC, rowid ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeTasks("listClaimable", rows)));

  const insertAttempt: PersonalTaskRepository["Service"]["insertAttempt"] = (attempt) =>
    query(
      "insertAttempt",
      sql`
        INSERT INTO personal_task_attempts (
          task_id, attempt, provider_thread_id, turn_id, lease_owner, lease_expires_at,
          heartbeat_at, started_at, ended_at, error_category, resumable
        )
        VALUES (
          ${attempt.taskId}, ${attempt.attempt}, ${attempt.providerThreadId}, ${attempt.turnId},
          ${attempt.leaseOwner}, ${iso(attempt.leaseExpiresAt)}, ${iso(attempt.heartbeatAt)},
          ${iso(attempt.startedAt)}, ${isoOrNull(attempt.endedAt)}, ${attempt.errorCategory},
          ${attempt.resumable ? 1 : 0}
        )
      `,
    ).pipe(Effect.asVoid);

  const writeAttempt: PersonalTaskRepository["Service"]["writeAttempt"] = (attempt) =>
    query(
      "writeAttempt",
      sql`
        UPDATE personal_task_attempts
        SET turn_id = ${attempt.turnId},
            lease_owner = ${attempt.leaseOwner},
            lease_expires_at = ${iso(attempt.leaseExpiresAt)},
            heartbeat_at = ${iso(attempt.heartbeatAt)},
            ended_at = ${isoOrNull(attempt.endedAt)},
            error_category = ${attempt.errorCategory},
            resumable = ${attempt.resumable ? 1 : 0}
        WHERE task_id = ${attempt.taskId}
          AND attempt = ${attempt.attempt}
      `,
    ).pipe(Effect.asVoid);

  const listAttempts: PersonalTaskRepository["Service"]["listAttempts"] = (taskId) =>
    query(
      "listAttempts",
      sql`
        SELECT ${sql.literal(ATTEMPT_COLUMNS)}
        FROM personal_task_attempts
        WHERE task_id = ${taskId}
        ORDER BY attempt ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeAttempts("listAttempts", rows)));

  const listActiveAttempts: PersonalTaskRepository["Service"]["listActiveAttempts"] = () =>
    query(
      "listActiveAttempts",
      sql`
        SELECT ${sql.literal(ATTEMPT_COLUMNS)}
        FROM personal_task_attempts
        WHERE ended_at IS NULL
        ORDER BY started_at ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeAttempts("listActiveAttempts", rows)));

  const heartbeat: PersonalTaskRepository["Service"]["heartbeat"] = (input) =>
    query(
      "heartbeat",
      sql`
        UPDATE personal_task_attempts
        SET heartbeat_at = ${iso(input.now)},
            lease_expires_at = ${iso(input.leaseExpiresAt)}
        WHERE ended_at IS NULL
          AND lease_owner = ${input.leaseOwner}
      `,
    ).pipe(Effect.asVoid);

  const insertHandoff: PersonalTaskRepository["Service"]["insertHandoff"] = (handoff) =>
    query(
      "insertHandoff",
      sql`
        INSERT INTO personal_handoffs (
          parent_task_id, child_task_id, brief_json, dependencies_json, result_summary,
          status, created_at, updated_at
        )
        VALUES (
          ${handoff.parentTaskId}, ${handoff.childTaskId}, ${JSON.stringify(handoff.brief)},
          ${JSON.stringify(handoff.dependencies)}, ${handoff.resultSummary}, ${handoff.status},
          ${iso(handoff.createdAt)}, ${iso(handoff.updatedAt)}
        )
        ON CONFLICT(child_task_id) DO NOTHING
      `,
    ).pipe(Effect.asVoid);

  const writeHandoff: PersonalTaskRepository["Service"]["writeHandoff"] = (handoff) =>
    query(
      "writeHandoff",
      sql`
        UPDATE personal_handoffs
        SET result_summary = ${handoff.resultSummary},
            status = ${handoff.status},
            updated_at = ${iso(handoff.updatedAt)}
        WHERE child_task_id = ${handoff.childTaskId}
      `,
    ).pipe(Effect.asVoid);

  const getHandoffByChild: PersonalTaskRepository["Service"]["getHandoffByChild"] = (childTaskId) =>
    query(
      "getHandoffByChild",
      sql`
        SELECT ${sql.literal(HANDOFF_COLUMNS)}
        FROM personal_handoffs
        WHERE child_task_id = ${childTaskId}
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeHandoffs("getHandoffByChild", rows.slice(0, 1))),
      Effect.map((handoffs) => Option.fromNullishOr(handoffs[0])),
    );

  const listHandoffsByParent: PersonalTaskRepository["Service"]["listHandoffsByParent"] = (
    parentTaskId,
  ) =>
    query(
      "listHandoffsByParent",
      sql`
        SELECT ${sql.literal(HANDOFF_COLUMNS)}
        FROM personal_handoffs
        WHERE parent_task_id = ${parentTaskId}
        ORDER BY created_at ASC, child_task_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeHandoffs("listHandoffsByParent", rows)));

  const latestTaskForThread: PersonalTaskRepository["Service"]["latestTaskForThread"] = (
    threadId,
  ) =>
    query(
      "latestTaskForThread",
      sql`
        SELECT ${sql.literal(TASK_COLUMNS)}
        FROM personal_tasks
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `,
    ).pipe(Effect.flatMap((rows) => firstTask("latestTaskForThread", rows)));

  const insertResumeNote: PersonalTaskRepository["Service"]["insertResumeNote"] = (note) =>
    query(
      "insertResumeNote",
      sql`
        INSERT INTO personal_task_resume_notes (
          note_id, task_id, text, restart_session, created_at, delivered_at
        )
        VALUES (
          ${note.noteId}, ${note.taskId}, ${note.text}, ${note.restartSession ? 1 : 0},
          ${iso(note.createdAt)}, NULL
        )
        ON CONFLICT(note_id) DO NOTHING
      `,
    ).pipe(Effect.asVoid);

  const listUndeliveredNotes: PersonalTaskRepository["Service"]["listUndeliveredNotes"] = (
    taskId,
  ) =>
    query(
      "listUndeliveredNotes",
      sql`
        SELECT
          note_id AS "noteId",
          task_id AS "taskId",
          text AS "text",
          restart_session AS "restartSession",
          created_at AS "createdAt"
        FROM personal_task_resume_notes
        WHERE task_id = ${taskId}
          AND delivered_at IS NULL
        ORDER BY created_at ASC, rowid ASC
      `,
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeResumeNoteRow(row).pipe(
            Effect.mapError(decodeError("listUndeliveredNotes")),
            Effect.map((decoded) => ({ ...decoded, restartSession: decoded.restartSession === 1 })),
          ),
        ),
      ),
    );

  const markNotesDelivered: PersonalTaskRepository["Service"]["markNotesDelivered"] = (
    taskId,
    now,
  ) =>
    query(
      "markNotesDelivered",
      sql`
        UPDATE personal_task_resume_notes
        SET delivered_at = ${iso(now)}
        WHERE task_id = ${taskId}
          AND delivered_at IS NULL
      `,
    ).pipe(Effect.asVoid);

  const listTasksAwaitingResume: PersonalTaskRepository["Service"]["listTasksAwaitingResume"] =
    () =>
      query(
        "listTasksAwaitingResume",
        sql`
          SELECT ${sql.literal(TASK_COLUMNS)}
          FROM personal_tasks
          WHERE status IN ('waiting_for_user', 'waiting_for_browser')
            AND task_id IN (
              SELECT task_id FROM personal_task_resume_notes WHERE delivered_at IS NULL
            )
          ORDER BY created_at ASC, rowid ASC
        `,
      ).pipe(Effect.flatMap((rows) => decodeTasks("listTasksAwaitingResume", rows)));

  return {
    transaction,
    insertTask,
    getTask,
    getTaskByIdempotencyKey,
    listTasks,
    listForReplay,
    listDescendants,
    countTasksInRoot,
    writeTask,
    listClaimable,
    insertAttempt,
    writeAttempt,
    listAttempts,
    listActiveAttempts,
    heartbeat,
    insertHandoff,
    writeHandoff,
    getHandoffByChild,
    listHandoffsByParent,
    latestTaskForThread,
    insertResumeNote,
    listUndeliveredNotes,
    markNotesDelivered,
    listTasksAwaitingResume,
  } satisfies PersonalTaskRepository["Service"];
});

export const layer = Layer.effect(PersonalTaskRepository, make);
