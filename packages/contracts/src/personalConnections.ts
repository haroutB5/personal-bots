import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalTaskId } from "./personalTasks.ts";

export const PersonalConnectionVendorId = Schema.Literals([
  "github",
  "vercel",
  "neon",
  "upstash",
  "whatsapp",
]);
export type PersonalConnectionVendorId = typeof PersonalConnectionVendorId.Type;

/**
 * How the owner proves the account is theirs.
 *
 * `browser-session` exists because a personal WhatsApp account has no token to
 * paste: the credential is the logged-in session in the shared browser
 * profile, and nothing about it is ever stored by this feature. The two kinds
 * lead to different connect screens and different server paths, so a vendor
 * has to say which it is rather than defaulting into the paste flow.
 */
export const PersonalConnectionAuthKind = Schema.Literals(["token-paste", "browser-session"]);
export type PersonalConnectionAuthKind = typeof PersonalConnectionAuthKind.Type;

/**
 * The lowest daily send cap that is still useful, and the one a new WhatsApp
 * connection gets. Volume is what turns automation into a banned number, so
 * the default is deliberately small and the owner raises it deliberately.
 */
export const WHATSAPP_DEFAULT_DAILY_SEND_CAP = 10;
export const WHATSAPP_MAX_DAILY_SEND_CAP = 100;

/**
 * Owner-visible knobs that belong to one connection rather than to the vendor.
 *
 * Kept as one nullable struct so the Connections screen can show and change
 * them without a second round trip. `null` on a field means "this vendor does
 * not have it"; a connected WhatsApp always has a number.
 */
export const PersonalConnectionSettings = Schema.Struct({
  whatsappDailySendCap: Schema.NullOr(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(WHATSAPP_MAX_DAILY_SEND_CAP),
    ),
  ),
});
export type PersonalConnectionSettings = typeof PersonalConnectionSettings.Type;

export const EMPTY_PERSONAL_CONNECTION_SETTINGS: PersonalConnectionSettings = {
  whatsappDailySendCap: null,
};

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
  settings: PersonalConnectionSettings,
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

/**
 * Validation is a call the server makes to the vendor, so the client asks for
 * one rather than reporting its outcome. An earlier draft let the caller
 * supply the status and the account; that made the client the authority on
 * whether a token works, which is exactly what has to be checked.
 */
export const PersonalConnectionValidateInput = Schema.Struct({ connectionId: ConnectionId });
export type PersonalConnectionValidateInput = typeof PersonalConnectionValidateInput.Type;

/**
 * What one validation learned. `missingScopes` names the required scopes the
 * vendor did not report for this token, so the connect screen can say which
 * box to tick rather than "something is wrong".
 */
export const PersonalConnectionValidationResult = Schema.Struct({
  connection: PersonalConnection,
  missingScopes: Schema.Array(Schema.String),
  /** Why it is not usable, in the owner's words; null when it validated. */
  problem: Schema.NullOr(TrimmedNonEmptyString),
});
export type PersonalConnectionValidationResult = typeof PersonalConnectionValidationResult.Type;

export const PersonalConnectionIdInput = Schema.Struct({ connectionId: ConnectionId });
export type PersonalConnectionIdInput = typeof PersonalConnectionIdInput.Type;

/**
 * Start (or restart) a browser-session connect: the server opens the vendor's
 * site in the shared browser and hands the owner control so they can sign in.
 * There is no credential in either direction, which is the point.
 */
export const PersonalConnectionBrowserConnectInput = Schema.Struct({
  vendorId: PersonalConnectionVendorId,
});
export type PersonalConnectionBrowserConnectInput =
  typeof PersonalConnectionBrowserConnectInput.Type;

export const PersonalConnectionBrowserConnectResult = Schema.Struct({
  connection: PersonalConnection,
  /** What the owner has to do now, in their words. */
  instruction: TrimmedNonEmptyString,
});
export type PersonalConnectionBrowserConnectResult =
  typeof PersonalConnectionBrowserConnectResult.Type;

export const PersonalConnectionSettingsInput = Schema.Struct({
  connectionId: ConnectionId,
  settings: PersonalConnectionSettings,
});
export type PersonalConnectionSettingsInput = typeof PersonalConnectionSettingsInput.Type;

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
export type PersonalConnectionApprovalListResult = typeof PersonalConnectionApprovalListResult.Type;

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

/**
 * Importing from this machine.
 *
 * A probe reports what exists and who it belongs to. It never carries any
 * part of a credential value, not even a prefix: adoption re-reads the source
 * server-side, so nothing about the secret has to cross the wire for the owner
 * to choose it.
 */
export const PersonalConnectionImportCandidate = Schema.Struct({
  candidateId: TrimmedNonEmptyString,
  vendorId: PersonalConnectionVendorId,
  sourceLabel: TrimmedNonEmptyString,
  /** The account the file names, for the owner to recognise. Never a value. */
  identifier: Schema.NullOr(Schema.String),
});
export type PersonalConnectionImportCandidate = typeof PersonalConnectionImportCandidate.Type;

/**
 * `absent` is "you do not use this tool here", `unreadable` is "it is there
 * and we could not make sense of it". Collapsing them would send the owner
 * looking in the wrong place.
 */
export const PersonalConnectionImportSourceState = Schema.Literals([
  "found",
  "absent",
  "unreadable",
]);
export type PersonalConnectionImportSourceState = typeof PersonalConnectionImportSourceState.Type;

export const PersonalConnectionImportSource = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  vendorId: PersonalConnectionVendorId,
  label: TrimmedNonEmptyString,
  state: PersonalConnectionImportSourceState,
  detail: Schema.NullOr(Schema.String),
});
export type PersonalConnectionImportSource = typeof PersonalConnectionImportSource.Type;

export const PersonalConnectionImportResult = Schema.Struct({
  candidates: Schema.Array(PersonalConnectionImportCandidate),
  sources: Schema.Array(PersonalConnectionImportSource),
});
export type PersonalConnectionImportResult = typeof PersonalConnectionImportResult.Type;

export const PersonalConnectionImportAdoptInput = Schema.Struct({
  candidateId: TrimmedNonEmptyString,
});
export type PersonalConnectionImportAdoptInput = typeof PersonalConnectionImportAdoptInput.Type;
