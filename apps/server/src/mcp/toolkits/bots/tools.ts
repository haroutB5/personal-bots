import {
  McpCapabilityUnavailableError,
  PersonalSecretName,
  PersonalTaskId,
  PersonalTaskStatus,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

/** Every refusal the bots tools return; `reason` is written for the calling model. */
export class BotsToolError extends Schema.TaggedError<BotsToolError>()("BotsToolError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const BotsToolFailure = Schema.Union([McpCapabilityUnavailableError, BotsToolError]);
export type BotsToolFailure = typeof BotsToolFailure.Type;

export const BotEntry = Schema.Struct({
  botId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  provider: Schema.String.annotate({ description: "Provider instance the bot runs on." }),
  model: Schema.String,
  isYou: Schema.Boolean.annotate({ description: "True for the bot making this call." }),
});
export type BotEntry = typeof BotEntry.Type;

export const ListBotsResult = Schema.Struct({ bots: Schema.Array(BotEntry) });
export type ListBotsResult = typeof ListBotsResult.Type;

export const DelegateTaskInput = Schema.Struct({
  targetBot: TrimmedNonEmptyString.annotate({
    description: "The bot to hand the work to: its name (as list_bots shows it) or its botId.",
  }),
  objective: TrimmedNonEmptyString.annotate({
    description: "What the other bot must achieve, stated so it can work without asking you.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Short title for the task list. Defaults to the start of the objective.",
    }),
  ),
  context: Schema.optional(
    Schema.String.annotate({ description: "Background it needs: facts, links, prior findings." }),
  ),
  constraints: Schema.optional(
    Schema.String.annotate({ description: "Limits to respect: scope, tools, budget, style." }),
  ),
  acceptanceCriteria: Schema.optional(
    Schema.String.annotate({ description: "How you will judge the result done." }),
  ),
  expectedOutput: Schema.optional(
    Schema.String.annotate({ description: "The shape of the answer you want back." }),
  ),
});
export type DelegateTaskInput = typeof DelegateTaskInput.Type;

export const DelegateTaskResult = Schema.Struct({
  childTaskId: Schema.String,
  targetBotId: Schema.String,
  status: PersonalTaskStatus,
  note: Schema.String,
});
export type DelegateTaskResult = typeof DelegateTaskResult.Type;

export const TaskSummary = Schema.Struct({
  taskId: Schema.String,
  rootTaskId: Schema.String,
  parentTaskId: Schema.NullOr(Schema.String),
  botId: Schema.String,
  botName: Schema.NullOr(Schema.String),
  title: Schema.String,
  objective: Schema.String,
  status: PersonalTaskStatus,
  resultSummary: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type TaskSummary = typeof TaskSummary.Type;

export const GetTaskInput = Schema.Struct({
  taskId: PersonalTaskId.annotate({ description: "A task id from delegate_task or list_tasks." }),
});

export const GetTaskResult = Schema.Struct({
  task: TaskSummary,
  children: Schema.Array(TaskSummary),
});
export type GetTaskResult = typeof GetTaskResult.Type;

export const ListTasksInput = Schema.Struct({
  status: Schema.optional(
    PersonalTaskStatus.annotate({ description: "Only tasks in this status." }),
  ),
});

export const ListTasksResult = Schema.Struct({
  rootTaskId: Schema.NullOr(Schema.String),
  tasks: Schema.Array(TaskSummary),
});
export type ListTasksResult = typeof ListTasksResult.Type;

export const RequestSecretInput = Schema.Struct({
  name: PersonalSecretName.annotate({
    description:
      "UPPER_SNAKE name such as GITHUB_TOKEN. The value arrives as the environment variable PB_SECRET_<NAME>.",
  }),
  label: TrimmedNonEmptyString.annotate({
    description:
      "What the user sees on the secure form, for example 'GitHub personal access token'.",
  }),
  purpose: TrimmedNonEmptyString.annotate({
    description: "One sentence on why you need it and what you will do with it.",
  }),
});

export const RequestSecretResult = Schema.Struct({
  requestId: Schema.String,
  name: Schema.String,
  envVar: Schema.String,
  status: Schema.Literals(["pending", "fulfilled"]),
  note: Schema.String,
});
export type RequestSecretResult = typeof RequestSecretResult.Type;

const ListBotsTool = Tool.make("list_bots", {
  description:
    "List the personal bots you can delegate work to, with what each one is for. The roster changes at any time (the user creates, renames and deletes bots), so call this fresh before every delegate_task and never rely on a roster from earlier in the conversation.",
  success: ListBotsResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List bots")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Hand a self-contained piece of work to another bot. It runs in the background; you receive its result in a follow-up message, so end your turn after delegating instead of waiting. Calling again with the same bot and objective in the same turn returns the same task. Delegation depth and the number of delegated tasks per request are limited.",
  parameters: DelegateTaskInput,
  success: DelegateTaskResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Delegate task to a bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetTaskTool = Tool.make("get_task", {
  description:
    "Read one task in your current request's task tree: its status, result summary or error, and its delegated children.",
  parameters: GetTaskInput,
  success: GetTaskResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListTasksTool = Tool.make("list_tasks", {
  description:
    "List the tasks in your current request's task tree (the root request and everything delegated from it), newest first.",
  parameters: ListTasksInput,
  success: ListTasksResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for a password, API key or token through a secure form. Never ask for secrets in chat and never print one. After calling this, end your turn: you are resumed in a fresh session where the value is the environment variable PB_SECRET_<NAME> for shell commands.",
  parameters: RequestSecretInput,
  success: RequestSecretResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BotsToolkit = Toolkit.make(
  ListBotsTool,
  DelegateTaskTool,
  GetTaskTool,
  ListTasksTool,
  RequestSecretTool,
);
