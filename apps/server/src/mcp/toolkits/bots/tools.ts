import {
  BotAvatarColor,
  BotAvatarShape,
  McpCapabilityUnavailableError,
  PERSONAL_GROUP_VOTE_MAX_OPTIONS,
  PERSONAL_GROUP_VOTE_MIN_OPTIONS,
  PersonalBotNotificationMute,
  PersonalGroupVoteId,
  PersonalGroupVoteStatus,
  PersonalSecretName,
  PersonalTaskId,
  PersonalTaskStatus,
  PersonalTaskWorkRecord,
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
  /** While `waitingOnBackgroundSince` is set this is the bot's reply so far, not the final result. */
  resultSummary: Schema.NullOr(Schema.String),
  /** Only on a running task whose bot has replied and is waiting on background work: since when. */
  waitingOnBackgroundSince: Schema.optional(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type TaskSummary = typeof TaskSummary.Type;

export const GetTaskInput = Schema.Struct({
  taskId: PersonalTaskId.annotate({ description: "A task id from delegate_task or list_tasks." }),
});

export const TaskSteer = Schema.Struct({
  text: Schema.String,
  sentAt: Schema.String,
  /** False while it waits for the task's next turn. */
  delivered: Schema.Boolean,
});
export type TaskSteer = typeof TaskSteer.Type;

export const GetTaskResult = Schema.Struct({
  task: TaskSummary,
  children: Schema.Array(TaskSummary),
  /** Updates sent into the task with steer_task, oldest first. */
  steers: Schema.Array(TaskSteer),
  /** The task's work record (decisions, evidence, outstanding work, next step), when it has one. */
  workRecord: Schema.optional(Schema.NullOr(PersonalTaskWorkRecord)),
});
export type GetTaskResult = typeof GetTaskResult.Type;

export const UpdateWorkRecordInput = Schema.Struct({
  decisions: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(6)).annotate({
      description:
        "Decisions made since your last update, each one short and self-contained. They are added to the record.",
    }),
  ),
  evidence: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: TrimmedNonEmptyString.annotate({ description: "What it is, e.g. 'QA report'." }),
        ref: TrimmedNonEmptyString.annotate({
          description: "A link, file path, release id or commit that proves or holds it.",
        }),
      }),
    )
      .check(Schema.isMaxLength(6))
      .annotate({ description: "Where the proof is. Added to the record, once per ref." }),
  ),
  outstanding: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(10)).annotate({
      description:
        "Everything still left to do. This REPLACES the list, so send the whole current list (an empty list says nothing is left).",
    }),
  ),
  nextStep: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "The very next thing to do. Replaces the previous one.",
    }),
  ),
});
export type UpdateWorkRecordInput = typeof UpdateWorkRecordInput.Type;

export const UpdateWorkRecordResult = Schema.Struct({
  /** The record as it now reads. */
  record: Schema.String,
});

export const NotifyUserInput = Schema.Struct({
  notify: Schema.Boolean.annotate({
    description:
      "true: the user should be notified (push) when this run finishes. false: stay silent for this run.",
  }),
  message: Schema.optional(
    Schema.String.annotate({
      description:
        "With notify true: one short line for the notification itself, saying what is worth their attention (for example 'Price dropped to 120'). Plain text, at most about 200 characters; longer is cut. Never put secrets in it. Left out, the notification shows the task title.",
    }),
  ),
});
export type NotifyUserInput = typeof NotifyUserInput.Type;

export const NotifyUserResult = Schema.Struct({
  recorded: Schema.Boolean,
  /** What will happen, in a sentence: whether and how the user is notified when the run ends. */
  note: Schema.String,
});

export const ReadChatHistoryInput = Schema.Struct({
  query: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Only messages containing this text (case-insensitive).",
    }),
  ),
  beforeMessageId: Schema.optional(
    Schema.String.annotate({
      description: "Page further back: the messageId of the oldest message you already have.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "How many messages, 1 to 20. Defaults to 10.",
    }),
  ),
});

export const ReadChatHistoryResult = Schema.Struct({
  /** Newest first. */
  messages: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      role: Schema.String,
      at: Schema.String,
      text: Schema.String,
      /** True when the text was cut at 1,200 characters. */
      clipped: Schema.Boolean,
    }),
  ),
  hasMore: Schema.Boolean,
});

export const StopTaskInput = Schema.Struct({
  taskId: PersonalTaskId.annotate({ description: "A task id from delegate_task or list_tasks." }),
  reason: Schema.String.annotate({
    description:
      "Why you are stopping it, in one line. It shows on this tool call in the chat; the stopped bot is not told.",
  }),
  redirectObjective: Schema.optional(
    Schema.String.annotate({
      description:
        "New objective for the same bot. Given this, the stopped task is replaced by a fresh one in the same step, so the work never sits cancelled and forgotten. The new task carries only this text, with no context or constraints, so make it self-contained.",
    }),
  ),
});

export const StopTaskResult = Schema.Struct({
  taskId: PersonalTaskId,
  status: PersonalTaskStatus,
  redirectedTaskId: Schema.NullOr(PersonalTaskId),
});
export type StopTaskResult = typeof StopTaskResult.Type;

export const SteerTaskInput = Schema.Struct({
  taskId: PersonalTaskId.annotate({
    description:
      "A task id from delegate_task, list_tasks or an earlier result (a finished task keeps its id).",
  }),
  message: TrimmedNonEmptyString.annotate({
    description:
      "The update, written to the bot doing the task: what to change, narrow, add or drop, or for a finished task what is still left to do. It arrives as 'Update from <your name>: <message>', so make it make sense on its own.",
  }),
});

export const SteerTaskResult = Schema.Struct({
  taskId: PersonalTaskId,
  /**
   * steered: delivered into the running turn now. queued: the task is not in
   * a turn; the update opens its next one (a queued task starts with it).
   * reopened: the task had ended; it continues in its own chat with the update.
   */
  outcome: Schema.Literals(["steered", "queued", "reopened"]),
  status: PersonalTaskStatus,
  note: Schema.String,
});
export type SteerTaskResult = typeof SteerTaskResult.Type;

export const ListTasksInput = Schema.Struct({
  status: Schema.optional(
    PersonalTaskStatus.annotate({ description: "Only tasks in this status." }),
  ),
});

export const ListTasksResult = Schema.Struct({
  rootTaskId: Schema.NullOr(Schema.String),
  tasks: Schema.Array(TaskSummary),
  /**
   * Team leads only: unfinished tasks of your team's bots from outside your
   * current request's tree (other chats, routines), newest first.
   */
  teamTasks: Schema.Array(TaskSummary),
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

/** Longest reason the user is shown; a longer one is cut to fit, never refused. */
export const BROWSER_HELP_REASON_MAX_LENGTH = 160;

// No length check on the input: a validation error here reaches the bot as a
// bare schema message, and a bot the egress guard just paused then has no way
// to ask for help at all. The handler shortens the reason instead.
export const RequestBrowserHelpInput = Schema.Struct({
  reason: TrimmedNonEmptyString.annotate({
    description: `One short line saying why the user must take over, for example 'CAPTCHA on amazon.co.uk'. Anything past ${BROWSER_HELP_REASON_MAX_LENGTH} characters is cut off.`,
  }),
});
export type RequestBrowserHelpInput = typeof RequestBrowserHelpInput.Type;

export const RequestBrowserHelpResult = Schema.Struct({
  requested: Schema.Literal(true),
  note: Schema.String,
});
export type RequestBrowserHelpResult = typeof RequestBrowserHelpResult.Type;

export const CallVoteInput = Schema.Struct({
  question: TrimmedNonEmptyString.annotate({
    description:
      "The single decision the group is settling, as one question. Asking the same thing again in this conversation, however you reword it, is refused.",
  }),
  options: Schema.Array(
    TrimmedNonEmptyString.annotate({ description: "One answer members can choose." }),
  ).annotate({
    description: `The answers on the ballot: between ${PERSONAL_GROUP_VOTE_MIN_OPTIONS} and ${PERSONAL_GROUP_VOTE_MAX_OPTIONS} of them, each distinct. Name a bot in an option ("@Dev writes it") to say who would carry it out.`,
  }),
});
export type CallVoteInput = typeof CallVoteInput.Type;

export const CallVoteResult = Schema.Struct({
  voteId: Schema.String,
  options: Schema.Array(Schema.String),
  voters: Schema.Array(Schema.String).annotate({
    description: "Members who may ballot, you included.",
  }),
  note: Schema.String,
});
export type CallVoteResult = typeof CallVoteResult.Type;

export const CastVoteInput = Schema.Struct({
  voteId: PersonalGroupVoteId.annotate({
    description: "The open vote's id, as call_vote returned it or as the group chat announced it.",
  }),
  option: TrimmedNonEmptyString.annotate({
    description: "Exactly one of that vote's options.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "One line saying why. The user sees it beside your choice on the tally.",
  }),
});
export type CastVoteInput = typeof CastVoteInput.Type;

export const CastVoteResult = Schema.Struct({
  voteId: Schema.String,
  option: Schema.String,
  status: PersonalGroupVoteStatus,
  ballotsCast: Schema.Int,
  note: Schema.String,
});
export type CastVoteResult = typeof CastVoteResult.Type;

const LEAD_ONLY = "Team leads only.";
const NOT_SETTABLE = "Not settable by a lead: any value is refused.";
const USER_MADE_RULE =
  "A bot you created yourself is yours to manage while it stays on your team. Any other bot (one the user set up, another lead made, or one moved since) is not: removing it, or changing its name, instructions, description, model or effort, is not done at once. It puts a Yes/No card in this chat and nothing changes until Harout taps Yes himself; the call returns pending, so tell him in one line what you asked for and end your turn, and his answer arrives as a follow-up message. It works only from a chat turn Harout started (a routine, task or group turn is refused, so ask him to request it in chat). Title, avatar, mute and memory auto-save stay open. The built-in system bots (Updates, Sync reports and the seeded defaults) are never yours to change.";

/** The fields create_bot and update_bot share. Every one is optional. */
const BotFieldsShape = {
  title: Schema.optional(
    Schema.String.annotate({
      description: "Short role label under the name, at most 60 characters.",
    }),
  ),
  description: Schema.optional(
    Schema.String.annotate({
      description: "What the bot is for, one or two sentences (at most 500 characters).",
    }),
  ),
  instructions: Schema.optional(
    Schema.String.annotate({
      description:
        "The bot's standing instructions (at most 20000 characters). Never put a secret, key or password in them.",
    }),
  ),
  avatarShape: Schema.optional(BotAvatarShape.annotate({ description: "Avatar shape." })),
  avatarColor: Schema.optional(
    BotAvatarColor.annotate({ description: "Avatar colour as a hex value such as #1A73E8." }),
  ),
  provider: Schema.optional(
    Schema.String.annotate({
      description:
        "Provider instance the bot runs on (as list_bots shows under provider). Default: the bot's current one, or yours for a new bot.",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "A model slug that provider offers, for example claude-sonnet-5-5. Fable and Mythos models are refused. Default for a new bot: the standard seed model (Opus 5.5 at medium effort).",
    }),
  ),
  effort: Schema.optional(
    Schema.String.annotate({
      description: "An effort the model offers: low, medium, high, xhigh or max.",
    }),
  ),
  notificationsMute: Schema.optional(
    PersonalBotNotificationMute.annotate({
      description:
        'Silence this bot\'s notifications: "indefinitely", { "forMinutes": n } or "on" to turn them back on.',
    }),
  ),
  memoryAutoSave: Schema.optional(
    Schema.Boolean.annotate({
      description: "Let the bot save memories without the user asking each time.",
    }),
  ),
  team: Schema.optional(Schema.Unknown.annotate({ description: NOT_SETTABLE })),
  lead: Schema.optional(Schema.Unknown.annotate({ description: NOT_SETTABLE })),
  pinned: Schema.optional(Schema.Unknown.annotate({ description: NOT_SETTABLE })),
};

export const CreateBotInput = Schema.Struct({
  name: TrimmedNonEmptyString.annotate({
    description: "The new bot's name, at most 60 characters. Unique among all bots.",
  }),
  ...BotFieldsShape,
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const UpdateBotInput = Schema.Struct({
  bot: TrimmedNonEmptyString.annotate({
    description: "The bot to change: its botId or name as list_bots shows it.",
  }),
  name: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "A new name, at most 60 characters." }),
  ),
  ...BotFieldsShape,
});
export type UpdateBotInput = typeof UpdateBotInput.Type;

export const RemoveBotInput = Schema.Struct({
  bot: TrimmedNonEmptyString.annotate({
    description: "The bot to remove: its botId or name as list_bots shows it.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description:
      "Why, in one line. It is shown to the user with the notification and kept in the audit record.",
  }),
});
export type RemoveBotInput = typeof RemoveBotInput.Type;

export const LeadBotResult = Schema.Struct({
  botId: Schema.String,
  name: Schema.String,
  team: Schema.String,
  model: Schema.String.annotate({ description: 'Model and effort, for example "Sonnet 5.5 · H".' }),
  changed: Schema.Array(Schema.String).annotate({
    description: "The fields that changed (update_bot); empty otherwise.",
  }),
  line: Schema.String.annotate({
    description: "The line posted in your chat and sent to the user as a notification.",
  }),
  pending: Schema.Boolean.annotate({
    description:
      "True when nothing has changed yet: Harout has a Yes/No card to answer. Do not retry; his answer arrives later.",
  }),
  note: Schema.String,
});
export type LeadBotResult = typeof LeadBotResult.Type;

const ListBotsTool = Tool.make("list_bots", {
  description:
    "List the personal bots on your team, the ones you can delegate work to: each one's name, what it is for, the provider and model it runs on, and which entry is you. Bots on the other team are left out; delegate_task accepts one of them only once the user's own latest message names it. The roster changes at any time (the user creates, renames and deletes bots), so call this fresh before every delegate_task and never rely on a roster from earlier in the conversation.",
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
    "Hand a self-contained piece of work to another bot on your team. The other bot starts from nothing but what you pass here, so put what it needs in objective, context, constraints, acceptanceCriteria and expectedOutput. It runs in the background; you receive its result in a follow-up message, so end your turn after delegating instead of waiting. Calling again with the same bot and objective in the same turn returns the same task. Refused for: a bot on the other team, unless the user's own latest message names it; a bot already working above you on this request (handing work back to the bot that took the original request is allowed); and past the request's limits, by default two levels of delegation and four delegated tasks per request.",
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
    "Read one task in your current request's task tree (the request you are working on and everything delegated from it): its status, result summary or error, its direct children and the updates sent to it with steer_task. A task that is still running but whose bot has already replied (it is only waiting on background work it started) shows that reply in resultSummary with waitingOnBackgroundSince set; it is not the final result. A team lead can also read any unfinished task of a bot on its own team, whoever started it (another chat, a routine). You can also read, without changing it, a finished task that steer_task could reopen: one that ended within 24 hours and was delegated from this chat, or, for a team lead, belongs to a bot on your team; its workRecord shows where it stood, so read it before you steer. Any other id reads as not found. You do not need this to collect results: a delegated task's result arrives on its own as a follow-up message.",
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

const UpdateWorkRecordTool = Tool.make("update_work_record", {
  description:
    "Keep this task's work record up to date: the short, durable state of the work that survives a long chat, a compaction or a restart. Call it when you decide something, find proof, or the list of what is left changes; a few lines each time, not a report. Decisions and evidence are added; outstanding work and the next step are replaced by what you send. If this task is reopened later after a long chat, you start from this record instead of the whole conversation, so write what a colleague would need to carry on. Only for a task you are running (a delegated task, a routine run or a reopened task); never put passwords, tokens or keys in it, and it keeps nothing from a chat that had a site the user marked sensitive open.",
  parameters: UpdateWorkRecordInput,
  success: UpdateWorkRecordResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Update work record")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const NotifyUserTool = Tool.make("notify_user", {
  description:
    "Decide whether the user gets a push notification when THIS routine run or task finishes. Call it once, near the end of the run, with notify true and a one-line message when the result is worth the user's attention (something changed, something needs a decision), or notify false when there is nothing to tell them. A routine set to 'bot decides' notifies only if you called it with notify true; a routine that notifies every run uses your message as the notification text. The last call wins. A run that fails, or that needs the user (a secret, browser help), always notifies whatever you say. Your reply still lands in the chat either way. Only works inside a task or routine run; in a normal chat the user is already notified when you reply, so it does nothing there.",
  parameters: NotifyUserInput,
  success: NotifyUserResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Decide whether to notify the user")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadChatHistoryTool = Tool.make("read_chat_history", {
  description:
    "Read earlier messages of THIS chat, newest first, when you need an exact detail (a command, a message, a number, a result) that is not in your context. A reopened task can start a fresh session with only its work record and the end of the chat, and this is how you reach the rest: search with query, or page back with beforeMessageId (use the messageId of the oldest message you have). Each text is cut at 1,200 characters. It reads messages only: it cannot show tool output (files you read, command results), so run the command or read the file again if you need it. It reads only this chat, never another.",
  parameters: ReadChatHistoryInput,
  success: ReadChatHistoryResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read chat history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListTasksTool = Tool.make("list_tasks", {
  description:
    "List the tasks in your current request's task tree (the root request and everything delegated from it), newest first, optionally only those in one status. Empty when you are not working on a task. A team lead also gets teamTasks: every unfinished task of a bot on its own team from outside that tree, such as work a routine or another chat started. Useful before steer_task or stop_task, to see what is still running; results of delegated tasks arrive on their own, so there is no need to poll.",
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

const StopTaskTool = Tool.make("stop_task", {
  description:
    "Stop a task you delegated that is still running, and optionally hand the same bot a new objective in its place. The bot loses everything it had done: a redirect starts a fresh task from the new objective alone. To narrow, correct or add to the work while keeping its progress, use steer_task instead; stop only when the work itself has been overtaken by events. You can stop tasks in your own request's task tree, and a team lead any unfinished task of a bot on its own team; never your own. Tasks the stopped one delegated stop with it.",
  parameters: StopTaskInput,
  success: StopTaskResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Stop a delegated task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SteerTaskTool = Tool.make("steer_task", {
  description:
    "Send an update into a task that is still unfinished, without restarting it: the bot keeps its context and everything it has done so far. A running task gets it in its live turn now; a queued or waiting task gets it at the start of its next turn (a queued task starts with it as part of its brief). Prefer this over stop_task to narrow, correct or add to the work. The update shows in that bot's chat and on the task (get_task). It also reopens a task that has ended (completed, failed, interrupted or cancelled): the same bot continues in the same chat and session from where it stopped, with your update, and its new result comes back to you like the first one. Reopen when a task stopped short (it was paused or interrupted, ended with a mid-work line, or missed part of the brief) and the same work should carry on; this does not count against the delegation limit, so do not delegate a new task or make a routine for it. Delegate a new task only for genuinely new work. You can steer tasks in your own request's task tree, and a team lead any unfinished task of a bot on its own team, whoever started it; a finished one you can reopen within 24 hours if it was delegated from this chat, or, for a team lead, if its bot is on your team. Never your own task, and not a task of a deleted bot.",
  parameters: SteerTaskInput,
  success: SteerTaskResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Steer or reopen a task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for an API key or token through a secure form. Never use this for website passwords: those are the user's saved logins, filled by use_login. Never ask for secrets in chat and never print one. When the secret is already saved, the result says so and no form is shown. Otherwise end your turn after calling this: you are resumed in a fresh session where the value is the environment variable PB_SECRET_<NAME> for shell commands.",
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

const RequestLoginTool = Tool.make("request_login", {
  description:
    "On a website sign-in page with no saved login, ask the user through an in-chat username/password card. Pass the exact HTTPS origin of your current shared-browser tab, with an optional one-line reason or label. Never ask for a password or username in chat, never type a password, and never use request_secret for website logins. If a saved login matches, use use_login instead. End your turn after requesting the card: the server fills the form itself, saves by default unless the user turns saving off, and resumes you with only filled, cancelled, expired, origin-mismatch or fill-failed plus whether saved. Credentials never reach you. A filled form still needs a known submit button or Enter; then check the result and report in chat whether sign-in worked. Use request_browser_help for CAPTCHA, 2FA/OTP and passkeys.",
  parameters: Schema.Struct({
    origin: TrimmedNonEmptyString,
    reason: Schema.optional(Schema.String),
    label: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    requestId: Schema.String,
    status: Schema.Literal("pending"),
    note: Schema.String,
  }),
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Request a website login")
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

const CallVoteTool = Tool.make("call_vote", {
  description:
    "Put a decision to the group you are talking in, so every member answers it on the record. Only works while you are speaking in a group chat. One vote at a time, and a question the group already settled in this conversation cannot be reopened. Cast your own ballot with cast_vote in this same turn; calling a vote does not buy you an extra turn. The result never acts on its own: the user sees every member's choice and reason and decides whether it happens.",
  parameters: CallVoteInput,
  success: CallVoteResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Call a group vote")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CastVoteTool = Tool.make("cast_vote", {
  description:
    "Answer the open vote in the group you are talking in. One ballot per bot: it is cast once and cannot be changed or withdrawn, so decide before you call this. Give the reason in one line, because the user reads it beside your choice. Only works while you are speaking in a group chat.",
  parameters: CastVoteInput,
  success: CastVoteResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Cast a vote")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  // A second call with the same ballot is refused, not absorbed: "you already
  // voted" is the answer, because pretending otherwise would hide the rail.
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CreateBotTool = Tool.make("create_bot", {
  description: `${LEAD_ONLY} Create a new bot on your own team, always as an ordinary member: never a lead, never pinned, never on another team. It appears in list_bots at once, so you can delegate to it. Give it a clear name, a description and instructions, and pick a model and effort that fit the work (a cheaper model for simple jobs). Only models a provider actually offers are accepted, and never a Fable or Mythos model. The new bot gets no secrets or connections; the user grants those himself. Limited to 5 new bots per rolling 24 hours. Every create is posted in your chat and sent to the user as a notification. Refused unless you are a team lead right now.`,
  parameters: CreateBotInput,
  success: LeadBotResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create a bot on your team")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateBotTool = Tool.make("update_bot", {
  description: `${LEAD_ONLY} Change a bot that is on your own team: its name, title, description, instructions, avatar shape or colour, model and effort, notification mute or memory auto-save. Only the fields you pass change. You cannot edit yourself, another lead or a bot on another team, and you cannot change anyone's team, lead flag or pinned state. ${USER_MADE_RULE} Ask the user before making a large change to the instructions of a bot you created (rewriting them, or changing what the bot may do); small tweaks are fine. Names need at least 3 characters with a letter, one alphabet only, and no invisible characters. A Fable or Mythos bot keeps its model and effort as they are. Every edit is posted in your chat and sent to the user as a notification. Refused unless you are a team lead right now.`,
  parameters: UpdateBotInput,
  success: LeadBotResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Edit a bot on your team")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RemoveBotTool = Tool.make("remove_bot", {
  description: `${LEAD_ONLY} Remove a bot that is on your own team. It is a soft delete: the bot disappears from every list, but its chats and memories are kept and the user can restore it. Ask the user before removing a bot. ${USER_MADE_RULE} Give the reason in one line: it is kept in the record and shown to the user. Refused while the bot has an unfinished task (stop it with stop_task first), a turn in progress or a routine switched on, and for yourself, another lead or a bot on another team. Posted in your chat and sent to the user as a notification. Refused unless you are a team lead right now.`,
  parameters: RemoveBotInput,
  success: LeadBotResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Remove a bot from your team")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const BotsToolkit = Toolkit.make(
  ListBotsTool,
  DelegateTaskTool,
  GetTaskTool,
  UpdateWorkRecordTool,
  NotifyUserTool,
  ReadChatHistoryTool,
  ListTasksTool,
  StopTaskTool,
  SteerTaskTool,
  RequestSecretTool,
  UseLoginTool,
  RequestLoginTool,
  RequestBrowserHelpTool,
  CloseBrowserTool,
  CallVoteTool,
  CastVoteTool,
  CreateBotTool,
  UpdateBotTool,
  RemoveBotTool,
);
