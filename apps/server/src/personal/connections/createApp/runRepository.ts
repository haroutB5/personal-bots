import {
  CreateAppPlan,
  CreateAppRunId,
  CreateAppRunStatus,
  CreateAppStepState,
  PersonalBotId,
  PersonalConnectionApprovalId,
  PersonalTaskId,
  ThreadId,
  type CreateAppRun,
  type CreateAppStep,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../../../persistence/Errors.ts";

/**
 * Where a `create_app` run lives between process lifetimes.
 *
 * Two writes bracket every provider call: `beginStep` before it and
 * `settleStep` after. A crash in between leaves the step `in_flight`, which is
 * the only honest record of "the provider was asked and nobody read the
 * answer" — and is what the runner reconciles against before it sends
 * anything again.
 */

export type CreateAppRunRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const RunRow = Schema.Struct({
  runId: CreateAppRunId,
  botId: PersonalBotId,
  threadId: ThreadId,
  taskId: Schema.NullOr(PersonalTaskId),
  planJson: Schema.fromJsonString(CreateAppPlan),
  planDigest: Schema.String,
  approvalId: Schema.NullOr(PersonalConnectionApprovalId),
  status: CreateAppRunStatus,
  appUrl: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
const decodeRunRow = Schema.decodeUnknownEffect(RunRow);

const StepRow = Schema.Struct({
  runId: CreateAppRunId,
  stepId: Schema.String,
  title: Schema.String,
  position: Schema.Int,
  state: CreateAppStepState,
  attempts: Schema.Int,
  remoteId: Schema.NullOr(Schema.String),
  adopted: Schema.Int,
  receiptJson: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
const decodeStepRow = Schema.decodeUnknownEffect(StepRow);

/**
 * The same codecs the rows are read back through, used to write them. A plan
 * that could be written one way and read another would be a plan whose hash
 * stopped meaning anything.
 */
const PlanJson = Schema.fromJsonString(CreateAppPlan);
const encodePlan = Schema.encodeSync(PlanJson);
const ReceiptJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const encodeReceipt = Schema.encodeSync(ReceiptJson);

const RUN_COLUMNS = `
  run_id AS "runId",
  bot_id AS "botId",
  thread_id AS "threadId",
  task_id AS "taskId",
  plan_json AS "planJson",
  plan_digest AS "planDigest",
  approval_id AS "approvalId",
  status AS "status",
  app_url AS "appUrl",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const STEP_COLUMNS = `
  run_id AS "runId",
  step_id AS "stepId",
  title AS "title",
  position AS "position",
  state AS "state",
  attempts AS "attempts",
  remote_id AS "remoteId",
  adopted AS "adopted",
  receipt_json AS "receiptJson",
  error AS "error",
  started_at AS "startedAt",
  ended_at AS "endedAt"
`;

export class CreateAppRunRepository extends Context.Service<
  CreateAppRunRepository,
  {
    readonly insert: (run: CreateAppRun) => Effect.Effect<void, CreateAppRunRepositoryError>;
    readonly get: (
      runId: CreateAppRunId,
    ) => Effect.Effect<Option.Option<CreateAppRun>, CreateAppRunRepositoryError>;
    /** The run already approved for this exact plan in this chat, if any. */
    readonly getByPlan: (input: {
      readonly threadId: ThreadId;
      readonly planDigest: string;
    }) => Effect.Effect<Option.Option<CreateAppRun>, CreateAppRunRepositoryError>;
    readonly listByStatus: (
      status: CreateAppRun["status"],
    ) => Effect.Effect<ReadonlyArray<CreateAppRun>, CreateAppRunRepositoryError>;
    readonly writeStatus: (input: {
      readonly runId: CreateAppRunId;
      readonly status: CreateAppRun["status"];
      readonly appUrl?: string | null;
      readonly approvalId?: PersonalConnectionApprovalId | null;
      readonly taskId?: PersonalTaskId | null;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void, CreateAppRunRepositoryError>;
    /** Written before the provider is called. Counts the attempt, whatever happens next. */
    readonly beginStep: (input: {
      readonly runId: CreateAppRunId;
      readonly stepId: string;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void, CreateAppRunRepositoryError>;
    /** Written after. The remote identity is recorded here and nowhere else. */
    readonly settleStep: (input: {
      readonly runId: CreateAppRunId;
      readonly stepId: string;
      readonly state: CreateAppStep["state"];
      readonly remoteId: string | null;
      readonly adopted: boolean;
      readonly receipt: Readonly<Record<string, string>>;
      readonly error: string | null;
      readonly at: DateTime.Utc;
    }) => Effect.Effect<void, CreateAppRunRepositoryError>;
  }
>()("t3/personal/connections/createApp/runRepository/CreateAppRunRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({ operation: `CreateAppRunRepository.${operation}`, cause }),
      ),
    );

  const decodeFailure = (operation: string) => (cause: Schema.SchemaError) =>
    PersistenceDecodeError.fromSchemaError(`CreateAppRunRepository.${operation}`, cause);

  const stepsFor = (operation: string, runIds: ReadonlyArray<CreateAppRunId>) =>
    runIds.length === 0
      ? Effect.succeed(new Map<string, Array<CreateAppStep>>())
      : query(
          operation,
          sql`
            SELECT ${sql.literal(STEP_COLUMNS)} FROM personal_create_app_steps
            WHERE run_id IN ${sql.in(runIds)} ORDER BY position ASC, step_id ASC
          `,
        ).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeStepRow(row).pipe(Effect.mapError(decodeFailure(operation))),
            ),
          ),
          Effect.map((rows) => {
            const grouped = new Map<string, Array<CreateAppStep>>();
            for (const row of rows) {
              const list = grouped.get(row.runId) ?? [];
              list.push({
                stepId: row.stepId,
                title: row.title,
                position: row.position,
                state: row.state,
                attempts: row.attempts,
                remoteId: row.remoteId,
                adopted: row.adopted === 1,
                receipt: row.receiptJson,
                error: row.error,
                startedAt: row.startedAt,
                endedAt: row.endedAt,
              });
              grouped.set(row.runId, list);
            }
            return grouped;
          }),
        );

  const hydrate = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const runs = yield* Effect.forEach(rows, (row) =>
        decodeRunRow(row).pipe(Effect.mapError(decodeFailure(operation))),
      );
      const steps = yield* stepsFor(
        operation,
        runs.map((run) => run.runId),
      );
      return runs.map((run): CreateAppRun => ({
        runId: run.runId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: run.taskId,
        plan: run.planJson,
        planDigest: run.planDigest,
        approvalId: run.approvalId,
        status: run.status,
        appUrl: run.appUrl,
        steps: steps.get(run.runId) ?? [],
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      }));
    });

  const insert: CreateAppRunRepository["Service"]["insert"] = (run) =>
    Effect.gen(function* () {
      yield* query(
        "insert",
        sql`
          INSERT INTO personal_create_app_runs (
            run_id, bot_id, thread_id, task_id, plan_json, plan_digest, approval_id,
            status, app_url, created_at, updated_at
          ) VALUES (
            ${run.runId}, ${run.botId}, ${run.threadId}, ${run.taskId},
            ${encodePlan(run.plan)}, ${run.planDigest}, ${run.approvalId},
            ${run.status}, ${run.appUrl},
            ${DateTime.formatIso(run.createdAt)}, ${DateTime.formatIso(run.updatedAt)}
          )
        `,
      );
      yield* Effect.forEach(
        run.steps,
        (step) =>
          query(
            "insertStep",
            sql`
              INSERT INTO personal_create_app_steps (
                run_id, step_id, title, position, state, attempts, remote_id, adopted,
                receipt_json, error, started_at, ended_at
              ) VALUES (
                ${run.runId}, ${step.stepId}, ${step.title}, ${step.position}, ${step.state},
                ${step.attempts}, ${step.remoteId}, ${step.adopted ? 1 : 0},
                ${encodeReceipt(step.receipt)}, ${step.error},
                ${step.startedAt === null ? null : DateTime.formatIso(step.startedAt)},
                ${step.endedAt === null ? null : DateTime.formatIso(step.endedAt)}
              )
            `,
          ),
        { discard: true },
      );
    });

  const get: CreateAppRunRepository["Service"]["get"] = (runId) =>
    query(
      "get",
      sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM personal_create_app_runs WHERE run_id = ${runId}`,
    ).pipe(
      Effect.flatMap((rows) => hydrate("get", rows)),
      Effect.map((runs) => Option.fromNullishOr(runs[0])),
    );

  const getByPlan: CreateAppRunRepository["Service"]["getByPlan"] = (input) =>
    query(
      "getByPlan",
      sql`
        SELECT ${sql.literal(RUN_COLUMNS)} FROM personal_create_app_runs
        WHERE thread_id = ${input.threadId} AND plan_digest = ${input.planDigest}
      `,
    ).pipe(
      Effect.flatMap((rows) => hydrate("getByPlan", rows)),
      Effect.map((runs) => Option.fromNullishOr(runs[0])),
    );

  const listByStatus: CreateAppRunRepository["Service"]["listByStatus"] = (status) =>
    query(
      "listByStatus",
      sql`
        SELECT ${sql.literal(RUN_COLUMNS)} FROM personal_create_app_runs
        WHERE status = ${status} ORDER BY created_at ASC, run_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => hydrate("listByStatus", rows)));

  /**
   * Each optional field is its own statement rather than one built from
   * fragments: an absent field means "leave it alone", and writing that as a
   * conditional literal inside one UPDATE is how a value ends up interpolated
   * into SQL text.
   */
  const writeStatus: CreateAppRunRepository["Service"]["writeStatus"] = (input) =>
    Effect.gen(function* () {
      yield* query(
        "writeStatus",
        sql`
          UPDATE personal_create_app_runs
          SET status = ${input.status}, updated_at = ${DateTime.formatIso(input.at)}
          WHERE run_id = ${input.runId}
        `,
      );
      if (input.appUrl !== undefined) {
        yield* query(
          "writeStatus.appUrl",
          sql`
            UPDATE personal_create_app_runs SET app_url = ${input.appUrl}
            WHERE run_id = ${input.runId}
          `,
        );
      }
      if (input.approvalId !== undefined) {
        yield* query(
          "writeStatus.approvalId",
          sql`
            UPDATE personal_create_app_runs SET approval_id = ${input.approvalId}
            WHERE run_id = ${input.runId}
          `,
        );
      }
      if (input.taskId !== undefined) {
        yield* query(
          "writeStatus.taskId",
          sql`
            UPDATE personal_create_app_runs SET task_id = ${input.taskId}
            WHERE run_id = ${input.runId}
          `,
        );
      }
    });

  const beginStep: CreateAppRunRepository["Service"]["beginStep"] = (input) =>
    query(
      "beginStep",
      sql`
        UPDATE personal_create_app_steps
        SET state = 'in_flight',
            attempts = attempts + 1,
            error = NULL,
            started_at = ${DateTime.formatIso(input.at)},
            ended_at = NULL
        WHERE run_id = ${input.runId} AND step_id = ${input.stepId}
      `,
    ).pipe(Effect.asVoid);

  const settleStep: CreateAppRunRepository["Service"]["settleStep"] = (input) =>
    query(
      "settleStep",
      sql`
        UPDATE personal_create_app_steps
        SET state = ${input.state},
            remote_id = ${input.remoteId},
            adopted = ${input.adopted ? 1 : 0},
            receipt_json = ${encodeReceipt(input.receipt)},
            error = ${input.error},
            ended_at = ${DateTime.formatIso(input.at)}
        WHERE run_id = ${input.runId} AND step_id = ${input.stepId}
      `,
    ).pipe(Effect.asVoid);

  return CreateAppRunRepository.of({
    insert,
    get,
    getByPlan,
    listByStatus,
    writeStatus,
    beginStep,
    settleStep,
  });
});

export const layer = Layer.effect(CreateAppRunRepository, make);
