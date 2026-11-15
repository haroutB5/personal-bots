import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalProjectId } from "./personalProjects.ts";
import { PersonalTaskId, PersonalTaskSource } from "./personalTasks.ts";

/** A task as a digest line names it: everything `taskDisplayTitle` reads. */
export const WorkTaskRef = Schema.Struct({
  taskId: PersonalTaskId,
  botId: PersonalBotId,
  threadId: Schema.NullOr(ThreadId),
  source: PersonalTaskSource,
  parentTaskId: Schema.NullOr(PersonalTaskId),
  title: Schema.String,
});
export type WorkTaskRef = typeof WorkTaskRef.Type;

/**
 * One thing the Work tab's digest can say. Tagged, so every line renders from
 * the event alone and a new kind cannot be half-rendered.
 */
export const PersonalWorkEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("taskDone"),
    at: Schema.DateTimeUtcFromString,
    task: WorkTaskRef,
  }),
  Schema.Struct({
    kind: Schema.Literal("taskFailed"),
    at: Schema.DateTimeUtcFromString,
    task: WorkTaskRef,
    status: Schema.Literals(["failed", "interrupted"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("taskRestarted"),
    at: Schema.DateTimeUtcFromString,
    task: WorkTaskRef,
  }),
  Schema.Struct({
    kind: Schema.Literal("taskStarted"),
    at: Schema.DateTimeUtcFromString,
    task: WorkTaskRef,
  }),
  Schema.Struct({
    kind: Schema.Literal("goalOpened"),
    at: Schema.DateTimeUtcFromString,
    projectId: PersonalProjectId,
    name: Schema.String,
    leadBotId: PersonalBotId,
  }),
  Schema.Struct({
    kind: Schema.Literal("goalClosed"),
    at: Schema.DateTimeUtcFromString,
    projectId: PersonalProjectId,
    name: Schema.String,
    outcome: Schema.Literals(["done", "dropped"]),
  }),
]);
export type PersonalWorkEvent = typeof PersonalWorkEvent.Type;

export const PersonalWorkSinceInput = Schema.Struct({
  since: Schema.DateTimeUtcFromString,
});
export type PersonalWorkSinceInput = typeof PersonalWorkSinceInput.Type;

export const PersonalWorkSinceResult = Schema.Struct({
  /** Newest first, at most 60. */
  events: Schema.Array(PersonalWorkEvent),
  /** Events older than the 60 kept, so the phone can say how many it cannot show. */
  omitted: Schema.Number,
  /** The server's clock when the read ran; the phone stores this as seenAt. */
  asOf: Schema.DateTimeUtcFromString,
});
export type PersonalWorkSinceResult = typeof PersonalWorkSinceResult.Type;

/** How far back a digest reaches, however old `since` is. */
export const PERSONAL_WORK_SINCE_DAYS = 7;
/** The most events one digest carries. */
export const PERSONAL_WORK_SINCE_MAX = 60;
