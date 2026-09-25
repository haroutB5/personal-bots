import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

export const PersonalTaskId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalTaskId"));
export type PersonalTaskId = typeof PersonalTaskId.Type;

export const PersonalTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_for_agent",
  "waiting_for_user",
  "waiting_for_browser",
  "rate_limited",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type PersonalTaskStatus = typeof PersonalTaskStatus.Type;

/** Statuses a task never leaves on its own; only `retry` moves it again. */
export const PERSONAL_TASK_TERMINAL_STATUSES: ReadonlyArray<PersonalTaskStatus> = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
];

/** Statuses `personalTasks.retry` accepts. */
export const PERSONAL_TASK_RETRYABLE_STATUSES: ReadonlyArray<PersonalTaskStatus> = [
  "failed",
  "interrupted",
  "cancelled",
];

export const PersonalTaskSource = Schema.Literals(["user", "delegation", "routine"]);
export type PersonalTaskSource = typeof PersonalTaskSource.Type;

export const PersonalTaskResult = Schema.Struct({
  /** The last assistant message of the attempt that completed the task. */
  summary: Schema.String,
});
export type PersonalTaskResult = typeof PersonalTaskResult.Type;

export const PersonalTask = Schema.Struct({
  taskId: PersonalTaskId,
  rootTaskId: PersonalTaskId,
  parentTaskId: Schema.NullOr(PersonalTaskId),
  botId: PersonalBotId,
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  objective: Schema.String,
  acceptanceCriteria: Schema.String,
  expectedOutput: Schema.String,
  status: PersonalTaskStatus,
  source: PersonalTaskSource,
  idempotencyKey: TrimmedNonEmptyString,
  depth: Schema.Number,
  maxDepth: Schema.Number,
  maxChildren: Schema.Number,
  result: Schema.NullOr(PersonalTaskResult),
  errorCategory: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  /** When a rate-limited task becomes claimable again. */
  availableAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /**
   * Set on the summaries the task feed, history and related lists send:
   * objective, acceptanceCriteria and expectedOutput are blank and
   * result.summary is a short preview. personalTasks.get has the full task.
   */
  detailOmitted: Schema.optional(Schema.Boolean),
});
export type PersonalTask = typeof PersonalTask.Type;

export const PersonalTaskAttempt = Schema.Struct({
  taskId: PersonalTaskId,
  attempt: Schema.Number,
  providerThreadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  leaseOwner: Schema.String,
  leaseExpiresAt: Schema.DateTimeUtcFromString,
  heartbeatAt: Schema.DateTimeUtcFromString,
  startedAt: Schema.DateTimeUtcFromString,
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  errorCategory: Schema.NullOr(Schema.String),
  resumable: Schema.Boolean,
});
export type PersonalTaskAttempt = typeof PersonalTaskAttempt.Type;

/** What a delegating bot hands the child bot. */
export const PersonalDelegationBrief = Schema.Struct({
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  context: Schema.optional(Schema.String),
  constraints: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.String),
  expectedOutput: Schema.optional(Schema.String),
});
export type PersonalDelegationBrief = typeof PersonalDelegationBrief.Type;

/**
 * pending: child not finished. returned: child finished, result waiting for
 * the parent's continuation. delivered: included in a parent continuation.
 * cancelled: the child was cancelled together with its parent.
 */
export const PersonalHandoffStatus = Schema.Literals([
  "pending",
  "returned",
  "delivered",
  "cancelled",
]);
export type PersonalHandoffStatus = typeof PersonalHandoffStatus.Type;

export const PersonalHandoff = Schema.Struct({
  parentTaskId: PersonalTaskId,
  childTaskId: PersonalTaskId,
  brief: PersonalDelegationBrief,
  dependencies: Schema.Array(PersonalTaskId),
  resultSummary: Schema.NullOr(Schema.String),
  status: PersonalHandoffStatus,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalHandoff = typeof PersonalHandoff.Type;

export const PersonalTaskCreateInput = Schema.Struct({
  /** Client-generated. Creating twice with one key returns the first task. */
  idempotencyKey: TrimmedNonEmptyString,
  botId: PersonalBotId,
  title: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  acceptanceCriteria: Schema.optional(Schema.String),
  expectedOutput: Schema.optional(Schema.String),
});
export type PersonalTaskCreateInput = typeof PersonalTaskCreateInput.Type;

export const PersonalTaskIdInput = Schema.Struct({
  taskId: PersonalTaskId,
});
export type PersonalTaskIdInput = typeof PersonalTaskIdInput.Type;

export const PersonalTaskListInput = Schema.Struct({
  statuses: Schema.optional(Schema.Array(PersonalTaskStatus)),
  botId: Schema.optional(PersonalBotId),
  rootTaskId: Schema.optional(PersonalTaskId),
});
export type PersonalTaskListInput = typeof PersonalTaskListInput.Type;

export const PersonalTaskListResult = Schema.Struct({
  tasks: Schema.Array(PersonalTask),
});
export type PersonalTaskListResult = typeof PersonalTaskListResult.Type;

/** Finished tasks older than `before`, newest first, as summaries. */
export const PersonalTaskHistoryInput = Schema.Struct({
  /** The oldest finished task the client already has; omitted for the newest page. */
  before: Schema.optional(PersonalTaskId),
  /** 1-100, default 20. */
  limit: Schema.optional(Schema.Number),
});
export type PersonalTaskHistoryInput = typeof PersonalTaskHistoryInput.Type;

export const PersonalTaskHistoryResult = Schema.Struct({
  tasks: Schema.Array(PersonalTask),
  hasMore: Schema.Boolean,
});
export type PersonalTaskHistoryResult = typeof PersonalTaskHistoryResult.Type;

/**
 * Summaries of the tasks run in `threadId`, of the tasks named in `taskIds`,
 * and of the direct children of all of them: what a chat or a task screen
 * shows beyond the recent tasks the feed carries.
 */
export const PersonalTaskRelatedInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  taskIds: Schema.optional(Schema.Array(PersonalTaskId)),
});
export type PersonalTaskRelatedInput = typeof PersonalTaskRelatedInput.Type;

export const PersonalTaskDetail = Schema.Struct({
  task: PersonalTask,
  attempts: Schema.Array(PersonalTaskAttempt),
  /** Handoffs where this task is the parent (its delegated children). */
  children: Schema.Array(PersonalHandoff),
  /** The handoff that created this task, when it was delegated. */
  handoff: Schema.NullOr(PersonalHandoff),
});
export type PersonalTaskDetail = typeof PersonalTaskDetail.Type;

/**
 * `personalTasks.subscribe` replays every unfinished task and the newest
 * finished ones as upserts, then streams changes. Older finished tasks come
 * from `personalTasks.history` and `personalTasks.related`.
 */
export const PersonalTaskStreamEvent = Schema.Struct({
  type: Schema.Literal("upsert"),
  task: PersonalTask,
});
export type PersonalTaskStreamEvent = typeof PersonalTaskStreamEvent.Type;

/**
 * Marks a turn message the task service wrote (the user role is only what the
 * provider needs). Rides on the message's `context` as a forward-compatible
 * record of this kind: no text references it, so providers never see it and
 * the Developer view ignores it, while clients render the turn as a system row.
 */
export const PERSONAL_TASK_MESSAGE_CONTEXT_KIND = "personal-task";

/**
 * start: first attempt. retry: a later attempt of the same task.
 * continuation: the task resumes, with delegated results or resume notes.
 */
export const PersonalTaskTurnKind = Schema.Literals(["start", "retry", "continuation"]);
export type PersonalTaskTurnKind = typeof PersonalTaskTurnKind.Type;

export const PersonalTaskMessageMarker = Schema.Struct({
  taskId: PersonalTaskId,
  attempt: Schema.Number,
  turn: PersonalTaskTurnKind,
  source: PersonalTaskSource,
  title: Schema.String,
  /** The delegating bot, for a delegated task's first turns. */
  delegatorBotId: Schema.NullOr(PersonalBotId),
  /** Children whose results this continuation delivers, as they were then. */
  children: Schema.Array(
    Schema.Struct({
      taskId: PersonalTaskId,
      botId: Schema.NullOr(PersonalBotId),
      title: Schema.String,
      status: Schema.NullOr(PersonalTaskStatus),
    }),
  ),
});
export type PersonalTaskMessageMarker = typeof PersonalTaskMessageMarker.Type;

export class PersonalTasksError extends Schema.TaggedError<PersonalTasksError>()(
  "PersonalTasksError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
