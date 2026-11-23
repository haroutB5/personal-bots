import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EmailVendorId } from "./personalConnections.ts";

export const PersonalEmailServerType = Schema.Literals(["imap", "ews", "graph", "pop3"]);
export type PersonalEmailServerType = typeof PersonalEmailServerType.Type;

export const PersonalEmailAccount = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  address: TrimmedNonEmptyString,
  vendor: EmailVendorId,
  serverType: PersonalEmailServerType,
});
export type PersonalEmailAccount = typeof PersonalEmailAccount.Type;

/**
 * Where the Thunderbird that holds the owner's mail stands. One tag per way it
 * can be unavailable, so a screen cannot show accounts for a closed app.
 */
export const PersonalThunderbirdStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ready"), accounts: Schema.Array(PersonalEmailAccount) }),
  Schema.Struct({ _tag: Schema.Literal("closed") }),
  Schema.Struct({ _tag: Schema.Literal("addon-missing") }),
  Schema.Struct({ _tag: Schema.Literal("unsupported"), reason: TrimmedNonEmptyString }),
]);
export type PersonalThunderbirdStatus = typeof PersonalThunderbirdStatus.Type;

export const PersonalEmailStatus = Schema.Struct({
  thunderbird: PersonalThunderbirdStatus,
  /** True once the owner has confirmed which accounts bots may use. */
  accountsConfirmed: Schema.Boolean,
  profileSizeBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type PersonalEmailStatus = typeof PersonalEmailStatus.Type;

export const PersonalEmailUseAccountsInput = Schema.Struct({
  accountIds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
});
export type PersonalEmailUseAccountsInput = typeof PersonalEmailUseAccountsInput.Type;

/** `problem` is an answer in the owner's words, not a failed call. */
export const PersonalEmailUseAccountsResult = Schema.Struct({
  changed: Schema.Boolean,
  problem: Schema.NullOr(TrimmedNonEmptyString),
});
export type PersonalEmailUseAccountsResult = typeof PersonalEmailUseAccountsResult.Type;

export const PersonalEmailStartResult = Schema.Struct({
  started: Schema.Boolean,
  problem: Schema.NullOr(TrimmedNonEmptyString),
});
export type PersonalEmailStartResult = typeof PersonalEmailStartResult.Type;
