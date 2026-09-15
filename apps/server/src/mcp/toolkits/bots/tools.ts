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

export const UseLoginInput = Schema.Struct({
  login: TrimmedNonEmptyString.annotate({
    description: "A saved login label, or its exact https origin such as https://example.com.",
  }),
});
export type UseLoginInput = typeof UseLoginInput.Type;

export const UseLoginResult = Schema.Struct({
  success: Schema.Literal(true),
  filled: Schema.Array(Schema.Literals(["username", "password"])),
});
export type UseLoginResult = typeof UseLoginResult.Type;

export const CloseBrowserResult = Schema.Struct({
  closed: Schema.Boolean.annotate({
    description: "False when the browser was already closed; nothing was changed.",
  }),
  note: Schema.String,
});
export type CloseBrowserResult = typeof CloseBrowserResult.Type;

export const RequestBrowserHelpInput = Schema.Struct({
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(160)).annotate({
    description: "Short reason the user must take over, for example 'CAPTCHA on amazon.co.uk'.",
  }),
});
export type RequestBrowserHelpInput = typeof RequestBrowserHelpInput.Type;

export const RequestBrowserHelpResult = Schema.Struct({
  requested: Schema.Literal(true),
  note: Schema.String,
});
export type RequestBrowserHelpResult = typeof RequestBrowserHelpResult.Type;

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
    "Ask the user for an API key or token through a secure form. Never use this for website passwords: those are the user's saved logins, filled by use_login. Never ask for secrets in chat and never print one. After calling this, end your turn: you are resumed in a fresh session where the value is the environment variable PB_SECRET_<NAME> for shell commands.",
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

const UseLoginTool = Tool.make("use_login", {
  description:
    "Fill a saved website login. Pass the login label or exact origin. Every bot may use every saved login, but only while your current tab is already on that exact origin. The server then opens a fresh tab of its own on that page, fills the username and password there and closes your tab on that origin, because a page script you ran earlier could otherwise read the value. You never receive the password; never type or paste one yourself. Your next browser call lands on the new tab, so submit with a known button or Enter; reads stay disabled on the credential-bearing tab, and the fill is refused outright on any origin where preview_evaluate has been used. If the site then asks for a 2FA or one-time code, call request_browser_help.",
  parameters: UseLoginInput,
  success: UseLoginResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Use a saved login")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CloseBrowserTool = Tool.make("close_browser", {
  description:
    "Close the shared browser when you are done with it, or when the user asks you to. Every tab is closed, Chrome is stopped and the session ends, so do this only when no further browsing is expected; the browser starts again on the next browser tool call. Refused while the user is controlling the browser themselves. Closing an already-closed browser is safe and does nothing.",
  success: CloseBrowserResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Close the browser")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RequestBrowserHelpTool = Tool.make("request_browser_help", {
  description:
    "Ask the user to take over the shared browser when a CAPTCHA, human-verification check, login, 2FA or one-time-code prompt blocks you, or when a browser action was paused because it could carry data from a site the user marked sensitive to another site (the user then sees the server's own description of that action). Give one short reason, tell the user what you need in one sentence, then end your turn. Never try to solve a CAPTCHA yourself.",
  parameters: RequestBrowserHelpInput,
  success: RequestBrowserHelpResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Request browser help")
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
  UseLoginTool,
  RequestBrowserHelpTool,
  CloseBrowserTool,
);
