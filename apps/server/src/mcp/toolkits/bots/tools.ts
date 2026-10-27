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

/** Present only while a bot runs on its usage-limit fallback model instead of its own. */
export const BotFallbackEntry = Schema.Struct({
  provider: Schema.String.annotate({ description: "Provider instance the fallback runs on." }),
  model: Schema.String.annotate({ description: "The model the bot's turns use right now." }),
  fromProvider: Schema.String.annotate({ description: "The provider that hit its usage limit." }),
  since: Schema.String.annotate({ description: "When it switched (ISO, UTC)." }),
  resetAt: Schema.optional(
    Schema.String.annotate({
      description: "When the original limit resets (ISO, UTC), if reported.",
    }),
  ),
  reason: Schema.optional(
    Schema.String.annotate({
      description:
        'Absent for a usage limit; "deepseek_peak" for the DeepSeek peak-hours switch; "schedule" while the model schedule of the bot runs.',
    }),
  ),
  label: Schema.String.annotate({
    description:
      'One line to quote, for example "fallback: claude-sonnet-5-5 until 2026-10-08T08:00:40.000Z".',
  }),
});

export const BotEntry = Schema.Struct({
  botId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  provider: Schema.String.annotate({
    description: "Provider instance of the bot's own model (not the fallback).",
  }),
  model: Schema.String.annotate({
    description: "The bot's own model. While `fallback` is present it runs that instead.",
  }),
  isYou: Schema.Boolean.annotate({ description: "True for the bot making this call." }),
  fallback: Schema.optional(BotFallbackEntry),
});
export type BotEntry = typeof BotEntry.Type;

export const ListBotsResult = Schema.Struct({ bots: Schema.Array(BotEntry) });
export type ListBotsResult = typeof ListBotsResult.Type;

export const DelegateTaskInput = Schema.Struct({
  targetBot: TrimmedNonEmptyString.annotate({
    description: "Bot name (as list_bots shows it) or botId.",
  }),
  objective: TrimmedNonEmptyString.annotate({
    description: "What the bot must achieve, stated so it can work without asking you.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Short title. Defaults to the start of the objective.",
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
  continueChatId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A chat id from list_bot_chats. Use it when the work follows up on something this bot discussed with the user in that chat: the task runs as a new turn there, with the earlier conversation in context.",
    }),
  ),
});
export type DelegateTaskInput = typeof DelegateTaskInput.Type;

export const ListBotChatsInput = Schema.Struct({
  bot: TrimmedNonEmptyString.annotate({
    description: "Bot name (as list_bots shows it) or botId.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })).annotate({
      description: "1 to 25. Defaults to 10.",
    }),
  ),
});
export type ListBotChatsInput = typeof ListBotChatsInput.Type;

export const BotChatEntry = Schema.Struct({
  chatId: Schema.String.annotate({ description: "Pass as continueChatId to delegate_task." }),
  title: Schema.String,
  lastActivityAt: Schema.String.annotate({ description: "Time of the last message (ISO, UTC)." }),
  archived: Schema.Boolean.annotate({
    description: "Archived chats can be continued; the turn reopens it.",
  }),
  busy: Schema.Boolean.annotate({
    description: "A turn is running; handed-in work waits until idle.",
  }),
});
export type BotChatEntry = typeof BotChatEntry.Type;

export const ListBotChatsResult = Schema.Struct({
  botId: Schema.String,
  botName: Schema.String,
  /** Newest activity first. */
  chats: Schema.Array(BotChatEntry),
  note: Schema.String,
});
export type ListBotChatsResult = typeof ListBotChatsResult.Type;

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
        "Decisions since your last update, each short and self-contained. Added to the record.",
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
        "Everything still left to do. REPLACES the list: send the whole list (empty means nothing is left).",
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
    description: "true: push-notify the user when this run finishes. false: stay silent.",
  }),
  message: Schema.optional(
    Schema.String.annotate({
      description:
        "With notify true: one plain-text line saying what is worth their attention (e.g. 'Price dropped to 120'), at most about 200 characters; longer is cut. Never put secrets in it. Left out, the task title is shown.",
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
      description: "messageId of the oldest message you have, to page further back.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
      description: "1 to 20. Defaults to 10.",
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
    description: "Why, in one line. Shown in the chat; the stopped bot is not told.",
  }),
  redirectObjective: Schema.optional(
    Schema.String.annotate({
      description:
        "New objective for the same bot. The stopped task is replaced by a fresh one carrying only this text, so make it self-contained.",
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
    description: "A task id from delegate_task, list_tasks or an earlier result.",
  }),
  message: TrimmedNonEmptyString.annotate({
    description:
      "The update for the bot doing the task: what to change, narrow, add or drop, or for a finished task what is left. Arrives as 'Update from <your name>: <message>', so make it stand alone.",
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
      "UPPER_SNAKE name such as GITHUB_TOKEN. A brokered key (default) is used via secret_request with {{secret:NAME}}; you never see the value. If saved as an environment variable it is PB_SECRET_<NAME> in new shell commands.",
  }),
  origins: Schema.optional(
    Schema.Array(Schema.String).check(Schema.isMaxLength(8)).annotate({
      description:
        "HTTPS origin(s) of the API the key is for, e.g. ['https://api.vercel.com']. The user confirms them; a brokered key can only be sent there.",
    }),
  ),
  label: TrimmedNonEmptyString.annotate({
    description: "What the user sees on the form, e.g. 'GitHub personal access token'.",
  }),
  purpose: TrimmedNonEmptyString.annotate({
    description: "One sentence: why you need it and what you will do with it.",
  }),
});

export const RequestSecretResult = Schema.Struct({
  requestId: Schema.String,
  name: Schema.String,
  /** The variable name when the key is saved as an environment variable; brokered keys have none. */
  envVar: Schema.String,
  mode: Schema.optional(Schema.Literals(["brokered", "env"])),
  origins: Schema.optional(Schema.Array(Schema.String)),
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
    description: `One short line on why the user must take over, e.g. 'CAPTCHA on amazon.co.uk'. Cut off past ${BROWSER_HELP_REASON_MAX_LENGTH} characters.`,
  }),
  kind: Schema.optional(
    Schema.Literals(["captcha", "code", "login", "sensitive", "other"]).annotate({
      description:
        "What you need (code means a one-time code). The card wording follows it; omitted, the card shows your reason.",
    }),
  ),
  origin: Schema.optional(
    Schema.String.annotate({
      description: "Origin the user must act on, e.g. https://amazon.co.uk. Omit if unknown.",
    }),
  ),
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
      "The single decision, as one question. Asking the same thing again in this conversation, however reworded, is refused.",
  }),
  options: Schema.Array(
    TrimmedNonEmptyString.annotate({ description: "One answer members can choose." }),
  ).annotate({
    description: `Between ${PERSONAL_GROUP_VOTE_MIN_OPTIONS} and ${PERSONAL_GROUP_VOTE_MAX_OPTIONS} distinct answers. Name a bot ("@Dev writes it") to say who would carry it out.`,
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
    description: "The open vote's id, from call_vote or the group chat.",
  }),
  option: TrimmedNonEmptyString.annotate({
    description: "Exactly one of that vote's options.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "One line why. The user sees it beside your choice.",
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
  "A bot you created is yours to manage while it stays on your team. For any other bot (user-made, another lead's, or moved since), removing it or changing its name, instructions, description, model, effort, fallback or schedule posts a Yes/No card in this chat and nothing changes until Harout taps Yes. The call returns pending: tell him in one line what you asked for and end your turn; his answer arrives as a follow-up message. Only from a chat turn Harout started (routine, task and group turns are refused: ask him to request it in chat). Title, avatar, mute and memory auto-save stay open. Built-in system bots (Updates, Sync reports, seeded defaults) are never yours to change.";

/** The fields create_bot and update_bot share. Every one is optional. */
const BotFieldsShape = {
  title: Schema.optional(
    Schema.String.annotate({
      description: "Short role label under the name, at most 60 characters.",
    }),
  ),
  description: Schema.optional(
    Schema.String.annotate({
      description: "What the bot is for, at most 500 characters.",
    }),
  ),
  instructions: Schema.optional(
    Schema.String.annotate({
      description:
        "Standing instructions, at most 20000 characters. Never put a secret, key or password in them.",
    }),
  ),
  avatarShape: Schema.optional(BotAvatarShape.annotate({ description: "Avatar shape." })),
  avatarColor: Schema.optional(
    BotAvatarColor.annotate({ description: "Avatar colour as a hex value such as #1A73E8." }),
  ),
  provider: Schema.optional(
    Schema.String.annotate({
      description:
        "Provider instance, as list_bots shows. Default: the bot's current one, or yours for a new bot.",
    }),
  ),
  model: Schema.optional(
    Schema.String.annotate({
      description:
        "A model slug that provider offers, e.g. claude-sonnet-5-5. Fable and Mythos are refused. New bot default: Opus 5.5, medium effort.",
    }),
  ),
  effort: Schema.optional(
    Schema.String.annotate({
      description: "An effort the model offers.",
    }),
  ),
  notificationsMute: Schema.optional(
    PersonalBotNotificationMute.annotate({
      description: '"indefinitely", { "forMinutes": n }, or "on" to unmute.',
    }),
  ),
  memoryAutoSave: Schema.optional(
    Schema.Boolean.annotate({
      description: "Let the bot save memories unasked.",
    }),
  ),
  fallbackEnabled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Switch to the fallback model on a usage limit (default on). false: the bot waits for the reset.",
    }),
  ),
  fallbackModel: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(
        Schema.String.annotate({
          description:
            "Fallback provider instance, as list_bots shows. Default: current (Claude for a new bot).",
        }),
      ),
      model: Schema.optional(
        Schema.String.annotate({
          description:
            "A model slug that provider offers. Fable and Mythos are refused. Default: current (new bot: Sonnet 5.5).",
        }),
      ),
      effort: Schema.optional(
        Schema.String.annotate({
          description: "An effort the fallback model offers.",
        }),
      ),
      context: Schema.optional(
        Schema.String.annotate({
          description: 'A context window the model offers, e.g. "1m". Only some offer a choice.',
        }),
      ),
    }).annotate({
      description:
        "Model used on a usage limit. Omitted fields stay as they are (new bot: Sonnet 5.5, high effort, 1M context).",
    }),
  ),
  scheduleEnabled: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run a different model daily between scheduleFrom and scheduleTo, the bot's own model otherwise. false turns it off, keeping times and model. A usage-limit fallback takes priority. On when you give scheduleFrom and scheduleTo.",
    }),
  ),
  scheduleFrom: Schema.optional(
    Schema.String.annotate({
      description:
        'Start, 24 hour "HH:MM" local time on the laptop, e.g. "22:00". Overnight ranges are fine; From and To cannot be equal.',
    }),
  ),
  scheduleTo: Schema.optional(
    Schema.String.annotate({
      description: 'End, 24 hour "HH:MM".',
    }),
  ),
  scheduleModel: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(
        Schema.String.annotate({
          description:
            "Scheduled provider instance, as list_bots shows. Default: current (Claude for a new schedule).",
        }),
      ),
      model: Schema.optional(
        Schema.String.annotate({
          description:
            "A model slug that provider offers. Fable and Mythos are refused; must differ from the bot's own model. Default: current (new schedule: Sonnet 5.5).",
        }),
      ),
      effort: Schema.optional(
        Schema.String.annotate({
          description: "An effort the scheduled model offers.",
        }),
      ),
      context: Schema.optional(
        Schema.String.annotate({
          description: 'A context window the model offers, e.g. "1m". Only some offer a choice.',
        }),
      ),
    }).annotate({
      description:
        "Model used between scheduleFrom and scheduleTo. Omitted fields stay as they are (new schedule: Sonnet 5.5, high effort, 1M context).",
    }),
  ),
  team: Schema.optional(Schema.Unknown.annotate({ description: NOT_SETTABLE })),
  lead: Schema.optional(Schema.Unknown.annotate({ description: NOT_SETTABLE })),
  pinned: Schema.optional(Schema.Unknown.annotate({ description: NOT_SETTABLE })),
};

export const CreateBotInput = Schema.Struct({
  name: TrimmedNonEmptyString.annotate({
    description: "At most 60 characters. Unique among all bots.",
  }),
  ...BotFieldsShape,
});
export type CreateBotInput = typeof CreateBotInput.Type;

export const UpdateBotInput = Schema.Struct({
  bot: TrimmedNonEmptyString.annotate({
    description: "botId or name, as list_bots shows.",
  }),
  name: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "A new name, at most 60 characters." }),
  ),
  ...BotFieldsShape,
});
export type UpdateBotInput = typeof UpdateBotInput.Type;

export const RemoveBotInput = Schema.Struct({
  bot: TrimmedNonEmptyString.annotate({
    description: "botId or name, as list_bots shows.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "Why, in one line. Shown to the user and kept in the audit record.",
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
      "True when nothing changed yet: Harout has a Yes/No card to answer. Do not retry; his answer arrives later.",
  }),
  note: Schema.String,
});
export type LeadBotResult = typeof LeadBotResult.Type;

const ListBotsTool = Tool.make("list_bots", {
  description:
    "List the bots on your team that you can delegate to: name, purpose, provider and model, a fallback entry while a usage limit has it on its fallback model (what runs now, and until when), and which entry is you. Bots on the other team are left out; delegate_task accepts one only once the user's own latest message names it. The roster changes at any time, so call this fresh before every delegate_task.",
  success: ListBotsResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List bots")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListBotChatsTool = Tool.make("list_bot_chats", {
  description:
    "List recent direct chats between the user and one bot you can delegate to: chat id, title, last activity, archived, busy. Call it before delegate_task when the work follows up on something that bot discussed with the user, then pass the chat id as continueChatId. Group, task, routine and deleted chats are left out. Same reach as delegate_task: a bot on your team, or on the other team only once the user's own latest message names it; never yourself. Titles and times only, never message text.",
  parameters: ListBotChatsInput,
  success: ListBotChatsResult,
  failure: BotsToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List a bot's chats")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Hand a self-contained piece of work to another bot on your team. The bot starts with only what you pass here, so put what it needs in objective, context, constraints, acceptanceCriteria and expectedOutput. When the work follows up on something that bot discussed with the user in one of its chats, prefer continuing that chat: find it with list_bot_chats and pass its id as continueChatId. The task then runs as a new turn there with the earlier conversation in context; your brief shows as coming from you, not the user. It starts once the chat is idle; an archived chat reopens. Refused for another bot's chat, group, task, routine and deleted chats. It runs in the background and the result arrives as a follow-up message, so end your turn after delegating. steer_task, stop_task and get_task work on it. Repeating the same bot and objective in the same request returns the existing task. Refused for: a bot on the other team unless the user's own latest message names it; a bot already working above you on this request (handing back to the bot that took the original request is allowed); more than two levels of delegation. No cap on tasks per request; only five turns run at once and the rest queue.",
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
    "Read one task in your current request's task tree (this request and everything delegated from it): status, result summary or error, direct children and the updates sent with steer_task. A running task whose bot has replied and is only waiting on background work shows that reply in resultSummary with waitingOnBackgroundSince set; it is not the final result. A team lead can also read any unfinished task of a bot on its own team, whoever started it. You can also read a finished task that steer_task could reopen (ended within 24 hours and delegated from this chat, or, for a team lead, a bot on your team); its workRecord shows where it stood, so read it before you steer. Any other id reads as not found. You do not need this to collect results: they arrive as a follow-up message.",
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
    "Keep this task's work record up to date: the short, durable state that survives a long chat, compaction or restart. Call it when you decide something, find proof, or what is left changes; a few lines, not a report. Decisions and evidence are added; outstanding work and the next step are replaced. A reopened task starts from this record, so write what a colleague would need to carry on. Only for a task you are running (delegated, routine run or reopened); never put passwords, tokens or keys in it. It keeps nothing from a chat that had a site the user marked sensitive open.",
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
    "Decide whether the user gets a push notification when THIS routine run or task finishes. Call it once, near the end, with notify true and a one-line message when the result deserves attention (something changed or needs a decision), or notify false when there is nothing to tell. A routine set to 'bot decides' notifies only if you called it with notify true; one that notifies every run uses your message as the text. The last call wins. A failed run, or one that needs the user (a secret, browser help), always notifies. Your reply lands in the chat either way. Only works inside a task or routine run; in a normal chat it does nothing.",
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
    "Read earlier messages of THIS chat, newest first, when you need an exact detail (a command, number or result) not in your context. Search with query, or page back with beforeMessageId. Each text is cut at 1,200 characters. Messages only: no tool output, so rerun the command or reread the file if needed. Only this chat, never another.",
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
    "List the tasks in your current request's task tree, newest first, optionally one status. Empty when you are not working on a task. A team lead also gets teamTasks: unfinished tasks of its team's bots from outside that tree (routines, other chats). Use before steer_task or stop_task. Results arrive on their own, so do not poll.",
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
    "Stop a delegated task that is still running, optionally giving the same bot a new objective in its place. The bot loses all progress; a redirect starts fresh from the new objective alone. To narrow, correct or add to the work while keeping progress, use steer_task; stop only when events have overtaken the work. You can stop tasks in your own request's task tree, and a team lead any unfinished task of a bot on its own team; never your own. Its sub-tasks stop with it.",
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
    "Send an update into an unfinished task without restarting it: the bot keeps its context and progress. A running task gets it in its live turn now; a queued or waiting task at the start of its next turn. It shows in that bot's chat and on the task. Prefer this over stop_task to narrow, correct or add to the work. It also reopens an ended task (completed, failed, interrupted or cancelled): the same bot continues in the same chat and session with your update, and the new result comes back to you. Reopen when a task stopped short (paused, interrupted, ended mid-work, or missed part of the brief) and the same work should carry on; do not delegate a new task or make a routine for that. Delegate a new task only for genuinely new work. You can steer tasks in your own request's task tree, and a team lead any unfinished task of a bot on its own team; an ended one can be reopened within 24 hours if it was delegated from this chat, or, for a team lead, if its bot is on your team. Never your own task, and not a deleted bot's.",
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
    "Ask the user for an API key or token through a secure form. Never use this for website passwords: those are saved logins, filled by use_login. Never ask for secrets in chat and never print one. If the secret is already saved, the result says so and no form is shown. Pass origins (the API's HTTPS origin) so the user can confirm where the key may be sent. Otherwise end your turn after calling this; you resume in a fresh session. A brokered key (default) is used only through secret_request with a {{secret:NAME}} placeholder; if saved as an environment variable the result says so (PB_SECRET_<NAME> in shell commands).",
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
    "Fill a saved website login. Pass the login label or exact origin. Any bot may use any saved login, but only while your current tab is already on that exact origin. The server opens a fresh tab there, fills the username and password and closes your tab on that origin. You never receive the password; never type or paste one yourself. Your next browser call lands on the new tab, so submit with a known button or Enter; reads stay disabled on that tab, and the fill is refused on any origin where preview_evaluate has been used. If the site then asks for 2FA or a one-time code, call request_browser_help.",
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
    "On a sign-in page with no saved login, ask the user through an in-chat username/password card. Pass the exact HTTPS origin of your current shared-browser tab, with an optional one-line reason or label. Never ask for a password or username in chat, never type a password, and never use request_secret for website logins. If a saved login matches, use use_login. End your turn after requesting the card: the server fills the form (saving by default unless the user turns it off) and resumes you with only filled, cancelled, expired, origin-mismatch or fill-failed, plus whether saved. Credentials never reach you. A filled form still needs a known submit button or Enter; then check and report in chat whether sign-in worked. Use request_browser_help for CAPTCHA, 2FA/OTP and passkeys.",
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
    "Close the shared browser when done or when the user asks. Every tab closes and the session ends, so do this only when no more browsing is expected; the next browser tool call restarts it. Refused while the user controls the browser. Closing a closed browser is harmless.",
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
    "Ask the user to take over the shared browser when a CAPTCHA, human-verification check, login, 2FA or one-time-code prompt blocks you, or when an action was paused because it could carry data from a site the user marked sensitive to another site. Give one short reason, tell the user what you need in one sentence, then end your turn. Never try to solve a CAPTCHA yourself.",
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
    "Put a decision to the group you are in, so every member answers on the record. Only works in a group chat. One vote at a time; a question already settled in this conversation cannot be reopened. Cast your own ballot with cast_vote in this same turn. The result never acts on its own: the user sees every choice and reason and decides.",
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
    "Answer the open vote in your group. One ballot per bot, final: it cannot be changed or withdrawn. Give the reason in one line. Only works in a group chat.",
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
  description: `${LEAD_ONLY} Create a new bot on your own team, always as an ordinary member: never a lead, never pinned, never on another team. It appears in list_bots at once, so you can delegate to it. Give it a clear name, description and instructions, and a model and effort that fit the work (cheaper for simple jobs). It falls back to Sonnet 5.5, high effort, 1M context on a usage limit unless you set fallbackEnabled or fallbackModel, and can run another model at set daily times (scheduleFrom, scheduleTo, scheduleModel). Only models a provider offers are accepted, never Fable or Mythos. The new bot gets no secrets or connections; the user grants those. Limit 5 new bots per rolling 24 hours. Each create is posted in your chat and notified to the user. Refused unless you are a team lead right now.`,
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
  description: `${LEAD_ONLY} Change a bot on your own team (name, title, description, instructions, avatar, model, effort, fallback, daily model schedule, notification mute, memory auto-save). Only the fields you pass change. You cannot edit yourself, another lead or a bot on another team, or anyone's team, lead flag or pinned state. ${USER_MADE_RULE} Ask the user before a large change to the instructions of a bot you created (rewriting them, or changing what it may do); small tweaks are fine. Names need at least 3 characters with a letter, one alphabet only, no invisible characters. A Fable or Mythos bot keeps its model and effort. Each edit is posted in your chat and notified to the user. Refused unless you are a team lead right now.`,
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
  description: `${LEAD_ONLY} Remove a bot on your own team. Soft delete: it leaves every list, but chats and memories are kept and the user can restore it. Ask the user before removing a bot. ${USER_MADE_RULE} Give the reason in one line. Refused while the bot has an unfinished task (stop_task it first), a turn in progress or a routine switched on, and for yourself, another lead or a bot on another team. Posted in your chat and notified to the user. Refused unless you are a team lead right now.`,
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
  ListBotChatsTool,
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
