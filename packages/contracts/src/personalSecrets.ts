import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalTaskId } from "./personalTasks.ts";

/**
 * A secret's name: UPPER_SNAKE, starting with a letter. It becomes the
 * environment variable `PB_SECRET_<NAME>` in the bot's provider sessions and
 * the server secret store key `personal-secret-<NAME>`, so the pattern is
 * also what keeps both of those safe.
 */
export const PersonalSecretName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/));
export type PersonalSecretName = typeof PersonalSecretName.Type;

/** Longest accepted secret value, in UTF-8 bytes. */
export const PERSONAL_SECRET_MAX_VALUE_BYTES = 4096;

/** Environment variable a fulfilled secret is exposed as. */
export const personalSecretEnvVar = (name: string) => `PB_SECRET_${name}`;

export const PersonalSecretRequestId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalSecretRequestId"),
);
export type PersonalSecretRequestId = typeof PersonalSecretRequestId.Type;

export const PersonalSecretRequestStatus = Schema.Literals(["pending", "fulfilled", "cancelled"]);
export type PersonalSecretRequestStatus = typeof PersonalSecretRequestStatus.Type;

/** A bot's request for a secret. Never carries the value. */
export const PersonalSecretRequest = Schema.Struct({
  requestId: PersonalSecretRequestId,
  /** The task that asked, and the root of its tree; null only for legacy rows. */
  taskId: Schema.NullOr(PersonalTaskId),
  rootTaskId: Schema.NullOr(PersonalTaskId),
  threadId: ThreadId,
  botId: PersonalBotId,
  name: PersonalSecretName,
  label: Schema.String,
  purpose: Schema.String,
  status: PersonalSecretRequestStatus,
  /** Shared secrets reach every bot's sessions, not only the requester's. */
  shared: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  fulfilledAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalSecretRequest = typeof PersonalSecretRequest.Type;

/** A stored secret as the client may see it: name, label and dates only. */
/**
 * A key the owner saved themselves, rather than one a bot asked for.
 *
 * The name is the whole point and the only part that can be got wrong: a bot
 * reads the value as `PB_SECRET_<NAME>`, so a key saved under a name nothing
 * looks for is invisible rather than broken. It is validated to the same
 * UPPER_SNAKE shape a bot's own request must use.
 */
export const PersonalSecretCreateInput = Schema.Struct({
  name: PersonalSecretName,
  /** What the owner calls it in the list. Defaults to the name. */
  label: Schema.optional(Schema.String),
  value: Schema.Redacted(Schema.String),
  /** Owner-added keys are shared by default; every bot can use every saved key. */
  shared: Schema.optional(Schema.Boolean),
});
export type PersonalSecretCreateInput = typeof PersonalSecretCreateInput.Type;

export const PersonalSecretSummary = Schema.Struct({
  name: PersonalSecretName,
  label: Schema.String,
  botIds: Schema.Array(PersonalBotId),
  shared: Schema.Boolean,
  fulfilledAt: Schema.DateTimeUtcFromString,
});
export type PersonalSecretSummary = typeof PersonalSecretSummary.Type;

export const PersonalSecretsListPendingResult = Schema.Struct({
  requests: Schema.Array(PersonalSecretRequest),
});
export type PersonalSecretsListPendingResult = typeof PersonalSecretsListPendingResult.Type;

export const PersonalSecretsListResult = Schema.Struct({
  secrets: Schema.Array(PersonalSecretSummary),
});
export type PersonalSecretsListResult = typeof PersonalSecretsListResult.Type;

export const PersonalSecretFulfillInput = Schema.Struct({
  requestId: PersonalSecretRequestId,
  /**
   * Redacted on the server so it never prints. On the wire it is the plain
   * string; clients wrap it with `Redacted.make`. The server enforces
   * `PERSONAL_SECRET_MAX_VALUE_BYTES` without echoing the value back.
   */
  value: Schema.Redacted(Schema.String),
  shared: Schema.optional(Schema.Boolean),
});
export type PersonalSecretFulfillInput = typeof PersonalSecretFulfillInput.Type;

export const PersonalSecretRequestIdInput = Schema.Struct({
  requestId: PersonalSecretRequestId,
});
export type PersonalSecretRequestIdInput = typeof PersonalSecretRequestIdInput.Type;

export const PersonalSecretNameInput = Schema.Struct({
  name: PersonalSecretName,
});
export type PersonalSecretNameInput = typeof PersonalSecretNameInput.Type;

export const PersonalSecretSharingInput = Schema.Struct({
  name: PersonalSecretName,
  shared: Schema.Boolean,
});
export type PersonalSecretSharingInput = typeof PersonalSecretSharingInput.Type;

export class PersonalSecretsError extends Schema.TaggedError<PersonalSecretsError>()(
  "PersonalSecretsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
