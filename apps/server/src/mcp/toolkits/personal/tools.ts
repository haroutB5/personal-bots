import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Any refusal or failure of a personal tool, worded for the model. */
export class PersonalToolError extends Schema.TaggedError<PersonalToolError>()(
  "PersonalToolError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const PersonalToolFailure = Schema.Union([McpCapabilityUnavailableError, PersonalToolError]);

export const Weekday = Schema.Literals([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

export const CreateRoutineInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({
    description: "Short name for the routine, e.g. 'Morning briefing'.",
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description: "What the bot should do each time the routine runs, written as a task.",
  }),
  frequency: Schema.Literals(["daily", "weekly", "every_n_hours", "once"]).annotate({
    description: "daily, weekly (with days), every_n_hours (with everyHours) or once (with date).",
  }),
  time: Schema.optional(
    Schema.String.annotate({
      description: "Local 24-hour time HH:MM. Required for daily, weekly and once.",
    }),
  ),
  days: Schema.optional(
    Schema.Array(Weekday).annotate({ description: "Days of the week, for weekly routines." }),
  ),
  everyHours: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 168 })).annotate({
      description: "Interval in hours, for every_n_hours routines.",
    }),
  ),
  date: Schema.optional(
    Schema.String.annotate({ description: "Local date YYYY-MM-DD, for once routines." }),
  ),
  timeZone: Schema.optional(
    Schema.String.annotate({
      description: "IANA time zone of the wall-clock time. Defaults to Europe/London.",
    }),
  ),
  missedRuns: Schema.optional(
    Schema.Literals(["catch_up_once", "skip"]).annotate({
      description:
        "What happens to runs missed while the laptop was asleep: catch_up_once (default) runs once for the latest missed time, skip runs none.",
    }),
  ),
  botName: Schema.optional(
    Schema.String.annotate({
      description: "Which bot runs the routine. Defaults to you (the bot in this chat).",
    }),
  ),
});
export type CreateRoutineInput = typeof CreateRoutineInput.Type;

export const CreateRoutineResult = Schema.Struct({
  routineId: Schema.String,
  summary: Schema.String.annotate({
    description: "One-line confirmation to show the user, with time zone and next run.",
  }),
  timeZone: Schema.String,
  nextRunLocal: Schema.NullOr(Schema.String),
  nextRunUtc: Schema.NullOr(Schema.String),
});
export type CreateRoutineResult = typeof CreateRoutineResult.Type;

export const ListRoutinesResult = Schema.Struct({
  routines: Schema.Array(
    Schema.Struct({
      routineId: Schema.String,
      title: Schema.String,
      botName: Schema.String,
      schedule: Schema.String,
      enabled: Schema.Boolean,
      nextRunLocal: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ListRoutinesResult = typeof ListRoutinesResult.Type;

export const SearchMemoryInput = Schema.Struct({
  query: TrimmedNonEmptyString.annotate({ description: "Words to look for in saved memory." }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});

export const SearchMemoryResult = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      memoryId: Schema.String,
      kind: Schema.String,
      scope: Schema.String,
      content: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
});
export type SearchMemoryResult = typeof SearchMemoryResult.Type;

export const SaveMemoryInput = Schema.Struct({
  content: TrimmedNonEmptyString.annotate({
    description: "The fact or preference to remember, as one short self-contained sentence.",
  }),
  userRequest: TrimmedNonEmptyString.annotate({
    description:
      "The user's own words asking you to remember this, quoted verbatim (e.g. 'remember that I take my coffee black').",
  }),
  kind: Schema.optional(
    Schema.Literals(["note", "preference"]).annotate({ description: "Defaults to note." }),
  ),
  scope: Schema.optional(
    Schema.Literals(["shared", "bot"]).annotate({
      description: "shared (default): every bot sees it. bot: only you.",
    }),
  ),
});
export type SaveMemoryInput = typeof SaveMemoryInput.Type;

export const SaveMemoryResult = Schema.Struct({
  memoryId: Schema.String,
  scope: Schema.String,
  kind: Schema.String,
});

const CreateRoutineTool = Tool.make("create_routine", {
  description:
    "Schedule a recurring or one-off routine: at each run the chosen bot gets the prompt as a task. Times are local wall-clock times in the routine's time zone (default Europe/London). Show the returned summary, including the time zone and next run, to the user.",
  parameters: CreateRoutineInput,
  success: CreateRoutineResult,
  failure: PersonalToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create routine")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListRoutinesTool = Tool.make("list_routines", {
  description: "List the user's routines with their schedule, bot, state and next run.",
  success: ListRoutinesResult,
  failure: PersonalToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List routines")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchMemoryTool = Tool.make("search_memory", {
  description:
    "Search what the user asked bots to remember (shared entries plus yours) and summaries of past tasks. Task summaries describe past work, not preferences.",
  parameters: SearchMemoryInput,
  success: SearchMemoryResult,
  failure: PersonalToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Search memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SaveMemoryTool = Tool.make("save_memory", {
  description:
    "Save a fact or preference to long-term memory. ONLY when the user explicitly asks you to remember something; pass their words in userRequest. Never save passwords, tokens, keys or other secrets: those are rejected.",
  parameters: SaveMemoryInput,
  success: SaveMemoryResult,
  failure: PersonalToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Save memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PersonalToolkit = Toolkit.make(
  CreateRoutineTool,
  ListRoutinesTool,
  SearchMemoryTool,
  SaveMemoryTool,
);
