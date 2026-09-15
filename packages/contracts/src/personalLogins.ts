import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PersonalLoginId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalLoginId"));
export type PersonalLoginId = typeof PersonalLoginId.Type;

/**
 * A saved login as clients may see it. Passwords and secret-store references
 * never cross RPC. Every bot may use every saved login: they share one browser
 * profile and one computer account, so a per-bot grant described an isolation
 * the runtime never had (user decision, 2026-09-14).
 */
export const PersonalLogin = Schema.Struct({
  loginId: PersonalLoginId,
  label: TrimmedNonEmptyString,
  origin: TrimmedNonEmptyString,
  username: Schema.String,
  /**
   * The user marked this origin as a sensitive site. After a bot has had it
   * open in the shared browser, anything that could carry what it saw to a
   * different origin waits for the user's approval.
   */
  sensitive: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalLogin = typeof PersonalLogin.Type;

export const PersonalLoginsListResult = Schema.Struct({
  logins: Schema.Array(PersonalLogin),
});
export type PersonalLoginsListResult = typeof PersonalLoginsListResult.Type;

const PersonalLoginFields = {
  label: TrimmedNonEmptyString,
  /** Validated and canonicalized by the server to an exact https origin. */
  origin: TrimmedNonEmptyString,
  username: Schema.String,
  /** Write-only: decoded as Redacted on the server and absent from every result schema. */
  password: Schema.Redacted(Schema.String),
};

export const PersonalLoginCreateInput = Schema.Struct({
  loginId: PersonalLoginId,
  ...PersonalLoginFields,
});
export type PersonalLoginCreateInput = typeof PersonalLoginCreateInput.Type;

/** Editing always requires re-entering the password; the existing value is never read into a form. */
export const PersonalLoginUpdateInput = Schema.Struct({
  loginId: PersonalLoginId,
  ...PersonalLoginFields,
});
export type PersonalLoginUpdateInput = typeof PersonalLoginUpdateInput.Type;

export const PersonalLoginDeleteInput = Schema.Struct({ loginId: PersonalLoginId });
export type PersonalLoginDeleteInput = typeof PersonalLoginDeleteInput.Type;

/** Marks or unmarks a saved login as a sensitive site. Needs no password. */
export const PersonalLoginSetSensitiveInput = Schema.Struct({
  loginId: PersonalLoginId,
  sensitive: Schema.Boolean,
});
export type PersonalLoginSetSensitiveInput = typeof PersonalLoginSetSensitiveInput.Type;

export class PersonalLoginsError extends Schema.TaggedError<PersonalLoginsError>()(
  "PersonalLoginsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
