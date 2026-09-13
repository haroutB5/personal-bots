import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import {
  PersonalBotId,
  PersonalSecretName,
  PersonalSecretRequestId,
  PersonalSecretRequestStatus,
  PersonalTaskId,
  ThreadId,
  type PersonalSecretRequest,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type PersonalSecretRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** Every column of `personal_secret_requests`. There is no value column, by design. */
const RequestDbRow = Schema.Struct({
  requestId: PersonalSecretRequestId,
  taskId: Schema.NullOr(PersonalTaskId),
  rootTaskId: Schema.NullOr(PersonalTaskId),
  threadId: ThreadId,
  botId: PersonalBotId,
  name: PersonalSecretName,
  label: Schema.String,
  purpose: Schema.String,
  status: PersonalSecretRequestStatus,
  shared: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  fulfilledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
const decodeRequestRow = Schema.decodeUnknownEffect(RequestDbRow);

const REQUEST_COLUMNS = `
  request_id AS "requestId",
  task_id AS "taskId",
  root_task_id AS "rootTaskId",
  thread_id AS "threadId",
  bot_id AS "botId",
  name AS "name",
  label AS "label",
  purpose AS "purpose",
  status AS "status",
  shared AS "shared",
  created_at AS "createdAt",
  fulfilled_at AS "fulfilledAt"
`;

export class PersonalSecretRepository extends Context.Service<
  PersonalSecretRepository,
  {
    readonly insertRequest: (
      request: PersonalSecretRequest,
    ) => Effect.Effect<void, PersonalSecretRepositoryError>;
    readonly getRequest: (
      requestId: PersonalSecretRequestId,
    ) => Effect.Effect<Option.Option<PersonalSecretRequest>, PersonalSecretRepositoryError>;
    readonly listByStatus: (
      status: PersonalSecretRequest["status"],
    ) => Effect.Effect<ReadonlyArray<PersonalSecretRequest>, PersonalSecretRepositoryError>;
    readonly listByTask: (
      taskId: PersonalTaskId,
    ) => Effect.Effect<ReadonlyArray<PersonalSecretRequest>, PersonalSecretRepositoryError>;
    /** Moves a request out of `expectedStatus`. Returns whether the row was written. */
    readonly writeStatus: (input: {
      readonly requestId: PersonalSecretRequestId;
      readonly expectedStatus: PersonalSecretRequest["status"];
      readonly status: PersonalSecretRequest["status"];
      readonly shared: boolean;
      readonly fulfilledAt: DateTime.Utc | null;
    }) => Effect.Effect<boolean, PersonalSecretRepositoryError>;
    /** Drops the fulfilled rows for `name`; returns how many there were. */
    readonly deleteFulfilledByName: (
      name: string,
    ) => Effect.Effect<number, PersonalSecretRepositoryError>;
  }
>()("t3/personal/secrets/PersonalSecretRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({ operation: `PersonalSecretRepository.${operation}`, cause }),
      ),
    );

  const decodeRequests = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeRequestRow(row).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError(`PersonalSecretRepository.${operation}`, cause),
        ),
        Effect.map((decoded): PersonalSecretRequest => ({
          ...decoded,
          shared: decoded.shared === 1,
        })),
      ),
    );

  const insertRequest: PersonalSecretRepository["Service"]["insertRequest"] = (request) =>
    query(
      "insertRequest",
      sql`
        INSERT INTO personal_secret_requests (
          request_id, root_task_id, task_id, thread_id, bot_id, name, label, purpose,
          status, shared, created_at, fulfilled_at
        )
        VALUES (
          ${request.requestId}, ${request.rootTaskId}, ${request.taskId}, ${request.threadId},
          ${request.botId}, ${request.name}, ${request.label}, ${request.purpose},
          ${request.status}, ${request.shared ? 1 : 0}, ${DateTime.formatIso(request.createdAt)},
          ${request.fulfilledAt === null ? null : DateTime.formatIso(request.fulfilledAt)}
        )
        ON CONFLICT(request_id) DO NOTHING
      `,
    ).pipe(Effect.asVoid);

  const getRequest: PersonalSecretRepository["Service"]["getRequest"] = (requestId) =>
    query(
      "getRequest",
      sql`
        SELECT ${sql.literal(REQUEST_COLUMNS)}
        FROM personal_secret_requests
        WHERE request_id = ${requestId}
      `,
    ).pipe(
      Effect.flatMap((rows) => decodeRequests("getRequest", rows.slice(0, 1))),
      Effect.map((requests) => Option.fromNullishOr(requests[0])),
    );

  const listByStatus: PersonalSecretRepository["Service"]["listByStatus"] = (status) =>
    query(
      "listByStatus",
      sql`
        SELECT ${sql.literal(REQUEST_COLUMNS)}
        FROM personal_secret_requests
        WHERE status = ${status}
        ORDER BY created_at ASC, rowid ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeRequests("listByStatus", rows)));

  const listByTask: PersonalSecretRepository["Service"]["listByTask"] = (taskId) =>
    query(
      "listByTask",
      sql`
        SELECT ${sql.literal(REQUEST_COLUMNS)}
        FROM personal_secret_requests
        WHERE task_id = ${taskId}
        ORDER BY created_at ASC, rowid ASC
      `,
    ).pipe(Effect.flatMap((rows) => decodeRequests("listByTask", rows)));

  const writeStatus: PersonalSecretRepository["Service"]["writeStatus"] = (input) =>
    query(
      "writeStatus",
      sql`
        UPDATE personal_secret_requests
        SET status = ${input.status},
            shared = ${input.shared ? 1 : 0},
            fulfilled_at = ${input.fulfilledAt === null ? null : DateTime.formatIso(input.fulfilledAt)}
        WHERE request_id = ${input.requestId}
          AND status = ${input.expectedStatus}
        RETURNING request_id AS "requestId"
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const deleteFulfilledByName: PersonalSecretRepository["Service"]["deleteFulfilledByName"] = (
    name,
  ) =>
    query(
      "deleteFulfilledByName",
      sql`
        DELETE FROM personal_secret_requests
        WHERE name = ${name}
          AND status = 'fulfilled'
        RETURNING request_id AS "requestId"
      `,
    ).pipe(Effect.map((rows) => rows.length));

  return {
    insertRequest,
    getRequest,
    listByStatus,
    listByTask,
    writeStatus,
    deleteFulfilledByName,
  } satisfies PersonalSecretRepository["Service"];
});

export const layer = Layer.effect(PersonalSecretRepository, make);
