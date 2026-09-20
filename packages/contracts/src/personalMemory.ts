import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

export const PersonalMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalMemoryId"));
export type PersonalMemoryId = typeof PersonalMemoryId.Type;

/** shared: every bot. bot: one bot (scopeId = botId). project: one project (scopeId = projectId). */
export const PersonalMemoryScope = Schema.Literals(["shared", "bot", "project"]);
export type PersonalMemoryScope = typeof PersonalMemoryScope.Type;

/** task_summary entries are derived from finished tasks and never treated as preferences. */
export const PersonalMemoryKind = Schema.Literals(["note", "preference", "task_summary"]);
export type PersonalMemoryKind = typeof PersonalMemoryKind.Type;

export const PERSONAL_MEMORY_MAX_LENGTH = 2_000;

export const PersonalMemoryContent = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PERSONAL_MEMORY_MAX_LENGTH),
);

export const PersonalMemoryEntry = Schema.Struct({
  memoryId: PersonalMemoryId,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  kind: PersonalMemoryKind,
  content: Schema.String,
  /** Where it came from: `user`, `bot:<botId>`, `task:<taskId>`. */
  source: Schema.String,
  sensitivity: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  version: Schema.Number,
});
export type PersonalMemoryEntry = typeof PersonalMemoryEntry.Type;

export const PersonalMemoryListInput = Schema.Struct({
  scope: Schema.optional(PersonalMemoryScope),
  scopeId: Schema.optional(Schema.String),
  kind: Schema.optional(PersonalMemoryKind),
});
export type PersonalMemoryListInput = typeof PersonalMemoryListInput.Type;

export const PersonalMemoryListResult = Schema.Struct({
  entries: Schema.Array(PersonalMemoryEntry),
});
export type PersonalMemoryListResult = typeof PersonalMemoryListResult.Type;

export const PersonalMemorySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  /** Limits results to shared entries plus this bot's; omitted = every scope. */
  botId: Schema.optional(PersonalBotId),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type PersonalMemorySearchInput = typeof PersonalMemorySearchInput.Type;

export const PersonalMemoryUpdateInput = Schema.Struct({
  memoryId: PersonalMemoryId,
  content: Schema.optional(PersonalMemoryContent),
  kind: Schema.optional(Schema.Literals(["note", "preference"])),
});
export type PersonalMemoryUpdateInput = typeof PersonalMemoryUpdateInput.Type;

export const PersonalMemoryDeleteInput = Schema.Struct({ memoryId: PersonalMemoryId });
export type PersonalMemoryDeleteInput = typeof PersonalMemoryDeleteInput.Type;

export class PersonalMemoryError extends Schema.TaggedError<PersonalMemoryError>()(
  "PersonalMemoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The canned user turn behind "Wrapup". It lives here, beside the memory
 * contracts, because the server's save_memory consent guard reads the user's
 * own words: if this wording and that guard drift apart, wrapup silently
 * summarizes a chat and then refuses to store it, which is what shipped once.
 * A server test asserts the guard still accepts this exact string.
 */
export const WRAPUP_CHAT_PROMPT =
  "Wrap up this chat: summarize the key points, decisions and any preferences I expressed, then remember that summary with save_memory so future chats can find it. Keep the summary concise.";
