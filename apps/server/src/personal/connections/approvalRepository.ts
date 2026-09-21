import {
  ConnectionId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  PersonalConnectionApprovalStatus,
  PersonalConnectionExecutionOutcome,
  PersonalConnectionRiskReason,
  PersonalConnectionVendorId,
  PersonalTaskId,
  ThreadId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type PersonalConnectionApprovalRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const ApprovalRow = Schema.Struct({
  approvalId: PersonalConnectionApprovalId,
  connectionId: ConnectionId,
  vendorId: PersonalConnectionVendorId,
  operationId: Schema.String,
  actionDigest: Schema.String,
  riskReason: PersonalConnectionRiskReason,
  summary: Schema.String,
  targetResourcesJson: Schema.fromJsonString(Schema.Array(Schema.String)),
  credentialVersion: Schema.Int,
  threadId: ThreadId,
  botId: PersonalBotId,
  taskId: Schema.NullOr(PersonalTaskId),
  status: PersonalConnectionApprovalStatus,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  decidedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  executedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  executionOutcome: Schema.NullOr(PersonalConnectionExecutionOutcome),
});
const decodeRow = Schema.decodeUnknownEffect(ApprovalRow);

const COLUMNS = `
  approval_id AS "approvalId",
  connection_id AS "connectionId",
  vendor_id AS "vendorId",
  operation_id AS "operationId",
  action_digest AS "actionDigest",
  risk_reason AS "riskReason",
  summary AS "summary",
  target_resources_json AS "targetResourcesJson",
  credential_version AS "credentialVersion",
  thread_id AS "threadId",
  bot_id AS "botId",
  task_id AS "taskId",
  status AS "status",
  created_at AS "createdAt",
  expires_at AS "expiresAt",
  decided_at AS "decidedAt",
  executed_at AS "executedAt",
  execution_outcome AS "executionOutcome"
`;

export class PersonalConnectionApprovalRepository extends Context.Service<
  PersonalConnectionApprovalRepository,
  {
    readonly insert: (
      approval: PersonalConnectionApproval,
    ) => Effect.Effect<void, PersonalConnectionApprovalRepositoryError>;
    readonly get: (
      approvalId: PersonalConnectionApprovalId,
    ) => Effect.Effect<
      Option.Option<PersonalConnectionApproval>,
      PersonalConnectionApprovalRepositoryError
    >;
    /** Every decision ever taken about this exact action, newest last. */
    readonly listByDigest: (
      actionDigest: string,
    ) => Effect.Effect<
      ReadonlyArray<PersonalConnectionApproval>,
      PersonalConnectionApprovalRepositoryError
    >;
    readonly listByStatus: (
      status: PersonalConnectionApproval["status"],
    ) => Effect.Effect<
      ReadonlyArray<PersonalConnectionApproval>,
      PersonalConnectionApprovalRepositoryError
    >;
    /** Pending rows whose window has closed; the sweep reads this. */
    readonly listPastDue: (
      now: DateTime.Utc,
    ) => Effect.Effect<
      ReadonlyArray<PersonalConnectionApproval>,
      PersonalConnectionApprovalRepositoryError
    >;
    /**
     * Moves a row out of `expectedStatus`. False means someone else decided
     * first, which is how a duplicate click resolves once.
     */
    readonly writeStatus: (input: {
      readonly approvalId: PersonalConnectionApprovalId;
      readonly expectedStatus: PersonalConnectionApproval["status"];
      readonly status: PersonalConnectionApproval["status"];
      readonly decidedAt: DateTime.Utc;
    }) => Effect.Effect<boolean, PersonalConnectionApprovalRepositoryError>;
    /**
     * Records what became of an approved action. Written only while the row
     * has no receipt, so an approval is spent exactly once.
     */
    readonly writeReceipt: (input: {
      readonly approvalId: PersonalConnectionApprovalId;
      readonly executedAt: DateTime.Utc;
      readonly outcome: typeof PersonalConnectionExecutionOutcome.Type;
    }) => Effect.Effect<boolean, PersonalConnectionApprovalRepositoryError>;
  }
>()("t3/personal/connections/approvalRepository/PersonalConnectionApprovalRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = <Row>(
    operation: string,
    effect: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: `PersonalConnectionApprovalRepository.${operation}`,
            cause,
          }),
      ),
    );

  const decode = (operation: string, rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) =>
      decodeRow(row).pipe(
        Effect.map(
          (decoded): PersonalConnectionApproval => ({
            approvalId: decoded.approvalId,
            connectionId: decoded.connectionId,
            vendorId: decoded.vendorId,
            operationId: decoded.operationId,
            actionDigest: decoded.actionDigest,
            riskReason: decoded.riskReason,
            summary: decoded.summary,
            targetResources: decoded.targetResourcesJson,
            credentialVersion: decoded.credentialVersion,
            threadId: decoded.threadId,
            botId: decoded.botId,
            taskId: decoded.taskId,
            status: decoded.status,
            createdAt: decoded.createdAt,
            expiresAt: decoded.expiresAt,
            decidedAt: decoded.decidedAt,
            executedAt: decoded.executedAt,
            executionOutcome: decoded.executionOutcome,
          }),
        ),
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError(
            `PersonalConnectionApprovalRepository.${operation}`,
            cause,
          ),
        ),
      ),
    );

  const insert: PersonalConnectionApprovalRepository["Service"]["insert"] = (approval) =>
    query(
      "insert",
      sql`
        INSERT INTO personal_connection_approvals (
          approval_id, connection_id, vendor_id, operation_id, action_digest, risk_reason,
          summary, target_resources_json, credential_version, thread_id, bot_id, task_id,
          status, created_at, expires_at, decided_at, executed_at, execution_outcome
        ) VALUES (
          ${approval.approvalId}, ${approval.connectionId}, ${approval.vendorId},
          ${approval.operationId}, ${approval.actionDigest}, ${approval.riskReason},
          ${approval.summary}, ${JSON.stringify(approval.targetResources)},
          ${approval.credentialVersion}, ${approval.threadId}, ${approval.botId},
          ${approval.taskId}, ${approval.status},
          ${DateTime.formatIso(approval.createdAt)}, ${DateTime.formatIso(approval.expiresAt)},
          ${approval.decidedAt === null ? null : DateTime.formatIso(approval.decidedAt)},
          ${approval.executedAt === null ? null : DateTime.formatIso(approval.executedAt)},
          ${approval.executionOutcome}
        )
      `,
    ).pipe(Effect.asVoid);

  const get: PersonalConnectionApprovalRepository["Service"]["get"] = (approvalId) =>
    query(
      "get",
      sql`SELECT ${sql.literal(COLUMNS)} FROM personal_connection_approvals WHERE approval_id = ${approvalId}`,
    ).pipe(
      Effect.flatMap((rows) => decode("get", rows)),
      Effect.map((values) => Option.fromNullishOr(values[0])),
    );

  const listByDigest: PersonalConnectionApprovalRepository["Service"]["listByDigest"] = (digest) =>
    query(
      "listByDigest",
      sql`
        SELECT ${sql.literal(COLUMNS)} FROM personal_connection_approvals
        WHERE action_digest = ${digest} ORDER BY created_at ASC, approval_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => decode("listByDigest", rows)));

  const listByStatus: PersonalConnectionApprovalRepository["Service"]["listByStatus"] = (status) =>
    query(
      "listByStatus",
      sql`
        SELECT ${sql.literal(COLUMNS)} FROM personal_connection_approvals
        WHERE status = ${status} ORDER BY created_at ASC, approval_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => decode("listByStatus", rows)));

  const listPastDue: PersonalConnectionApprovalRepository["Service"]["listPastDue"] = (now) =>
    query(
      "listPastDue",
      sql`
        SELECT ${sql.literal(COLUMNS)} FROM personal_connection_approvals
        WHERE status = 'pending' AND expires_at <= ${DateTime.formatIso(now)}
        ORDER BY created_at ASC, approval_id ASC
      `,
    ).pipe(Effect.flatMap((rows) => decode("listPastDue", rows)));

  const writeStatus: PersonalConnectionApprovalRepository["Service"]["writeStatus"] = (input) =>
    query(
      "writeStatus",
      sql`
        UPDATE personal_connection_approvals
        SET status = ${input.status}, decided_at = ${DateTime.formatIso(input.decidedAt)}
        WHERE approval_id = ${input.approvalId} AND status = ${input.expectedStatus}
        RETURNING approval_id
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  const writeReceipt: PersonalConnectionApprovalRepository["Service"]["writeReceipt"] = (input) =>
    query(
      "writeReceipt",
      sql`
        UPDATE personal_connection_approvals
        SET executed_at = ${DateTime.formatIso(input.executedAt)},
            execution_outcome = ${input.outcome}
        WHERE approval_id = ${input.approvalId} AND executed_at IS NULL
        RETURNING approval_id
      `,
    ).pipe(Effect.map((rows) => rows.length > 0));

  return PersonalConnectionApprovalRepository.of({
    insert,
    get,
    listByDigest,
    listByStatus,
    listPastDue,
    writeStatus,
    writeReceipt,
  });
});

export const layer = Layer.effect(PersonalConnectionApprovalRepository, make);
