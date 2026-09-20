import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalTaskId } from "./personalTasks.ts";

export const PersonalConnectionVendorId = Schema.Literals(["github", "vercel", "neon", "upstash"]);
export type PersonalConnectionVendorId = typeof PersonalConnectionVendorId.Type;

export const ConnectionId = TrimmedNonEmptyString.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

export const PersonalConnectionStatus = Schema.Literals([
  "connecting",
  "connected",
  "needs_reauth",
  "disabled",
  "error",
]);
export type PersonalConnectionStatus = typeof PersonalConnectionStatus.Type;

/** Client-safe state. The opaque store reference is deliberately absent. */
export const PersonalConnection = Schema.Struct({
  connectionId: ConnectionId,
  vendorId: PersonalConnectionVendorId,
  status: PersonalConnectionStatus,
  account: Schema.NullOr(
    Schema.Struct({
      accountId: Schema.String,
      accountName: Schema.String,
      teamId: Schema.NullOr(Schema.String),
      teamName: Schema.NullOr(Schema.String),
    }),
  ),
  verifiedCapabilities: Schema.Array(Schema.String),
  credentialVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  lastValidatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalConnection = typeof PersonalConnection.Type;

export const PersonalConnectionCredentials = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Redacted(Schema.String),
);
export type PersonalConnectionCredentials = typeof PersonalConnectionCredentials.Type;

export const PersonalConnectionListResult = Schema.Struct({
  connections: Schema.Array(PersonalConnection),
});
export type PersonalConnectionListResult = typeof PersonalConnectionListResult.Type;

export const PersonalConnectionConnectInput = Schema.Struct({
  vendorId: PersonalConnectionVendorId,
  credentials: PersonalConnectionCredentials,
});
export type PersonalConnectionConnectInput = typeof PersonalConnectionConnectInput.Type;

export const PersonalConnectionValidateInput = Schema.Struct({
  connectionId: ConnectionId,
  outcome: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("connected"),
      account: Schema.Struct({
        accountId: Schema.String,
        accountName: Schema.String,
        teamId: Schema.NullOr(Schema.String),
        teamName: Schema.NullOr(Schema.String),
      }),
      verifiedCapabilities: Schema.Array(Schema.String),
    }),
    Schema.Struct({ status: Schema.Literals(["needs_reauth", "error"]) }),
  ]),
});
export type PersonalConnectionValidateInput = typeof PersonalConnectionValidateInput.Type;

export const PersonalConnectionIdInput = Schema.Struct({ connectionId: ConnectionId });
export type PersonalConnectionIdInput = typeof PersonalConnectionIdInput.Type;

export const PersonalConnectionRotateInput = Schema.Struct({
  connectionId: ConnectionId,
  credentials: PersonalConnectionCredentials,
});
export type PersonalConnectionRotateInput = typeof PersonalConnectionRotateInput.Type;

export const PersonalConnectionDisconnectResult = Schema.Struct({ disconnected: Schema.Boolean });
export type PersonalConnectionDisconnectResult = typeof PersonalConnectionDisconnectResult.Type;

export class PersonalConnectionsError extends Schema.TaggedError<PersonalConnectionsError>()(
  "PersonalConnectionsError",
  { message: TrimmedNonEmptyString },
) {}

/**
 * Why an action needs the owner's decision. Mirrors the server's operation
 * catalog; it lives here so a persisted approval keeps its meaning and the
 * client can group cards without re-deriving the rule.
 */
export const PersonalConnectionRiskReason = Schema.Literals([
  "read_only",
  "account_write",
  "publication",
  "deployment",
  "unbounded_statement",
]);
export type PersonalConnectionRiskReason = typeof PersonalConnectionRiskReason.Type;

export const PersonalConnectionApprovalId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalConnectionApprovalId"),
);
export type PersonalConnectionApprovalId = typeof PersonalConnectionApprovalId.Type;

export const PersonalConnectionApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "cancelled",
  "expired",
]);
export type PersonalConnectionApprovalStatus = typeof PersonalConnectionApprovalStatus.Type;

/** What happened to the approved action; the receipt the owner can be shown. */
export const PersonalConnectionExecutionOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "not_dispatched",
]);
export type PersonalConnectionExecutionOutcome = typeof PersonalConnectionExecutionOutcome.Type;

/**
 * One decision about one normalized action. `summary` is written by the
 * server from the validated arguments: the bot never authors what the owner
 * reads. `actionDigest` is what the decision binds to, so an approval cannot
 * be spent on a different call.
 */
export const PersonalConnectionApproval = Schema.Struct({
  approvalId: PersonalConnectionApprovalId,
  connectionId: ConnectionId,
  vendorId: PersonalConnectionVendorId,
  operationId: TrimmedNonEmptyString,
  actionDigest: TrimmedNonEmptyString,
  riskReason: PersonalConnectionRiskReason,
  summary: TrimmedNonEmptyString,
  targetResources: Schema.Array(Schema.String),
  credentialVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
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
export type PersonalConnectionApproval = typeof PersonalConnectionApproval.Type;

export const PersonalConnectionApprovalListResult = Schema.Struct({
  approvals: Schema.Array(PersonalConnectionApproval),
});
export type PersonalConnectionApprovalListResult =
  typeof PersonalConnectionApprovalListResult.Type;

export const PersonalConnectionApprovalDecideInput = Schema.Struct({
  approvalId: PersonalConnectionApprovalId,
  decision: Schema.Literals(["approved", "denied"]),
});
export type PersonalConnectionApprovalDecideInput =
  typeof PersonalConnectionApprovalDecideInput.Type;

export const PersonalConnectionApprovalIdInput = Schema.Struct({
  approvalId: PersonalConnectionApprovalId,
});
export type PersonalConnectionApprovalIdInput = typeof PersonalConnectionApprovalIdInput.Type;
