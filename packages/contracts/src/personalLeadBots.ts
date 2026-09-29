import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

/**
 * A team lead's request to remove or rewrite a bot it did not create, waiting
 * for the owner's tap on a card in the lead's chat.
 *
 * Every word the owner reads (`lines`, `reason`) is written by the server from
 * the values it validated; the lead does not describe its own request. The tap
 * is bound to `changeHash`, a digest of the bot id, the action and the exact new
 * values, so an approval cannot be spent on any other change. Single use: the
 * first answer wins, and a row past `expiresAt` cancels itself.
 */
export const PersonalLeadBotChangeId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalLeadBotChangeId"),
);
export type PersonalLeadBotChangeId = typeof PersonalLeadBotChangeId.Type;

/**
 * pending: waiting for the owner. approved: the owner said yes and the change was
 * made. declined: the owner said no. expired: nobody answered in time. failed: the
 * owner said yes but the bot had changed since (or a rule no longer allowed it),
 * so nothing was done. superseded: the lead asked again and the newer card replaced
 * this one.
 */
export const PersonalLeadBotChangeStatus = Schema.Literals([
  "pending",
  "approved",
  "declined",
  "expired",
  "failed",
  "superseded",
]);
export type PersonalLeadBotChangeStatus = typeof PersonalLeadBotChangeStatus.Type;

export const PersonalLeadBotChange = Schema.Struct({
  changeId: PersonalLeadBotChangeId,
  changeHash: TrimmedNonEmptyString,
  leadBotId: PersonalBotId,
  leadName: Schema.String,
  action: Schema.Literals(["update", "remove"]),
  targetBotId: PersonalBotId,
  targetName: Schema.String,
  team: Schema.String,
  /** The lead's chat: the card is shown there. */
  threadId: ThreadId,
  /** One line per changed field ("instructions: 412 → 530 chars"); for a removal, one line. */
  lines: Schema.Array(Schema.String),
  /** remove_bot's reason as the lead gave it (cut for display); null for an update. */
  reason: Schema.NullOr(Schema.String),
  status: PersonalLeadBotChangeStatus,
  /** What came of it, in words; null while pending. */
  outcome: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  decidedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalLeadBotChange = typeof PersonalLeadBotChange.Type;

/** Pending changes and the ones settled in the last 7 days, oldest first. */
export const PersonalLeadBotChangeListResult = Schema.Struct({
  changes: Schema.Array(PersonalLeadBotChange),
});
export type PersonalLeadBotChangeListResult = typeof PersonalLeadBotChangeListResult.Type;

export const PersonalLeadBotChangeDecideInput = Schema.Struct({
  changeId: PersonalLeadBotChangeId,
  /** The hash the card was showing; the server refuses the tap if it is not this change's. */
  changeHash: TrimmedNonEmptyString,
  decision: Schema.Literals(["approved", "declined"]),
});
export type PersonalLeadBotChangeDecideInput = typeof PersonalLeadBotChangeDecideInput.Type;

export class PersonalLeadBotChangesError extends Schema.TaggedError<PersonalLeadBotChangesError>()(
  "PersonalLeadBotChangesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
