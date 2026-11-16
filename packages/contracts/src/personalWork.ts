import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
  /** An ISO instant. Keyed query families carry JSON, so the boundary takes a string. */
  since: Schema.String.check(
    Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
      expected: "an ISO instant",
    }),
  ),
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

/** The most question cards the Work tab carries. */
export const PERSONAL_WORK_QUESTIONS_MAX = 10;
/** A question is read from the reply's last sentence, cut at this length. */
export const PERSONAL_WORK_QUESTION_MAX_CHARS = 140;
/** A reply older than this no longer asks for an answer. */
export const PERSONAL_WORK_QUESTION_MAX_AGE_HOURS = 72;
export const PERSONAL_WORK_ANSWER_CHOICE_MAX_CHARS = 120;

/**
 * One bot question with fixed choices, still awaiting the owner. `question` and
 * `options` are null together when the bot hides previews: the card then offers
 * only the chat.
 */
export const PersonalWorkQuestion = Schema.Struct({
  threadId: ThreadId,
  botId: PersonalBotId,
  messageId: MessageId,
  askedAt: Schema.DateTimeUtcFromString,
  question: Schema.NullOr(Schema.String),
  options: Schema.NullOr(Schema.Array(Schema.String)),
});
export type PersonalWorkQuestion = typeof PersonalWorkQuestion.Type;

export const PersonalWorkQuestionsResult = Schema.Struct({
  /** Newest first, at most 10. */
  questions: Schema.Array(PersonalWorkQuestion),
});
export type PersonalWorkQuestionsResult = typeof PersonalWorkQuestionsResult.Type;

export const PersonalWorkAnswerInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  choice: Schema.String.check(Schema.isMaxLength(PERSONAL_WORK_ANSWER_CHOICE_MAX_CHARS)),
  /** One per tap, reused for retries of that tap; the server answers a repeat. */
  commandId: TrimmedNonEmptyString,
});
export type PersonalWorkAnswerInput = typeof PersonalWorkAnswerInput.Type;

/**
 * What one answer tap came to. `stale` means the bot has spoken since the card
 * was drawn; `unknownChoice` means the reply no longer offers that option.
 */
export const PersonalWorkAnswerResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("sent") }),
  Schema.Struct({ status: Schema.Literal("stale") }),
  Schema.Struct({ status: Schema.Literal("unknownChoice") }),
]);
export type PersonalWorkAnswerResult = typeof PersonalWorkAnswerResult.Type;
