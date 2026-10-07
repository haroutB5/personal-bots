import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ModelSelection, OrchestrationMessageRole } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Driver kinds whose adapter actually carries a personal bot's persona to
 * the model, i.e. the adapters that pass `systemInstructions` through
 * `withBotInstructions`. On every other driver the bot's name, its
 * instructions and the app rules from `personalBotInstructions` are dropped
 * before the prompt leaves the server, and the user gets the bare model
 * answering with no sign that anything is missing.
 *
 * This is an allowlist on purpose. `ProviderDriverKind` is an open slug (a
 * fork or a future upstream provider can introduce one this build has never
 * heard of), so anything not listed here is treated as not carrying
 * instructions and is kept out of the bot form and out of seeding.
 *
 * Do not hand-edit this to add a driver. Wire the adapter to
 * `withBotInstructions` first; `botInstructionCoverage.test.ts` in the
 * server reads the adapter sources and fails if this list and the code
 * disagree in either direction.
 */
export const BOT_INSTRUCTION_DRIVER_KINDS: ReadonlyArray<ProviderDriverKind> = [
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("opencode"),
];

/**
 * Whether a bot running on this driver kind will actually be given its
 * persona. Unknown slugs answer `false` — fail closed.
 */
export function driverCarriesBotInstructions(driver: string): boolean {
  return (BOT_INSTRUCTION_DRIVER_KINDS as ReadonlyArray<string>).includes(driver);
}

export const PersonalBotId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalBotId"));
export type PersonalBotId = typeof PersonalBotId.Type;

export const BotAvatarShape = Schema.Literals([
  "blob",
  "roundedSquare",
  "pill",
  "triangle",
  "roundedHexagon",
  "scallopedCloud",
  "droplet",
]);
export type BotAvatarShape = typeof BotAvatarShape.Type;

export const BotAvatarColor = Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/));
export type BotAvatarColor = typeof BotAvatarColor.Type;

/** Short role label shown under the bot's name, e.g. "Personal assistant". */
export const PersonalBotTitle = Schema.String.check(Schema.isMaxLength(60));

/**
 * Built-in team IDs or custom team names. Every bot is on exactly one, and one bot per team is its
 * lead. Delegation is scoped to the caller's own team (see the bots toolkit).
 */
export const PersonalBotTeam = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
export type PersonalBotTeam = typeof PersonalBotTeam.Type;

/** Team names as the user reads them, on the Team screen and in refusals. */
export const PERSONAL_BOT_TEAM_LABELS: Readonly<Record<PersonalBotTeam, string>> = {
  dev: "Dev team",
  assistant: "Assistant's team",
};

/** Built-in teams precede custom teams in presentation order. */
export const PERSONAL_BOT_TEAM_ORDER: ReadonlyArray<PersonalBotTeam> = ["dev", "assistant"];

export const personalBotTeamLabel = (team: PersonalBotTeam): string =>
  Object.hasOwn(PERSONAL_BOT_TEAM_LABELS, team) ? PERSONAL_BOT_TEAM_LABELS[team]! : team;

export const personalBotTeams = (
  teams: ReadonlyArray<PersonalBotTeam>,
): ReadonlyArray<PersonalBotTeam> => [...new Set([...PERSONAL_BOT_TEAM_ORDER, ...teams])];

/** New bots join the assistant's team as an ordinary member. */
export const DEFAULT_PERSONAL_BOT_TEAM: PersonalBotTeam = "assistant";

/**
 * The model a bot switches to when its provider reports a usage limit (1.65.0).
 * Default for every bot: Claude Sonnet 5.5, effort high, 1M context window.
 */
export const PERSONAL_BOT_DEFAULT_FALLBACK_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-5-5",
  options: [
    { id: "effort", value: "high" },
    { id: "contextWindow", value: "1m" },
  ],
};

export const PersonalBotFallback = Schema.Struct({
  /** On for every bot unless the owner turns it off in the bot form. */
  enabled: Schema.Boolean,
  modelSelection: ModelSelection,
});
export type PersonalBotFallback = typeof PersonalBotFallback.Type;

/**
 * Present only while the bot runs on its fallback model because its home
 * provider hit a usage limit. `PersonalBot.modelSelection` stays the home
 * model (what the owner saved); this is what the bot's turns use right now.
 */
export const PersonalBotFallbackActive = Schema.Struct({
  modelSelection: ModelSelection,
  since: Schema.DateTimeUtcFromString,
  /** When the original limit resets, when the provider said; absent means it is re-checked. */
  resetAt: Schema.optional(Schema.DateTimeUtcFromString),
  /** The provider that hit its limit, as the owner knows it: "Codex", "Claude". */
  fromProvider: Schema.String,
});
export type PersonalBotFallbackActive = typeof PersonalBotFallbackActive.Type;

/** What a create or update may set; absent fields stay as they are. */
export const PersonalBotFallbackInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
});
export type PersonalBotFallbackInput = typeof PersonalBotFallbackInput.Type;

export const PersonalBot = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  /** Empty string means "no title"; the UI then omits it. */
  title: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: ModelSelection,
  enabled: Schema.Boolean,
  sortOrder: Schema.Number,
  /**
   * Team membership, lead flag and the Chats pin. Optional on the wire only so
   * a client that updated before the server still decodes an older
   * `personalBots.list`; the server always sends all three. Read them through
   * {@link botTeam}, {@link isTeamLead} and {@link isBotPinned} rather than
   * directly, so the fallback lives in one place.
   */
  team: Schema.optionalKey(PersonalBotTeam),
  lead: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
  /**
   * Standing permission to save memories without the user asking each time:
   * save_memory then skips its explicit-ask check for this bot. Optional on the
   * wire for the same reason as the team fields; read it through
   * {@link savesMemoryWithoutAsking}.
   */
  memoryAutoSave: Schema.optionalKey(Schema.Boolean),
  /**
   * The owner's privacy switch: this bot's message text is not previewed
   * anywhere outside its own chat (Bots list, pinned strip, chat list, Team,
   * task cards, push and banners show a neutral line instead). Optional on the
   * wire like the fields above; read it through {@link hidesBotPreviews}.
   */
  hidePreviews: Schema.optionalKey(Schema.Boolean),
  /**
   * The usage-limit fallback setting (always sent by the server; optional on
   * the wire like the fields above). Read it through {@link botFallback}.
   */
  fallback: Schema.optionalKey(PersonalBotFallback),
  /** Set only while the bot runs on its fallback. Read it through {@link botFallbackActive}. */
  fallbackActive: Schema.optionalKey(PersonalBotFallbackActive),
  /**
   * Notifications from this bot are silenced until this time: no web push and
   * no in-app banner. Null (or absent, from an older server) means on; a time
   * in the year 9999 means "until I turn it back on". Read it through
   * {@link botNotificationsMutedUntil}, which also treats a past time as on.
   */
  notificationsMutedUntil: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString)),
  /**
   * The live groups (not archived, not deleted) this bot is a member of.
   * Derived by `personalBots.list` on every call, never stored, so it cannot
   * drift; absent from every other payload.
   */
  groupIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * In at least one live group and no private chat of its own (a group's
   * relay thread and an empty, never-written chat do not count). The Chats
   * list, the pinned strip and the Team chart leave such a bot out; its
   * groups' settings are where the owner reaches it. Derived like `groupIds`;
   * read it through {@link isGroupOnlyBot}.
   */
  groupOnly: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalBot = typeof PersonalBot.Type;

/** The bot's fallback setting, the default when an older server did not send one. */
export const botFallback = (bot: {
  readonly fallback?: PersonalBotFallback;
}): PersonalBotFallback =>
  bot.fallback ?? { enabled: true, modelSelection: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL };

/** The fallback the bot is running on right now, or null on its own model. */
export const botFallbackActive = (bot: {
  readonly fallbackActive?: PersonalBotFallbackActive;
}): PersonalBotFallbackActive | null => bot.fallbackActive ?? null;

/**
 * The model the bot's turns use right now: its fallback while one is active,
 * else the model the owner saved.
 */
export const botEffectiveModelSelection = (bot: {
  readonly modelSelection: ModelSelection;
  readonly fallbackActive?: PersonalBotFallbackActive;
}): ModelSelection => bot.fallbackActive?.modelSelection ?? bot.modelSelection;

/** Lives only inside groups: hidden from the main lists (see `PersonalBot.groupOnly`). */
export const isGroupOnlyBot = (bot: { readonly groupOnly?: boolean }): boolean =>
  bot.groupOnly === true;

/** The bot's team; a bot from a server too old to have teams reads as a member of the assistant's. */
export const botTeam = (bot: { readonly team?: PersonalBotTeam }): PersonalBotTeam =>
  bot.team ?? DEFAULT_PERSONAL_BOT_TEAM;

/**
 * Whether two team names name the same team. Custom teams are registered
 * case-insensitively (`setProfile` refuses a second "research" once
 * "Research" exists), so membership has to be read the same way or a bot
 * whose stored team differs only in case looks like it is on a team nobody
 * registered. Stored strings keep whatever case they were written with.
 */
export const sameTeam = (left: PersonalBotTeam, right: PersonalBotTeam): boolean =>
  left.toLowerCase() === right.toLowerCase();

/** {@link sameTeam} applied to a bot's team, including the missing-team default. */
export const isBotOnTeam = (
  bot: { readonly team?: PersonalBotTeam },
  team: PersonalBotTeam,
): boolean => sameTeam(botTeam(bot), team);

export const isTeamLead = (bot: { readonly lead?: boolean }): boolean => bot.lead === true;

export const isBotPinned = (bot: { readonly pinned?: boolean }): boolean => bot.pinned === true;

export const savesMemoryWithoutAsking = (bot: { readonly memoryAutoSave?: boolean }): boolean =>
  bot.memoryAutoSave === true;

export const hidesBotPreviews = (bot: { readonly hidePreviews?: boolean }): boolean =>
  bot.hidePreviews === true;

/** What "until I turn it back on" is stored as: a time no timed mute reaches. */
export const PERSONAL_BOT_MUTED_INDEFINITELY_ISO = "9999-12-31T23:59:59.000Z";
/** Any mute ending at or after this is shown as indefinite. */
const INDEFINITE_MUTE_FROM_MS = Date.UTC(9000, 0, 1);
/** The longest timed mute a caller may ask for: one week. */
export const PERSONAL_BOT_MUTE_MAX_MINUTES = 7 * 24 * 60;

/**
 * How a caller changes a bot's notifications. The server turns it into an
 * absolute time from its own clock, so a phone with a skewed clock still gets
 * the hour it asked for:
 *  - "on": notifications on again;
 *  - "indefinitely": muted until turned back on;
 *  - `{ forMinutes }`: muted for that long, then on again by itself.
 */
export const PersonalBotNotificationMute = Schema.Union([
  Schema.Literals(["on", "indefinitely"]),
  Schema.Struct({
    forMinutes: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: PERSONAL_BOT_MUTE_MAX_MINUTES }),
    ),
  }),
]);
export type PersonalBotNotificationMute = typeof PersonalBotNotificationMute.Type;

/**
 * When this bot's notifications come back on, in epoch millis, or null when
 * they are on now. A mute that has run out is on: nothing has to clear it.
 * Accepts the decoded DateTime or an ISO string (the stored form).
 */
export const botNotificationsMutedUntil = (
  bot: { readonly notificationsMutedUntil?: DateTime.Utc | string | null | undefined },
  nowMs: number,
): number | null => {
  const until = bot.notificationsMutedUntil;
  if (until === undefined || until === null) return null;
  const ms = typeof until === "string" ? Date.parse(until) : DateTime.toEpochMillis(until);
  return Number.isFinite(ms) && ms > nowMs ? ms : null;
};

/** Whether a mute that ends at `untilMs` is the "until I turn it back on" kind. */
export const isIndefiniteMute = (untilMs: number): boolean => untilMs >= INDEFINITE_MUTE_FROM_MS;

/**
 * The newest user/assistant message of a linked thread, for the chats list
 * preview. Text is capped server-side; `context` lets the client recognise
 * turns the task service wrote.
 */
export const PersonalBotThreadNewestMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  context: Schema.optional(OrchestrationMessageContext),
  /**
   * True when the owner hid this bot's previews: `text` is then empty and
   * `context` is left out on the server, and the list shows a neutral line.
   */
  hidden: Schema.optional(Schema.Boolean),
});
export type PersonalBotThreadNewestMessage = typeof PersonalBotThreadNewestMessage.Type;

export const PersonalBotThread = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /**
   * Only on an unarchive result, and only when the chat's name was taken by
   * another open chat meanwhile: the name it was given (the old one plus a
   * number), so the owner can be told.
   */
  renamedTo: Schema.optional(Schema.String),
  /** Only on `personalBots.list`; absent on create/archive results. */
  newestMessage: Schema.optional(Schema.NullOr(PersonalBotThreadNewestMessage)),
  /**
   * Only on `personalBots.list`: when the chat last had a message (else when
   * it was made). What chat lists order by, never the thread's updatedAt,
   * which any metadata write moves (auto-settle, a session stop, a rename).
   */
  lastActivityAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  /**
   * Only on `personalBots.list`, and only when true: the thread is a group
   * member's relay (the bot's private thread a group talks through), which
   * no bot chat list shows. Sent with the list so clients can hide relays
   * from the first paint, without waiting for the groups.
   */
  groupRelay: Schema.optional(Schema.Boolean),
  /**
   * Only on `personalBots.list`, and only when true: the bot replied after
   * the owner last had the chat open (`last_viewed_at`). Never on an archived
   * chat or a group relay. `lastReplyAt` (that reply's time) rides with it so
   * a client that has since opened the chat can clear it before a refetch.
   */
  unread: Schema.optional(Schema.Boolean),
  lastReplyAt: Schema.optional(Schema.DateTimeUtcFromString),
  /**
   * Only on `personalBots.list`, and only when true: the chat is unread because
   * the owner marked it unread, or because a snooze ran out, not (only) because
   * the bot replied. It shows for every bot, not just the ones that show unread
   * chats. `lastReplyAt` then carries the time the mark or the wake happened
   * when that is later than the bot's last reply.
   */
  markedUnread: Schema.optional(Schema.Boolean),
  /** Only on `personalBots.list`, and only when pinned: when the owner pinned the chat. */
  pinnedAt: Schema.optional(Schema.DateTimeUtcFromString),
  /**
   * Only on `personalBots.list`, and only while snoozed: when the chat wakes.
   * A snooze that has run out is not sent; the chat comes back as unread with
   * the wake time as `lastReplyAt`.
   */
  snoozedUntil: Schema.optional(Schema.DateTimeUtcFromString),
});
export type PersonalBotThread = typeof PersonalBotThread.Type;

export const PersonalBotCreateInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  title: Schema.optional(PersonalBotTitle),
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: ModelSelection,
  /** Omitted means the assistant's team, not a lead, not pinned. */
  team: Schema.optional(PersonalBotTeam),
  lead: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
  /** Omitted means off: save_memory needs the user's explicit ask. */
  memoryAutoSave: Schema.optional(Schema.Boolean),
  /** Omitted means on, with the default fallback model. */
  fallback: Schema.optional(PersonalBotFallbackInput),
});
export type PersonalBotCreateInput = typeof PersonalBotCreateInput.Type;

export const PersonalBotUpdateInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.optional(Schema.String),
  title: Schema.optional(PersonalBotTitle),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  avatarShape: Schema.optional(BotAvatarShape),
  avatarColor: Schema.optional(BotAvatarColor),
  modelSelection: Schema.optional(ModelSelection),
  enabled: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(Schema.Number),
  team: Schema.optional(PersonalBotTeam),
  /** Setting this true clears the lead flag on the team's previous lead. */
  lead: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
  memoryAutoSave: Schema.optional(Schema.Boolean),
  /** Absent leaves it alone. */
  hidePreviews: Schema.optional(Schema.Boolean),
  /** Absent leaves it alone; a field inside it left out stays as it is. */
  fallback: Schema.optional(PersonalBotFallbackInput),
  notificationsMute: Schema.optional(PersonalBotNotificationMute),
});
export type PersonalBotUpdateInput = typeof PersonalBotUpdateInput.Type;

export const PersonalBotDeleteInput = Schema.Struct({
  botId: PersonalBotId,
});
export type PersonalBotDeleteInput = typeof PersonalBotDeleteInput.Type;

/** The `code` a refused duplicate chat name carries on `PersonalBotsError` and the dispatch error. */
export const CHAT_NAME_TAKEN_CODE = "chat_name_taken" as const;

/** What the owner reads when a typed chat name is already used by another open chat of the bot. */
export const chatNameTakenMessage = (name: string): string =>
  `A chat called "${name}" already exists`;

/**
 * Two chat names are the same name when they match after trimming, collapsing
 * inner whitespace and ignoring case. The server and the clients compare with
 * this one function.
 */
export const normalizeChatName = (name: string): string =>
  name.replace(/\s+/g, " ").trim().toLowerCase();

export const PersonalBotCreateThreadInput = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  /**
   * A name the owner typed. Refused with `code: "chat_name_taken"` when another
   * open chat of this bot already has it; the chat is then not created. Absent
   * keeps the placeholder title until the first message names the chat.
   */
  title: Schema.optional(Schema.String),
});
export type PersonalBotCreateThreadInput = typeof PersonalBotCreateThreadInput.Type;

export const PersonalBotArchiveThreadInput = Schema.Struct({
  threadId: ThreadId,
  archived: Schema.Boolean,
});
export type PersonalBotArchiveThreadInput = typeof PersonalBotArchiveThreadInput.Type;

/** Permanently deletes exactly one linked chat (the thread plus its link row). */
export const PersonalBotDeleteThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type PersonalBotDeleteThreadInput = typeof PersonalBotDeleteThreadInput.Type;

/** The most chats one bulk archive or delete takes; a bot's whole list fits. */
export const PERSONAL_BOT_THREADS_BATCH_MAX = 500;

const PersonalBotThreadIdBatch = Schema.Array(ThreadId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PERSONAL_BOT_THREADS_BATCH_MAX),
);

/** Archives or unarchives several chats, one at a time, each exactly as `archiveThread` would. */
export const PersonalBotArchiveThreadsInput = Schema.Struct({
  threadIds: PersonalBotThreadIdBatch,
  archived: Schema.Boolean,
});
export type PersonalBotArchiveThreadsInput = typeof PersonalBotArchiveThreadsInput.Type;

/** Deletes several chats, one at a time, each exactly as `deleteThread` would. */
export const PersonalBotDeleteThreadsInput = Schema.Struct({
  threadIds: PersonalBotThreadIdBatch,
});
export type PersonalBotDeleteThreadsInput = typeof PersonalBotDeleteThreadsInput.Type;

/**
 * Pin, snooze or mark unread on several chats (one is a batch of one), each
 * exactly as it would be on its own. Omitted fields are left alone.
 * - `pinned`: pin or unpin.
 * - `snoozedUntil`: a time in the future snoozes, null wakes the chat now (it
 *   comes back as unread at the top).
 * - `markUnread`: true marks them unread until the owner opens them again.
 * Chats that are archived or group relays are refused (reported in `failed`).
 */
export const PersonalBotUpdateThreadsInput = Schema.Struct({
  threadIds: PersonalBotThreadIdBatch,
  pinned: Schema.optional(Schema.Boolean),
  snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  markUnread: Schema.optional(Schema.Boolean),
});
export type PersonalBotUpdateThreadsInput = typeof PersonalBotUpdateThreadsInput.Type;

/** The most message hits one search returns. */
export const PERSONAL_MESSAGE_SEARCH_MAX_RESULTS = 40;
export const PERSONAL_MESSAGE_SEARCH_MIN_QUERY_CHARS = 2;
export const PERSONAL_MESSAGE_SEARCH_MAX_QUERY_CHARS = 100;

/**
 * Search inside chat messages (what the owner and the bots said, never the
 * reasoning trace, tool output or system rows). Newest hits first, one hit per
 * chat, at most `limit` (default and ceiling `PERSONAL_MESSAGE_SEARCH_MAX_RESULTS`).
 */
export const PersonalBotSearchMessagesInput = Schema.Struct({
  query: Schema.String.check(
    Schema.isMinLength(PERSONAL_MESSAGE_SEARCH_MIN_QUERY_CHARS),
    Schema.isMaxLength(PERSONAL_MESSAGE_SEARCH_MAX_QUERY_CHARS),
  ),
  limit: Schema.optional(Schema.Number),
});
export type PersonalBotSearchMessagesInput = typeof PersonalBotSearchMessagesInput.Type;

export const PersonalBotSearchMessageHit = Schema.Struct({
  threadId: ThreadId,
  /** The bot the chat belongs to; null for a group chat. */
  botId: Schema.NullOr(PersonalBotId),
  /** Set when the chat is a group's shared chat. */
  groupId: Schema.NullOr(Schema.String),
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  /** About 140 characters of the message around the match, one line, ellipsised at a cut end. */
  snippet: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  /** The chat is archived (a hit in an archived chat is tagged by the list). */
  archived: Schema.Boolean,
  /** Hits in this chat beyond the one shown. */
  moreInChat: Schema.Number,
});
export type PersonalBotSearchMessageHit = typeof PersonalBotSearchMessageHit.Type;

export const PersonalBotSearchMessagesResult = Schema.Struct({
  hits: Schema.Array(PersonalBotSearchMessageHit),
  /** The search stopped at the cap: there may be more chats that match. */
  capped: Schema.Boolean,
});
export type PersonalBotSearchMessagesResult = typeof PersonalBotSearchMessagesResult.Type;

/**
 * What a bulk archive or delete did: the chats it changed, and the ones it
 * could not, each with the reason a single action would have shown.
 */
export const PersonalBotThreadsBatchResult = Schema.Struct({
  done: Schema.Array(ThreadId),
  failed: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      message: Schema.String,
    }),
  ),
  /** Only on a bulk unarchive, and only when some chat had to be renamed to stay unique. */
  renamed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        title: Schema.String,
      }),
    ),
  ),
});
export type PersonalBotThreadsBatchResult = typeof PersonalBotThreadsBatchResult.Type;

/**
 * The chats (of the ones asked about) whose bot is working and has said or
 * done something in this turn, each with its latest progress note: one plain
 * line, at most `PERSONAL_PROGRESS_NOTE_MAX_CHARS` characters. What the Bots
 * list shows under a working bot instead of its stale last message.
 */
export const PersonalBotWorkingProgressInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(PERSONAL_BOT_THREADS_BATCH_MAX)),
});
export type PersonalBotWorkingProgressInput = typeof PersonalBotWorkingProgressInput.Type;

export const PersonalBotWorkingProgressResult = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      /** The thread's latest turn: the turn the note was read from. */
      turnId: Schema.NullOr(TurnId),
      note: Schema.String,
      /**
       * That turn has started a tool step. The list has shells only, which
       * know a turn's first reply text but not its tool calls, so without this
       * a turn that goes straight to tools read as thinking (no comet) until
       * its first line of text. Optional: an older server leaves it out.
       */
      toolStep: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type PersonalBotWorkingProgressResult = typeof PersonalBotWorkingProgressResult.Type;

/**
 * Tokens each bot has used, for the Token usage table on the Team screen. One
 * read carries the Today, 7 days and 30 days windows (days in the caller's
 * time zone), counted from the provider transcripts the usage page reads and
 * attributed to a bot through the chat's provider session.
 *
 * The server answers from a snapshot it keeps in memory (at most one refresh
 * every ten minutes, and only while somebody asks), so the first read after a
 * restart can say `warming` with no rows yet. Numbers only: no chat text, no
 * session ids.
 */
export const PersonalBotTokenUsageInput = Schema.Struct({
  /** IANA zone the "today" and the window edges are cut in. */
  timeZone: TrimmedNonEmptyString,
});
export type PersonalBotTokenUsageInput = typeof PersonalBotTokenUsageInput.Type;

export const PERSONAL_TOKEN_USAGE_WINDOW_IDS = ["today", "week", "month"] as const;
export const PersonalBotTokenUsageWindowId = Schema.Literals(PERSONAL_TOKEN_USAGE_WINDOW_IDS);
export type PersonalBotTokenUsageWindowId = typeof PersonalBotTokenUsageWindowId.Type;

/** `ready` is a fresh snapshot; `refreshing` a stale one with a refresh running; `warming` has no snapshot yet; `unavailable` the first scan failed. */
export const PersonalBotTokenUsageStatus = Schema.Literals([
  "ready",
  "refreshing",
  "warming",
  "unavailable",
]);
export type PersonalBotTokenUsageStatus = typeof PersonalBotTokenUsageStatus.Type;

/**
 * The same four buckets the usage page uses. Input is `uncachedInputTokens +
 * cachedInputTokens + cacheCreationTokens`; the headline total adds the
 * output.
 */
export const PersonalBotTokenUsageTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type PersonalBotTokenUsageTotals = typeof PersonalBotTokenUsageTotals.Type;

export const PersonalBotTokenUsageModel = Schema.Struct({
  model: TrimmedNonEmptyString,
  totalTokens: NonNegativeInt,
});
export type PersonalBotTokenUsageModel = typeof PersonalBotTokenUsageModel.Type;

export const PersonalBotTokenUsageRow = Schema.Struct({
  botId: PersonalBotId,
  totals: PersonalBotTokenUsageTotals,
  /** Models the bot's chats ran on in the window, most tokens first (at most five). */
  models: Schema.Array(PersonalBotTokenUsageModel),
  /** Distinct provider sessions that used tokens in the window. */
  sessions: NonNegativeInt,
});
export type PersonalBotTokenUsageRow = typeof PersonalBotTokenUsageRow.Type;

/** A sum with no bot behind it: tokens of sessions no live chat points to. */
export const PersonalBotTokenUsageSum = Schema.Struct({
  totals: PersonalBotTokenUsageTotals,
  sessions: NonNegativeInt,
});
export type PersonalBotTokenUsageSum = typeof PersonalBotTokenUsageSum.Type;

export const PersonalBotTokenUsageWindow = Schema.Struct({
  id: PersonalBotTokenUsageWindowId,
  /** First and last day of the window, `YYYY-MM-DD` in the requested zone. */
  sinceDay: TrimmedNonEmptyString,
  untilDay: TrimmedNonEmptyString,
  /** Bots that used tokens in the window, no particular order. Bots with none have no row. */
  rows: Schema.Array(PersonalBotTokenUsageRow),
  /** Sessions that map to no bot (deleted chats, work outside the app). */
  other: PersonalBotTokenUsageSum,
  /** Everything counted: the bots' rows plus `other`. */
  total: PersonalBotTokenUsageSum,
});
export type PersonalBotTokenUsageWindow = typeof PersonalBotTokenUsageWindow.Type;

export const PersonalBotTokenUsageResult = Schema.Struct({
  status: PersonalBotTokenUsageStatus,
  /** When the snapshot was read (ISO), or null while there is none. */
  readAt: Schema.NullOr(TrimmedNonEmptyString),
  /** Empty while `warming` or `unavailable`. */
  windows: Schema.Array(PersonalBotTokenUsageWindow),
});
export type PersonalBotTokenUsageResult = typeof PersonalBotTokenUsageResult.Type;

/**
 * The user opened this chat: start its provider session in the background so
 * the next message does not wait for it. Fire and forget; no turn starts.
 */
export const PersonalBotPrewarmThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type PersonalBotPrewarmThreadInput = typeof PersonalBotPrewarmThreadInput.Type;

export const PersonalBotsListResult = Schema.Struct({
  bots: Schema.Array(PersonalBot),
  threads: Schema.Array(PersonalBotThread),
  personalProjectId: Schema.NullOr(ProjectId),
});
export type PersonalBotsListResult = typeof PersonalBotsListResult.Type;

/**
 * The personal-shell user profile. `displayName` is the greeting name shown
 * on the Chats screen; the empty string means "unset" (the greeting then
 * omits the name). Stored server-side in `personal_meta` under "displayName".
 */
export const PersonalProfile = Schema.Struct({
  displayName: Schema.String,
  customTeams: Schema.optionalKey(Schema.Array(PersonalBotTeam)),
  /**
   * Chats made for a delegated task archive themselves once the task has
   * finished and the chat sat idle for 30 minutes. On unless turned off.
   * Optional so an older server's profile still decodes (read as on).
   */
  autoArchiveTaskChats: Schema.optionalKey(Schema.Boolean),
});
export type PersonalProfile = typeof PersonalProfile.Type;

export const PersonalProfileSetInput = Schema.Struct({
  /** Trimmed server-side; empty clears the name. Max 80 chars after trim. */
  displayName: Schema.optional(Schema.String),
  teamChange: Schema.optional(
    Schema.Struct({
      operation: Schema.Literals(["create", "delete"]),
      name: PersonalBotTeam,
    }),
  ),
  autoArchiveTaskChats: Schema.optional(Schema.Boolean),
});
export type PersonalProfileSetInput = typeof PersonalProfileSetInput.Type;

/**
 * One chat attachment from a personal-bot thread, as listed on the Files tab.
 * The client only ever gets the attachment id and signed URLs, never a host
 * path.
 */
export const PersonalFile = Schema.Struct({
  /** The attachment id (`ChatAttachment.id`). */
  fileId: TrimmedNonEmptyString,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: NonNegativeInt,
  botId: PersonalBotId,
  threadId: ThreadId,
  /** When the message carrying the attachment was sent. */
  createdAt: Schema.DateTimeUtcFromString,
  /**
   * Signed, expiring `/api/assets/...` URL relative to the environment's HTTP
   * origin. Images serve inline; every other type downloads with its name.
   */
  url: TrimmedNonEmptyString,
  /** Inline URL for documents the browser can show itself (PDF); null otherwise. */
  previewUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** Epoch ms after which `url` and `previewUrl` stop working. */
  expiresAt: Schema.Number,
});
export type PersonalFile = typeof PersonalFile.Type;

export const PersonalFilesListResult = Schema.Struct({
  files: Schema.Array(PersonalFile),
});
export type PersonalFilesListResult = typeof PersonalFilesListResult.Type;

/** Permanently deletes exactly one attachment listed by the personal Files tab. */
export const PersonalFileDeleteInput = Schema.Struct({
  fileId: TrimmedNonEmptyString,
});
export type PersonalFileDeleteInput = typeof PersonalFileDeleteInput.Type;

/** The most files one bulk delete takes; the phone sends larger selections in parts. */
export const PERSONAL_FILES_BATCH_MAX = 500;

/** Deletes several attachments, one at a time, each exactly as `personalFiles.delete` would. */
export const PersonalFilesDeleteManyInput = Schema.Struct({
  fileIds: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PERSONAL_FILES_BATCH_MAX),
  ),
});
export type PersonalFilesDeleteManyInput = typeof PersonalFilesDeleteManyInput.Type;

/** What a bulk file delete did: the files it removed, and the ones it could not, with the reason. */
export const PersonalFilesBatchResult = Schema.Struct({
  done: Schema.Array(Schema.String),
  failed: Schema.Array(
    Schema.Struct({
      fileId: Schema.String,
      message: Schema.String,
    }),
  ),
});
export type PersonalFilesBatchResult = typeof PersonalFilesBatchResult.Type;

export class PersonalBotsError extends Schema.TaggedError<PersonalBotsError>()(
  "PersonalBotsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
    /** Set to `chat_name_taken` when a typed chat name is refused as a duplicate. */
    code: Schema.optional(Schema.Literal(CHAT_NAME_TAKEN_CODE)),
  },
) {}
