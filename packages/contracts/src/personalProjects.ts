import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

export const PersonalProjectId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalProjectId"));
export type PersonalProjectId = typeof PersonalProjectId.Type;

export const PersonalProjectStepState = Schema.Literals(["done", "doing", "todo"]);
export type PersonalProjectStepState = typeof PersonalProjectStepState.Type;

export const PersonalProjectStep = Schema.Struct({
  label: TrimmedNonEmptyString,
  state: PersonalProjectStepState,
});
export type PersonalProjectStep = typeof PersonalProjectStep.Type;

/** The lead's estimate. Both times or neither. */
export const PersonalProjectEstimate = Schema.Struct({
  dueAt: Schema.DateTimeUtcFromString,
  estimatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalProjectEstimate = typeof PersonalProjectEstimate.Type;

export const PersonalProjectState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open") }),
  Schema.Struct({ kind: Schema.Literal("done"), closedAt: Schema.DateTimeUtcFromString }),
  Schema.Struct({ kind: Schema.Literal("dropped"), closedAt: Schema.DateTimeUtcFromString }),
]);
export type PersonalProjectState = typeof PersonalProjectState.Type;

export const PERSONAL_PROJECT_WHY_MAX = 140;
/** Chats one goal tags: its own first, then the newest others. */
export const PERSONAL_PROJECT_CHATS_MAX = 10;

/**
 * Work a team lead keeps across many tasks. The lead writes the name, the
 * steps and the estimate; which tasks belong to it is `projectId` on the task,
 * and last activity is the newest of the project row and its linked tasks.
 */
export const PersonalProject = Schema.Struct({
  projectId: PersonalProjectId,
  leadBotId: PersonalBotId,
  /** The lead chat it was last updated from. */
  threadId: Schema.NullOr(ThreadId),
  name: TrimmedNonEmptyString,
  steps: Schema.NonEmptyArray(PersonalProjectStep),
  estimate: Schema.NullOr(PersonalProjectEstimate),
  state: PersonalProjectState,
  lastActivityAt: Schema.DateTimeUtcFromString,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  /** One plain line from the lead on why this goal matters. Absent on old servers. */
  why: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(PERSONAL_PROJECT_WHY_MAX))),
  ),
  /**
   * The chats working on it, its own chat first and then the newest others,
   * at most `PERSONAL_PROJECT_CHATS_MAX`. Absent on old servers, where the
   * phone tags `threadId` only.
   */
  chats: Schema.optional(
    Schema.Array(ThreadId).check(Schema.isMaxLength(PERSONAL_PROJECT_CHATS_MAX)),
  ),
});
export type PersonalProject = typeof PersonalProject.Type;

/** Open projects, plus those closed in the last 30 days. */
export const PersonalProjectListResult = Schema.Struct({
  projects: Schema.Array(PersonalProject),
});
export type PersonalProjectListResult = typeof PersonalProjectListResult.Type;

/** One durable change to a goal's plan, as the lead's updates recorded it. */
export const PersonalProjectHistoryEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("step"),
    at: Schema.DateTimeUtcFromString,
    label: Schema.String,
    state: PersonalProjectStepState,
  }),
  Schema.Struct({
    kind: Schema.Literal("replanned"),
    at: Schema.DateTimeUtcFromString,
    steps: Schema.Number,
  }),
]);
export type PersonalProjectHistoryEntry = typeof PersonalProjectHistoryEntry.Type;

export const PersonalProjectHistoryInput = Schema.Struct({
  projectId: PersonalProjectId,
});
export type PersonalProjectHistoryInput = typeof PersonalProjectHistoryInput.Type;
