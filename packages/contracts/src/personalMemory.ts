import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

export const PersonalMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalMemoryId"));
export type PersonalMemoryId = typeof PersonalMemoryId.Type;

/**
 * shared: every bot (facts about the user themselves). team: one team's bots
 * (scopeId = team name, e.g. "dev"). bot: one bot (scopeId = botId).
 * project: one project (scopeId = projectId).
 */
export const PersonalMemoryScope = Schema.Literals(["shared", "team", "bot", "project"]);
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
  /** Set when a newer entry replaced this one: kept for Restore, never given to a bot. */
  supersededAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  /** The entry that replaced it, when there is one. */
  supersededBy: Schema.optional(Schema.NullOr(PersonalMemoryId)),
  /** Why, in words: "Replaced by a newer save", or the tidy-up's reason. */
  supersededReason: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PersonalMemoryEntry = typeof PersonalMemoryEntry.Type;

export const PersonalMemoryListInput = Schema.Struct({
  scope: Schema.optional(PersonalMemoryScope),
  scopeId: Schema.optional(Schema.String),
  kind: Schema.optional(PersonalMemoryKind),
  /** current (default): what bots receive. superseded: replaced entries, for Restore. */
  status: Schema.optional(Schema.Literals(["current", "superseded"])),
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

/** The most entries one bulk delete takes; the phone sends larger selections in parts. */
export const PERSONAL_MEMORY_BATCH_MAX = 500;

/** Deletes several entries, one at a time, each exactly as `personalMemory.delete` would. */
export const PersonalMemoryDeleteManyInput = Schema.Struct({
  memoryIds: Schema.Array(PersonalMemoryId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PERSONAL_MEMORY_BATCH_MAX),
  ),
});
export type PersonalMemoryDeleteManyInput = typeof PersonalMemoryDeleteManyInput.Type;

/** What a bulk memory delete did: the entries it removed, and the ones it could not, with the reason. */
export const PersonalMemoryBatchResult = Schema.Struct({
  done: Schema.Array(PersonalMemoryId),
  failed: Schema.Array(
    Schema.Struct({
      memoryId: PersonalMemoryId,
      message: Schema.String,
    }),
  ),
});
export type PersonalMemoryBatchResult = typeof PersonalMemoryBatchResult.Type;

/** Brings a superseded entry back: bots receive it again. */
export const PersonalMemoryRestoreInput = Schema.Struct({ memoryId: PersonalMemoryId });
export type PersonalMemoryRestoreInput = typeof PersonalMemoryRestoreInput.Type;

/** merge: several entries folded into one. supersede: older entries replaced. leave: unsure, untouched. */
/**
 * merge: several entries folded into one. supersede: older entries archived.
 * reclassify: one entry's kind or reach changes (never its text). save: a bot's new
 * entry (content, toKind, toScope, toScopeId), replacing memoryIds if any. forget: a
 * bot asks to archive memoryIds. split: one long entry becomes several single
 * facts (parts), and the long one is archived. leave: unsure, untouched.
 */
export const PersonalMemoryTidyAction = Schema.Literals([
  "merge",
  "supersede",
  "reclassify",
  "save",
  "forget",
  "split",
  "leave",
]);
export type PersonalMemoryTidyAction = typeof PersonalMemoryTidyAction.Type;

/**
 * applied: made by the run. preview: a preview run listed it. pending: needs
 * the owner's OK (a merge's new wording, or retiring an entry with no newer
 * one). approved / rejected: the owner's answer. left: unsure, untouched.
 */
export const PersonalMemoryTidyChangeStatus = Schema.Literals([
  "applied",
  "preview",
  "pending",
  "approved",
  "rejected",
  "left",
  /** Taken back by a later proposals file before the owner answered. */
  "withdrawn",
]);
export type PersonalMemoryTidyChangeStatus = typeof PersonalMemoryTidyChangeStatus.Type;

/** An entry a pending change is bound to, as it was when proposed. */
export const PersonalMemoryBoundEntry = Schema.Struct({
  memoryId: PersonalMemoryId,
  kind: Schema.String,
  scope: Schema.String,
  scopeId: Schema.NullOr(Schema.String),
  /** Held to its text only: the newer entry a supersede keeps. */
  textOnly: Schema.Boolean,
});
export type PersonalMemoryBoundEntry = typeof PersonalMemoryBoundEntry.Type;

/** One single fact a long entry is split into, with the kind and reach it gets. */
export const PersonalMemorySplitPart = Schema.Struct({
  content: Schema.String,
  kind: Schema.Literals(["note", "preference"]),
  scope: Schema.Literals(["shared", "team"]),
  /** The team's name for a team reach, else null. */
  scopeId: Schema.NullOr(Schema.String),
});
export type PersonalMemorySplitPart = typeof PersonalMemorySplitPart.Type;

export const PersonalMemoryTidyChange = Schema.Struct({
  changeId: Schema.Number,
  status: PersonalMemoryTidyChangeStatus,
  action: PersonalMemoryTidyAction,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  /** The entries merged or superseded (or, for leave, looked at). */
  memoryIds: Schema.Array(PersonalMemoryId),
  /** The entry that now carries the fact. */
  resultMemoryId: Schema.NullOr(PersonalMemoryId),
  /**
   * A merge's combined text; a save's new text; a supersede's newer entry as
   * it read when proposed (null for older changes).
   */
  content: Schema.NullOr(Schema.String),
  /**
   * What an approval is bound to, per entry, as proposed: the entries it
   * archives, merges, forgets or reclassifies by text, kind and reach; the
   * entry a supersede keeps by text only (textOnly). Empty on older changes,
   * which are bound to exact entry versions instead.
   */
  bound: Schema.optional(Schema.Array(PersonalMemoryBoundEntry)),
  /** A split's single facts, in order, each with its own kind and reach. */
  parts: Schema.optional(Schema.Array(PersonalMemorySplitPart)),
  /**
   * A reclassify's new kind, scope and scope id (team name), where they
   * change; a save's or split's kind and reach ("bot": only the proposing bot).
   */
  toKind: Schema.optional(Schema.NullOr(Schema.Literals(["note", "preference"]))),
  toScope: Schema.optional(Schema.NullOr(Schema.Literals(["shared", "team", "bot"]))),
  toScopeId: Schema.optional(Schema.NullOr(Schema.String)),
  /** Who proposed it: the tidy-up, a bot ("bot:<id>") or a local proposals file. */
  proposedBy: Schema.optional(Schema.NullOr(Schema.String)),
  /** What an approval is bound to: the change and every entry version it saw. */
  changeHash: Schema.String,
  reason: Schema.String,
});
export type PersonalMemoryTidyChange = typeof PersonalMemoryTidyChange.Type;

/** One nightly (or preview) run of the memory tidy-up and what it changed: its changelog. */
export const PersonalMemoryTidyRun = Schema.Struct({
  runId: Schema.String,
  startedAt: Schema.DateTimeUtcFromString,
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  status: Schema.Literals(["running", "done", "failed"]),
  /** A preview: the changes were listed, not made. */
  dryRun: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  merged: Schema.Number,
  superseded: Schema.Number,
  /** Changes this run put on the approval list. */
  pending: Schema.optional(Schema.Number),
  leftAlone: Schema.Number,
  error: Schema.NullOr(Schema.String),
  changes: Schema.Array(PersonalMemoryTidyChange),
});
export type PersonalMemoryTidyRun = typeof PersonalMemoryTidyRun.Type;

export const PersonalMemoryTidyLogInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
});
export type PersonalMemoryTidyLogInput = typeof PersonalMemoryTidyLogInput.Type;

/**
 * What the nightly tidy-up (03:30) does. preview: lists what it would change
 * and changes nothing (the default until the owner has reviewed one). on:
 * makes the changes. off: does not run.
 */
export const PersonalMemoryTidyMode = Schema.Literals(["off", "preview", "on"]);
export type PersonalMemoryTidyMode = typeof PersonalMemoryTidyMode.Type;

export const PersonalMemoryTidyLogResult = Schema.Struct({
  mode: PersonalMemoryTidyMode,
  runs: Schema.Array(PersonalMemoryTidyRun),
});
export type PersonalMemoryTidyLogResult = typeof PersonalMemoryTidyLogResult.Type;

export const PersonalMemoryTidySetModeInput = Schema.Struct({ mode: PersonalMemoryTidyMode });
export type PersonalMemoryTidySetModeInput = typeof PersonalMemoryTidySetModeInput.Type;

/** The owner's answer to a pending tidy-up change. */
export const PersonalMemoryTidyDecideInput = Schema.Struct({
  changeId: Schema.Number,
  approve: Schema.Boolean,
  /** The hash the card or list was showing; the tap is refused unless it is this change's. */
  changeHash: Schema.String,
});

/** An entry a bot's change would replace or forget, shown whole on the card. */
export const PersonalMemoryCardTarget = Schema.Struct({
  memoryId: PersonalMemoryId,
  kind: PersonalMemoryKind,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  content: Schema.String,
});
export type PersonalMemoryCardTarget = typeof PersonalMemoryCardTarget.Type;

/**
 * A bot's change to memory other bots see, as a Save / Don't save card in the
 * chat it happened in. Nothing applies until the owner taps Save.
 */
export const PersonalMemoryCard = Schema.Struct({
  changeId: Schema.Number,
  changeHash: Schema.String,
  threadId: Schema.String,
  action: Schema.Literals(["save", "forget"]),
  /** "bot:<id>". */
  proposedBy: Schema.NullOr(Schema.String),
  /** A save's new entry: its exact text, kind and reach. */
  content: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.Literals(["note", "preference"])),
  /** "bot": only the proposing bot will see it. */
  scope: Schema.NullOr(Schema.Literals(["shared", "team", "bot"])),
  scopeId: Schema.NullOr(Schema.String),
  /** The entries it replaces (save) or forgets (forget), whole, as they were proposed. */
  targets: Schema.Array(PersonalMemoryCardTarget),
  status: PersonalMemoryTidyChangeStatus,
  createdAt: Schema.DateTimeUtcFromString,
  decidedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalMemoryCard = typeof PersonalMemoryCard.Type;

export const PersonalMemoryCardsInput = Schema.Struct({ threadId: TrimmedNonEmptyString });
export type PersonalMemoryCardsInput = typeof PersonalMemoryCardsInput.Type;

export const PersonalMemoryCardsResult = Schema.Struct({
  cards: Schema.Array(PersonalMemoryCard),
});
export type PersonalMemoryCardsResult = typeof PersonalMemoryCardsResult.Type;
export type PersonalMemoryTidyDecideInput = typeof PersonalMemoryTidyDecideInput.Type;

/** Runs the tidy-up now. dryRun (the default) only lists what it would change. */
export const PersonalMemoryTidyRunInput = Schema.Struct({
  dryRun: Schema.optional(Schema.Boolean),
});
export type PersonalMemoryTidyRunInput = typeof PersonalMemoryTidyRunInput.Type;

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
