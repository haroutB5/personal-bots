import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  BotAvatarColor,
  BotAvatarShape,
  ChatAttachment,
  ModelSelection,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  PersonalBot,
  PersonalBotId,
  PersonalBotTeam,
  PersonalBotThread,
  ThreadId,
  type ModelSelection as ModelSelectionType,
  MessageId,
  OrchestrationMessageContext,
  OrchestrationMessageRole,
} from "@t3tools/contracts";

import {
  type PersonalBotRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../persistence/Errors.ts";
import type { PersonalBotPersona } from "./personalBotInstructions.ts";

export const CreatePersonalBotInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: ModelSelection,
  team: PersonalBotTeam,
  lead: Schema.Boolean,
  pinned: Schema.Boolean,
  memoryAutoSave: Schema.optional(Schema.Boolean),
  /** Omitted means on (the column default). */
  fallbackEnabled: Schema.optional(Schema.Boolean),
  /** Omitted means the default fallback model (stored as NULL). */
  fallbackModelSelection: Schema.optional(ModelSelection),
  sortOrder: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CreatePersonalBotInput = typeof CreatePersonalBotInput.Type;

export const UpdatePersonalBotInput = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  avatarShape: Schema.optional(BotAvatarShape),
  avatarColor: Schema.optional(BotAvatarColor),
  modelSelection: Schema.optional(ModelSelection),
  enabled: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(Schema.Number),
  team: Schema.optional(PersonalBotTeam),
  lead: Schema.optional(Schema.Boolean),
  pinned: Schema.optional(Schema.Boolean),
  memoryAutoSave: Schema.optional(Schema.Boolean),
  hidePreviews: Schema.optional(Schema.Boolean),
  fallbackEnabled: Schema.optional(Schema.Boolean),
  fallbackModelSelection: Schema.optional(ModelSelection),
  /** Absent leaves the mute alone; null turns notifications back on. */
  notificationsMutedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type UpdatePersonalBotInput = typeof UpdatePersonalBotInput.Type;

/** Demotes every other lead of one team, so a team never has two. */
export const ClearPersonalBotTeamLeadInput = Schema.Struct({
  team: PersonalBotTeam,
  exceptBotId: PersonalBotId,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type ClearPersonalBotTeamLeadInput = typeof ClearPersonalBotTeamLeadInput.Type;

export const GetPersonalBotByIdInput = Schema.Struct({
  botId: PersonalBotId,
});
export type GetPersonalBotByIdInput = typeof GetPersonalBotByIdInput.Type;

export const SoftDeletePersonalBotInput = Schema.Struct({
  botId: PersonalBotId,
  deletedAt: Schema.DateTimeUtcFromString,
});
export type SoftDeletePersonalBotInput = typeof SoftDeletePersonalBotInput.Type;

export const InsertPersonalBotThreadInput = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
});
export type InsertPersonalBotThreadInput = typeof InsertPersonalBotThreadInput.Type;

export const GetPersonalBotThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetPersonalBotThreadInput = typeof GetPersonalBotThreadInput.Type;

export const SetPersonalBotThreadArchivedInput = Schema.Struct({
  threadId: ThreadId,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type SetPersonalBotThreadArchivedInput = typeof SetPersonalBotThreadArchivedInput.Type;

export const GetPersonalMetaInput = Schema.Struct({
  key: Schema.String,
});
export type GetPersonalMetaInput = typeof GetPersonalMetaInput.Type;

export const SetPersonalMetaInput = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});
export type SetPersonalMetaInput = typeof SetPersonalMetaInput.Type;

/** One row of `personal_bot_fallbacks`: a bot running on its fallback model. */
/** One open chat of a bot, as an automatic delivery sees it (`listOpenChats`). */
export interface PersonalOpenChat {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Last message time (ISO), else when the chat was made. */
  readonly activityAt: string;
  readonly pinnedAt: string | null;
  /** Made for a delegated task or a routine run, not a conversation. */
  readonly taskChat: boolean;
}

/**
 * What a lead needs to know about one chat of a bot before it hands work into
 * it (`getChatFacts`, `listDirectChats`). A chat is "direct" when it is none of
 * `groupRelay`, `taskChat`, `routineChat` and not `deleted`.
 */
export interface PersonalChatFacts {
  readonly threadId: ThreadId;
  readonly botId: PersonalBotId;
  readonly title: string;
  /** Last message time (ISO), else when the chat was made. */
  readonly activityAt: string;
  readonly archived: boolean;
  readonly deleted: boolean;
  /** The member's transcript inside a group, now or once. */
  readonly groupRelay: boolean;
  /** Made for a delegated task or a routine run (the thread came after the task). */
  readonly taskChat: boolean;
  /** The chat a routine posts into. */
  readonly routineChat: boolean;
}

export interface PersonalBotFallbackState {
  readonly botId: PersonalBotId;
  readonly fallbackModel: ModelSelectionType;
  /** The provider instance that hit its limit (the bot's own, at the time). */
  readonly fromInstanceId: string;
  /** That provider as the owner knows it: "Codex", "Claude". */
  readonly fromProvider: string;
  readonly reason: string | null;
  readonly startedAt: string;
  /** ISO; null when the provider did not say when the limit resets. */
  readonly resetAt: string | null;
  /** The chat the switch line went to; the switch-back line goes there too. */
  readonly noticeThreadId: string | null;
}

const decodeStoredModelSelection = Schema.decodeUnknownOption(
  Schema.fromJsonString(ModelSelection),
);

function withFallbackActive(
  bot: PersonalBot,
  states: ReadonlyMap<string, PersonalBotFallbackState>,
): PersonalBot {
  const state = states.get(bot.botId);
  if (state === undefined) return bot;
  return {
    ...bot,
    fallbackActive: {
      modelSelection: state.fallbackModel,
      since: DateTime.makeUnsafe(state.startedAt),
      ...(state.resetAt === null ? {} : { resetAt: DateTime.makeUnsafe(state.resetAt) }),
      fromProvider: state.fromProvider,
    },
  };
}

export interface PersonalMessageSearchRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly botId: string | null;
  readonly groupId: string | null;
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  readonly archived: boolean;
  /** About 200 characters of the message from `snippetStart` on (1-based). */
  readonly snippet: string;
  readonly snippetStart: number;
}

export class PersonalBotRepository extends Context.Service<
  PersonalBotRepository,
  {
    readonly createBot: (
      input: CreatePersonalBotInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly getBotById: (
      input: GetPersonalBotByIdInput,
    ) => Effect.Effect<Option.Option<PersonalBot>, PersonalBotRepositoryError>;
    readonly listBots: () => Effect.Effect<ReadonlyArray<PersonalBot>, PersonalBotRepositoryError>;
    readonly updateBot: (
      input: UpdatePersonalBotInput,
    ) => Effect.Effect<Option.Option<PersonalBot>, PersonalBotRepositoryError>;
    readonly softDeleteBot: (
      input: SoftDeletePersonalBotInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    /**
     * Clears the lead flag on every live bot of one team except the given one.
     * The caller has just made that bot the lead, so this leaves exactly one.
     */
    readonly clearTeamLead: (
      input: ClearPersonalBotTeamLeadInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly insertThreadLink: (
      input: InsertPersonalBotThreadInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly getThreadLink: (
      input: GetPersonalBotThreadInput,
    ) => Effect.Effect<Option.Option<PersonalBotThread>, PersonalBotRepositoryError>;
    /**
     * True when the thread is, or ever was, a group member's relay thread (the
     * member's transcript inside a group). Such a thread is never a chat the
     * owner opens, so no automatic message is moved out of it or into it.
     */
    readonly isGroupRelay: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean, PersonalBotRepositoryError>;
    readonly setThreadArchived: (
      input: SetPersonalBotThreadArchivedInput,
    ) => Effect.Effect<Option.Option<PersonalBotThread>, PersonalBotRepositoryError>;
    /**
     * The owner has this chat open (viewing heartbeat). Only moves forward;
     * a thread that is not a bot chat (a group's) is left alone.
     */
    readonly recordThreadViewed: (input: {
      readonly threadId: ThreadId;
      readonly viewedAt: string;
    }) => Effect.Effect<void, PersonalBotRepositoryError>;
    /**
     * Pin, snooze and mark-unread of one chat (migration 100). Fields left
     * `undefined` stay as they are. False when the chat is not a bot chat the
     * owner can change (missing, archived or a group relay).
     */
    readonly updateThreadState: (input: {
      readonly threadId: ThreadId;
      readonly pinnedAt?: string | null;
      readonly snoozedUntil?: string | null;
      /** Wakes a snoozed chat now: a snooze that ends after this time ends at it. */
      readonly wakeAt?: string;
      readonly markedUnreadAt?: string | null;
    }) => Effect.Effect<boolean, PersonalBotRepositoryError>;
    /**
     * Case-insensitive (ASCII) substring search over what the owner and the
     * bots said, newest first, at most `limit` rows. Chats of bots that hide
     * their previews, group relays, deleted chats and bots are left out.
     */
    readonly searchMessages: (input: {
      readonly needle: string;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<PersonalMessageSearchRow>, PersonalBotRepositoryError>;
    /** Every bot that runs on its fallback model right now (migration 101). */
    readonly listFallbackStates: () => Effect.Effect<
      ReadonlyArray<PersonalBotFallbackState>,
      PersonalBotRepositoryError
    >;
    /** Switches a bot onto its fallback; false when it already is on one. */
    readonly startFallback: (
      state: PersonalBotFallbackState,
    ) => Effect.Effect<boolean, PersonalBotRepositoryError>;
    /** The reset time moved (a later window, a re-check); null means not known. */
    readonly updateFallbackReset: (input: {
      readonly botId: PersonalBotId;
      readonly resetAt: string | null;
    }) => Effect.Effect<void, PersonalBotRepositoryError>;
    /** Switches a bot back to its own model; false when it was not on a fallback. */
    readonly endFallback: (
      botId: PersonalBotId,
    ) => Effect.Effect<boolean, PersonalBotRepositoryError>;
    /** Removes exactly one bot-thread link row; the thread itself is deleted via `thread.delete`. */
    readonly deleteThreadLink: (
      input: GetPersonalBotThreadInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    readonly listThreadLinks: () => Effect.Effect<
      ReadonlyArray<PersonalBotThread>,
      PersonalBotRepositoryError
    >;
    /**
     * Titles of the bot's open chats (not archived, not deleted, not a group
     * relay), optionally without one chat. What a chat name has to differ from.
     */
    readonly listOpenChatTitles: (input: {
      readonly botId: PersonalBotId;
      readonly exceptThreadId?: ThreadId;
    }) => Effect.Effect<ReadonlyArray<string>, PersonalBotRepositoryError>;
    /**
     * The bot's open chats (same definition as `listOpenChatTitles`) with what
     * an automatic delivery picks by: last message time (newest first is the
     * caller's job), pinned, and whether the chat was made for a delegated
     * task or routine run. Where a message goes when the chat it was meant for
     * is archived or gone.
     */
    readonly listOpenChats: (input: {
      readonly botId: PersonalBotId;
      readonly exceptThreadId?: ThreadId;
    }) => Effect.Effect<ReadonlyArray<PersonalOpenChat>, PersonalBotRepositoryError>;
    /**
     * One bot chat with the facts that decide whether work may be handed into
     * it. None when the thread has no bot link or no projection (never made,
     * or removed). Deleted, archived and group-relay chats are returned and
     * flagged, so a caller can say why it refuses them.
     */
    readonly getChatFacts: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<Option.Option<PersonalChatFacts>, PersonalBotRepositoryError>;
    /**
     * The bot's direct chats (see {@link PersonalChatFacts}), archived ones
     * included, newest activity first, at most `limit`.
     */
    readonly listDirectChats: (input: {
      readonly botId: PersonalBotId;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<PersonalChatFacts>, PersonalBotRepositoryError>;
    /**
     * Who a removed chat belonged to and what it was called, read from what
     * outlives the link row: a task or routine that was bound to it, and the
     * soft-deleted thread projection. None when nothing ties it to a bot.
     */
    readonly getRemovedChatOrigin: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      Option.Option<{ readonly botId: PersonalBotId; readonly title: string | null }>,
      PersonalBotRepositoryError
    >;
    /**
     * The naming scope of one existing chat: its bot, whether the chat is
     * archived, and the titles of the bot's other open chats. None when the
     * chat is not a bot chat that has to be unique (no link, a group relay or
     * a deleted thread).
     */
    readonly getChatTitleScope: (input: { readonly threadId: ThreadId }) => Effect.Effect<
      Option.Option<{
        readonly botId: PersonalBotId;
        readonly archived: boolean;
        readonly peerTitles: ReadonlyArray<string>;
      }>,
      PersonalBotRepositoryError
    >;
    /**
     * Per live bot: the live groups it sits in, and whether it has a private
     * chat of its own. What `personalBots.list` derives `groupOnly` from.
     */
    readonly listGroupPresence: () => Effect.Effect<
      ReadonlyArray<PersonalBotGroupPresence>,
      PersonalBotRepositoryError
    >;
    readonly getMeta: (
      input: GetPersonalMetaInput,
    ) => Effect.Effect<Option.Option<string>, PersonalBotRepositoryError>;
    readonly setMeta: (
      input: SetPersonalMetaInput,
    ) => Effect.Effect<void, PersonalBotRepositoryError>;
    /**
     * Messages with attachments in threads linked to live (not deleted) bots,
     * newest first. Rows whose ids or attachment JSON fail to decode are
     * skipped so one bad message cannot hide every file.
     */
    readonly listThreadAttachments: () => Effect.Effect<
      ReadonlyArray<PersonalThreadAttachments>,
      PersonalBotRepositoryError
    >;
    /**
     * The bot's name, title and instructions for a thread, for the provider
     * session/turn path. None when the thread has no bot link or the bot is
     * soft-deleted.
     */
    readonly getInstructionsForThread: (
      input: GetPersonalBotThreadInput,
    ) => Effect.Effect<Option.Option<PersonalBotPersona>, PersonalBotRepositoryError>;
  }
>()("t3/personal/PersonalBotRepository") {}

const PersonalBotDbRow = Schema.Struct({
  botId: PersonalBotId,
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  avatarShape: BotAvatarShape,
  avatarColor: BotAvatarColor,
  modelSelection: Schema.fromJsonString(ModelSelection),
  enabled: Schema.Number,
  sortOrder: Schema.Number,
  team: PersonalBotTeam,
  lead: Schema.Number,
  pinned: Schema.Number,
  memoryAutoSave: Schema.Number,
  hidePreviews: Schema.Number,
  fallbackEnabled: Schema.Number,
  fallbackModel: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
  notificationsMutedUntil: Schema.NullOr(Schema.DateTimeUtcFromString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  deletedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const PersonalBotRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  name: Schema.Unknown,
  title: Schema.Unknown,
  description: Schema.Unknown,
  instructions: Schema.Unknown,
  avatarShape: Schema.Unknown,
  avatarColor: Schema.Unknown,
  modelSelection: Schema.Unknown,
  enabled: Schema.Unknown,
  sortOrder: Schema.Unknown,
  team: Schema.Unknown,
  lead: Schema.Unknown,
  pinned: Schema.Unknown,
  memoryAutoSave: Schema.Unknown,
  hidePreviews: Schema.Unknown,
  fallbackEnabled: Schema.Unknown,
  fallbackModel: Schema.Unknown,
  notificationsMutedUntil: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
  deletedAt: Schema.Unknown,
});

const PersonalBotThreadDbRow = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const PersonalBotThreadRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  threadId: Schema.Unknown,
  createdAt: Schema.Unknown,
  archivedAt: Schema.Unknown,
});

// The list carries each thread's newest shown message so the chats list can
// show a preview without a live thread subscription per row.
const PersonalBotThreadListDbRow = Schema.Struct({
  ...PersonalBotThreadDbRow.fields,
  lastActivityAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  newestMessageId: Schema.NullOr(MessageId),
  newestRole: Schema.NullOr(OrchestrationMessageRole),
  newestText: Schema.NullOr(Schema.String),
  newestContext: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  newestHidden: Schema.Number,
  groupRelay: Schema.Number,
  lastReplyAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastViewedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  eligible: Schema.Number,
  pinnedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  snoozedUntil: Schema.NullOr(Schema.DateTimeUtcFromString),
  wokeAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  markedUnreadAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const PersonalBotThreadListRawDbRow = Schema.Struct({
  ...PersonalBotThreadRawDbRow.fields,
  lastActivityAt: Schema.Unknown,
  newestMessageId: Schema.Unknown,
  newestRole: Schema.Unknown,
  newestText: Schema.Unknown,
  newestContext: Schema.Unknown,
  newestHidden: Schema.Unknown,
  groupRelay: Schema.Unknown,
  lastReplyAt: Schema.Unknown,
  lastViewedAt: Schema.Unknown,
  eligible: Schema.Unknown,
  pinnedAt: Schema.Unknown,
  snoozedUntil: Schema.Unknown,
  wokeAt: Schema.Unknown,
  markedUnreadAt: Schema.Unknown,
});

const PersonalMetaDbRow = Schema.Struct({
  value: Schema.String,
});

/**
 * One live bot's standing towards groups.
 *
 * - `groupIds`: the groups (not archived, not deleted) it is a current member of.
 * - `hasPrivateChat`: it has at least one chat of its own that the owner can
 *   see and that has something in it. A group's relay thread (the member's
 *   private provider thread a group talks through, past or present) is never
 *   one; neither is an archived or deleted chat, nor an empty "New chat" that
 *   was opened and never written in.
 */
export interface PersonalBotGroupPresence {
  readonly botId: PersonalBotId;
  readonly groupIds: ReadonlyArray<string>;
  readonly hasPrivateChat: boolean;
}

const PersonalBotGroupPresenceDbRow = Schema.Struct({
  botId: PersonalBotId,
  groupIds: Schema.fromJsonString(Schema.Array(Schema.String)),
  hasPrivateChat: Schema.Number,
});

const PersonalBotGroupPresenceRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  groupIds: Schema.Unknown,
  hasPrivateChat: Schema.Unknown,
});

const decodePersonalBotGroupPresenceDbRow = Schema.decodeUnknownEffect(
  PersonalBotGroupPresenceDbRow,
);

export interface PersonalThreadAttachments {
  readonly botId: PersonalBotId;
  readonly threadId: ThreadId;
  readonly createdAt: typeof Schema.DateTimeUtcFromString.Type;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

const PersonalThreadAttachmentsDbRow = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  attachments: Schema.fromJsonString(Schema.Array(ChatAttachment)),
});

const PersonalThreadAttachmentsRawDbRow = Schema.Struct({
  botId: Schema.Unknown,
  threadId: Schema.Unknown,
  createdAt: Schema.Unknown,
  attachments: Schema.Unknown,
});

const decodePersonalThreadAttachmentsDbRow = Schema.decodeUnknownOption(
  PersonalThreadAttachmentsDbRow,
);

const decodePersonalBotDbRow = Schema.decodeUnknownEffect(PersonalBotDbRow);
const decodePersonalBotThreadDbRow = Schema.decodeUnknownEffect(PersonalBotThreadDbRow);
const decodePersonalBotThreadListDbRow = Schema.decodeUnknownEffect(PersonalBotThreadListDbRow);

function toPersonalBot(row: typeof PersonalBotDbRow.Type): PersonalBot {
  return {
    botId: row.botId,
    name: row.name,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    avatarShape: row.avatarShape,
    avatarColor: row.avatarColor,
    modelSelection: row.modelSelection as ModelSelectionType,
    enabled: row.enabled === 1,
    sortOrder: row.sortOrder,
    team: row.team,
    lead: row.lead === 1,
    pinned: row.pinned === 1,
    memoryAutoSave: row.memoryAutoSave === 1,
    hidePreviews: row.hidePreviews === 1,
    fallback: {
      enabled: row.fallbackEnabled === 1,
      modelSelection:
        (row.fallbackModel as ModelSelectionType | null) ?? PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
    },
    notificationsMutedUntil: row.notificationsMutedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPersonalBotThread(row: typeof PersonalBotThreadDbRow.Type): PersonalBotThread {
  return {
    botId: row.botId,
    threadId: row.threadId,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

function toPersonalBotThreadWithPreview(
  row: typeof PersonalBotThreadListDbRow.Type,
): PersonalBotThread {
  const newestMessage =
    row.newestMessageId === null || row.newestRole === null || row.newestText === null
      ? null
      : {
          id: row.newestMessageId,
          role: row.newestRole,
          text: row.newestText,
          ...(row.newestContext !== null ? { context: row.newestContext } : {}),
          ...(row.newestHidden === 1 ? { hidden: true } : {}),
        };
  return {
    ...toPersonalBotThread(row),
    lastActivityAt: row.lastActivityAt,
    newestMessage,
    // Only when true, so the list stays the same size for every other chat.
    ...(row.groupRelay === 1 ? { groupRelay: true } : {}),
    ...unreadFields(row),
    ...(row.pinnedAt !== null ? { pinnedAt: row.pinnedAt } : {}),
    ...(row.snoozedUntil !== null ? { snoozedUntil: row.snoozedUntil } : {}),
  };
}

/**
 * A chat marked unread from inside the open chat is left a moment later, and
 * leaving stamps `last_viewed_at`. Marks count from this long after they were
 * made, so that leave does not read the chat again; the next real open does.
 */
export const MARKED_UNREAD_GRACE_MS = 30_000;

/**
 * The unread part of a list row. A bot reply after the owner last had the chat
 * open makes it unread (`isThreadRowUnread`). So does the owner marking it
 * unread, and a snooze running out (`wokeAt`): both count from their own time
 * until `last_viewed_at` passes it, for every bot, and `lastReplyAt` carries
 * the later of the bot's reply and that time so a client that opens the chat
 * can clear it before a refetch.
 */
export function unreadFields(row: {
  readonly groupRelay: number;
  readonly eligible: number;
  readonly lastReplyAt: DateTime.Utc | null;
  readonly lastViewedAt: DateTime.Utc | null;
  readonly wokeAt: DateTime.Utc | null;
  readonly markedUnreadAt: DateTime.Utc | null;
}): {
  readonly unread?: true;
  readonly markedUnread?: true;
  readonly lastReplyAt?: DateTime.Utc;
} {
  const replyUnread = isThreadRowUnread(row) && row.lastReplyAt !== null;
  const markMs = Math.max(
    row.markedUnreadAt === null
      ? -Infinity
      : DateTime.toEpochMillis(row.markedUnreadAt) + MARKED_UNREAD_GRACE_MS,
    row.wokeAt === null ? -Infinity : DateTime.toEpochMillis(row.wokeAt),
  );
  const viewedMs = row.lastViewedAt === null ? -Infinity : DateTime.toEpochMillis(row.lastViewedAt);
  const markedUnread =
    row.groupRelay !== 1 && row.eligible === 1 && Number.isFinite(markMs) && markMs > viewedMs;
  if (!replyUnread && !markedUnread) return {};
  const replyMs =
    replyUnread && row.lastReplyAt !== null ? DateTime.toEpochMillis(row.lastReplyAt) : -Infinity;
  return {
    unread: true,
    ...(markedUnread ? { markedUnread: true as const } : {}),
    lastReplyAt: DateTime.makeUnsafe(Math.max(replyMs, markedUnread ? markMs : -Infinity)),
  };
}

/**
 * The bot replied after the owner last had the chat open. The query only
 * returns `lastReplyAt` for chats a list shows (not archived, not deleted, not
 * a group relay), and `lastViewedAt` falls back to when this feature first
 * ran (`PERSONAL_CHAT_UNREAD_SINCE_META_KEY`), so chats nobody opened before
 * then do not all light up at once.
 */
export function isThreadRowUnread(row: {
  readonly groupRelay: number;
  readonly lastReplyAt: DateTime.Utc | null;
  readonly lastViewedAt: DateTime.Utc | null;
}): boolean {
  if (row.groupRelay === 1 || row.lastReplyAt === null || row.lastViewedAt === null) return false;
  return DateTime.toEpochMillis(row.lastReplyAt) > DateTime.toEpochMillis(row.lastViewedAt);
}

/** personal_meta key: when unread chats started counting (ISO), written once. */
export const PERSONAL_CHAT_UNREAD_SINCE_META_KEY = "chat_unread_since";

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): PersonalBotRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createBotRow = SqlSchema.void({
    Request: CreatePersonalBotInput,
    execute: (input) =>
      sql`
        INSERT INTO personal_bots (
          bot_id,
          name,
          title,
          description,
          instructions,
          avatar_shape,
          avatar_color,
          model_selection_json,
          enabled,
          sort_order,
          team,
          is_lead,
          pinned,
          memory_auto_save,
          fallback_enabled,
          fallback_model_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${input.botId},
          ${input.name},
          ${input.title},
          ${input.description},
          ${input.instructions},
          ${input.avatarShape},
          ${input.avatarColor},
          ${JSON.stringify(input.modelSelection)},
          1,
          ${input.sortOrder},
          ${input.team},
          ${input.lead ? 1 : 0},
          ${input.pinned ? 1 : 0},
          ${input.memoryAutoSave === false ? 0 : 1},
          ${input.fallbackEnabled === false ? 0 : 1},
          ${input.fallbackModelSelection === undefined ? null : JSON.stringify(input.fallbackModelSelection)},
          ${input.createdAt},
          ${input.updatedAt},
          NULL
        )
      `,
  });

  const getBotRowById = SqlSchema.findOneOption({
    Request: GetPersonalBotByIdInput,
    Result: PersonalBotRawDbRow,
    execute: ({ botId }) =>
      sql`
        SELECT
          bot_id AS "botId",
          name AS "name",
          title AS "title",
          description AS "description",
          instructions AS "instructions",
          avatar_shape AS "avatarShape",
          avatar_color AS "avatarColor",
          model_selection_json AS "modelSelection",
          enabled AS "enabled",
          sort_order AS "sortOrder",
          team AS "team",
          is_lead AS "lead",
          pinned AS "pinned",
          memory_auto_save AS "memoryAutoSave",
          hide_previews AS "hidePreviews",
          fallback_enabled AS "fallbackEnabled",
          fallback_model_json AS "fallbackModel",
          notifications_muted_until AS "notificationsMutedUntil",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM personal_bots
        WHERE bot_id = ${botId}
      `,
  });

  const listBotRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersonalBotRawDbRow,
    execute: () =>
      sql`
        SELECT
          bot_id AS "botId",
          name AS "name",
          title AS "title",
          description AS "description",
          instructions AS "instructions",
          avatar_shape AS "avatarShape",
          avatar_color AS "avatarColor",
          model_selection_json AS "modelSelection",
          enabled AS "enabled",
          sort_order AS "sortOrder",
          team AS "team",
          is_lead AS "lead",
          pinned AS "pinned",
          memory_auto_save AS "memoryAutoSave",
          hide_previews AS "hidePreviews",
          fallback_enabled AS "fallbackEnabled",
          fallback_model_json AS "fallbackModel",
          notifications_muted_until AS "notificationsMutedUntil",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM personal_bots
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, bot_id ASC
      `,
  });

  const updateBotRow = SqlSchema.findOneOption({
    Request: UpdatePersonalBotInput,
    Result: PersonalBotRawDbRow,
    execute: (input) =>
      sql`
        UPDATE personal_bots
        SET name = COALESCE(${input.name ?? null}, name),
            title = COALESCE(${input.title ?? null}, title),
            description = COALESCE(${input.description ?? null}, description),
            instructions = COALESCE(${input.instructions ?? null}, instructions),
            avatar_shape = COALESCE(${input.avatarShape ?? null}, avatar_shape),
            avatar_color = COALESCE(${input.avatarColor ?? null}, avatar_color),
            model_selection_json = COALESCE(
              ${input.modelSelection === undefined ? null : JSON.stringify(input.modelSelection)},
              model_selection_json
            ),
            enabled = COALESCE(${input.enabled === undefined ? null : input.enabled ? 1 : 0}, enabled),
            sort_order = COALESCE(${input.sortOrder ?? null}, sort_order),
            team = COALESCE(${input.team ?? null}, team),
            is_lead = COALESCE(${input.lead === undefined ? null : input.lead ? 1 : 0}, is_lead),
            pinned = COALESCE(${input.pinned === undefined ? null : input.pinned ? 1 : 0}, pinned),
            memory_auto_save = COALESCE(
              ${input.memoryAutoSave === undefined ? null : input.memoryAutoSave ? 1 : 0},
              memory_auto_save
            ),
            hide_previews = COALESCE(
              ${input.hidePreviews === undefined ? null : input.hidePreviews ? 1 : 0},
              hide_previews
            ),
            fallback_enabled = COALESCE(
              ${input.fallbackEnabled === undefined ? null : input.fallbackEnabled ? 1 : 0},
              fallback_enabled
            ),
            fallback_model_json = COALESCE(
              ${input.fallbackModelSelection === undefined ? null : JSON.stringify(input.fallbackModelSelection)},
              fallback_model_json
            ),
            notifications_muted_until = CASE
              WHEN ${input.notificationsMutedUntil === undefined ? 0 : 1} = 1
                THEN ${input.notificationsMutedUntil ?? null}
              ELSE notifications_muted_until
            END,
            updated_at = ${input.updatedAt}
        WHERE bot_id = ${input.botId}
        RETURNING
          bot_id AS "botId",
          name AS "name",
          title AS "title",
          description AS "description",
          instructions AS "instructions",
          avatar_shape AS "avatarShape",
          avatar_color AS "avatarColor",
          model_selection_json AS "modelSelection",
          enabled AS "enabled",
          sort_order AS "sortOrder",
          team AS "team",
          is_lead AS "lead",
          pinned AS "pinned",
          memory_auto_save AS "memoryAutoSave",
          hide_previews AS "hidePreviews",
          fallback_enabled AS "fallbackEnabled",
          fallback_model_json AS "fallbackModel",
          notifications_muted_until AS "notificationsMutedUntil",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
      `,
  });

  const clearTeamLeadRow = SqlSchema.void({
    Request: ClearPersonalBotTeamLeadInput,
    execute: ({ team, exceptBotId, updatedAt }) =>
      sql`
        UPDATE personal_bots
        SET is_lead = 0,
            updated_at = ${updatedAt}
        WHERE lower(team) = lower(${team})
          AND bot_id <> ${exceptBotId}
          AND is_lead = 1
          AND deleted_at IS NULL
      `,
  });

  const softDeleteBotRow = SqlSchema.void({
    Request: SoftDeletePersonalBotInput,
    execute: ({ botId, deletedAt }) =>
      sql`
        UPDATE personal_bots
        SET deleted_at = ${deletedAt}
        WHERE bot_id = ${botId}
          AND deleted_at IS NULL
      `,
  });

  const insertThreadLinkRow = SqlSchema.void({
    Request: InsertPersonalBotThreadInput,
    execute: (input) =>
      sql`
        INSERT INTO personal_bot_threads (thread_id, bot_id, created_at, archived_at)
        VALUES (${input.threadId}, ${input.botId}, ${input.createdAt}, NULL)
      `,
  });

  const getThreadLinkRow = SqlSchema.findOneOption({
    Request: GetPersonalBotThreadInput,
    Result: PersonalBotThreadRawDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          bot_id AS "botId",
          thread_id AS "threadId",
          created_at AS "createdAt",
          archived_at AS "archivedAt"
        FROM personal_bot_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const setThreadArchivedRow = SqlSchema.findOneOption({
    Request: SetPersonalBotThreadArchivedInput,
    Result: PersonalBotThreadRawDbRow,
    execute: ({ threadId, archivedAt }) =>
      sql`
        UPDATE personal_bot_threads
        SET archived_at = ${archivedAt},
            pinned_at = CASE WHEN ${archivedAt} IS NULL THEN pinned_at ELSE NULL END,
            snoozed_until = CASE WHEN ${archivedAt} IS NULL THEN snoozed_until ELSE NULL END
        WHERE thread_id = ${threadId}
        RETURNING
          bot_id AS "botId",
          thread_id AS "threadId",
          created_at AS "createdAt",
          archived_at AS "archivedAt"
      `,
  });

  const deleteThreadLinkRow = SqlSchema.void({
    Request: GetPersonalBotThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM personal_bot_threads
        WHERE thread_id = ${threadId}
      `,
  });

  // One indexed point lookup per link for the newest message the list can show
  // (idx_projection_thread_messages_thread_created_id); the preview text is
  // capped at the length the list can show. `reasoning` is a provider's
  // thinking trace, never something the bot said, so it is skipped alongside
  // `system`.
  //
  // Only a bot's newest chats carry a preview. The one reader (the Chats
  // screen's `buildBotSummaries`) shows the preview of each bot's newest
  // thread: not archived (link or thread), not deleted, not an active group
  // member relay, ordered by its last message (`activity_at`, also returned as
  // `lastActivityAt`), never `updated_at`: auto-settle, a session stop or a
  // rename move that without anything said in the chat. Every other link used
  // to ship up to 400 chars nobody read, and the list is refetched while bots
  // stream. The newest TWO eligible threads per bot keep a preview, so a
  // client whose shells are one update behind the server still finds its
  // newest thread's text; anything else falls back to the thread title.
  //
  // Snooze (migration 100): a chat snoozed until a time after `now` is not
  // eligible (no preview, no unread) and its `snoozedUntil` goes out; one whose
  // time has passed is awake again, ordered as if a message arrived at the wake
  // time (`activity_at`) and unread from then (`wokeAt`, see `unreadFields`).
  const listThreadLinkRows = SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.String }),
    Result: PersonalBotThreadListRawDbRow,
    execute: ({ now }) =>
      sql`
        WITH candidates AS (
          SELECT
            t.bot_id,
            t.thread_id,
            t.created_at,
            t.archived_at,
            t.last_viewed_at,
            t.pinned_at,
            t.snoozed_until,
            t.marked_unread_at,
            CASE
              WHEN t.archived_at IS NULL
                AND p.archived_at IS NULL
                AND p.deleted_at IS NULL
                AND (t.snoozed_until IS NULL OR t.snoozed_until <= ${now})
                AND NOT EXISTS (
                  SELECT 1
                  FROM personal_group_members gm
                  JOIN personal_groups g ON g.group_id = gm.group_id
                  WHERE gm.thread_id = t.thread_id
                    AND gm.left_at IS NULL
                    AND g.deleted_at IS NULL
                )
              THEN 1
              ELSE 0
            END AS eligible,
            COALESCE(
              (
                SELECT max(a.created_at)
                FROM projection_thread_messages a
                WHERE a.thread_id = t.thread_id AND a.role NOT IN ('system', 'reasoning')
              ),
              p.created_at,
              t.created_at
            ) AS base_activity_at
          FROM personal_bot_threads t
          LEFT JOIN projection_threads p ON p.thread_id = t.thread_id
        ),
        timed AS (
          SELECT
            c.*,
            CASE
              WHEN c.snoozed_until IS NOT NULL
                AND c.snoozed_until <= ${now}
                AND c.snoozed_until > c.base_activity_at
              THEN c.snoozed_until
              ELSE c.base_activity_at
            END AS activity_at
          FROM candidates c
        ),
        ranked AS (
          SELECT
            c.*,
            ROW_NUMBER() OVER (
              PARTITION BY c.bot_id, c.eligible
              ORDER BY c.activity_at DESC, c.created_at ASC, c.thread_id ASC
            ) AS preview_rank
          FROM timed c
        )
        SELECT
          r.bot_id AS "botId",
          r.thread_id AS "threadId",
          r.created_at AS "createdAt",
          r.archived_at AS "archivedAt",
          r.activity_at AS "lastActivityAt",
          m.message_id AS "newestMessageId",
          m.role AS "newestRole",
          -- A bot whose owner hid its previews (migration 099) sends no message
          -- text and no context marker over this list at all: the client could
          -- neither show nor cache what it never receives.
          CASE WHEN COALESCE(hb.hide_previews, 0) = 1 THEN '' ELSE substr(m.text, 1, 400) END AS "newestText",
          CASE WHEN COALESCE(hb.hide_previews, 0) = 1 THEN NULL ELSE m.context_json END AS "newestContext",
          COALESCE(hb.hide_previews, 0) AS "newestHidden",
          -- A group member's relay, past or present (listGroupPresence reads
          -- relays the same way): no bot chat list shows one.
          EXISTS (
            SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = r.thread_id
          ) AS "groupRelay",
          -- Unread (isThreadRowUnread): the newest reply of a chat a list
          -- shows, against when the owner last had it open. Assistant rows
          -- only: the owner's own message or a system row never counts.
          CASE
            WHEN r.eligible = 1 THEN (
              SELECT max(a.created_at)
              FROM projection_thread_messages a
              WHERE a.thread_id = r.thread_id AND a.role = 'assistant'
            )
          END AS "lastReplyAt",
          COALESCE(
            r.last_viewed_at,
            (SELECT value FROM personal_meta WHERE key = ${PERSONAL_CHAT_UNREAD_SINCE_META_KEY})
          ) AS "lastViewedAt",
          r.eligible AS "eligible",
          r.pinned_at AS "pinnedAt",
          CASE WHEN r.snoozed_until > ${now} THEN r.snoozed_until END AS "snoozedUntil",
          CASE WHEN r.snoozed_until <= ${now} THEN r.snoozed_until END AS "wokeAt",
          r.marked_unread_at AS "markedUnreadAt"
        FROM ranked r
        LEFT JOIN personal_bots hb ON hb.bot_id = r.bot_id
        LEFT JOIN projection_thread_messages m
          ON r.eligible = 1
          AND r.preview_rank <= 2
          AND m.message_id = (
            SELECT n.message_id
            FROM projection_thread_messages n
            WHERE n.thread_id = r.thread_id AND n.role NOT IN ('system', 'reasoning')
            ORDER BY n.created_at DESC, n.message_id DESC
            LIMIT 1
          )
        ORDER BY r.created_at ASC, r.thread_id ASC
      `,
  });

  const listGroupPresenceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersonalBotGroupPresenceRawDbRow,
    execute: () =>
      sql`
        SELECT
          b.bot_id AS "botId",
          (
            SELECT json_group_array(gm.group_id)
            FROM personal_group_members gm
            JOIN personal_groups g ON g.group_id = gm.group_id
            WHERE gm.bot_id = b.bot_id
              AND gm.left_at IS NULL
              AND g.archived_at IS NULL
              AND g.deleted_at IS NULL
          ) AS "groupIds",
          EXISTS (
            SELECT 1
            FROM personal_bot_threads t
            JOIN projection_threads p ON p.thread_id = t.thread_id
            WHERE t.bot_id = b.bot_id
              AND t.archived_at IS NULL
              AND p.archived_at IS NULL
              AND p.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = t.thread_id
              )
              AND EXISTS (
                SELECT 1
                FROM projection_thread_messages m
                WHERE m.thread_id = t.thread_id AND m.role IN ('user', 'assistant')
              )
          ) AS "hasPrivateChat"
        FROM personal_bots b
        WHERE b.deleted_at IS NULL
        ORDER BY b.bot_id ASC
      `,
  });

  const getMetaRow = SqlSchema.findOneOption({
    Request: GetPersonalMetaInput,
    Result: PersonalMetaDbRow,
    execute: ({ key }) =>
      sql`
        SELECT value AS "value"
        FROM personal_meta
        WHERE key = ${key}
      `,
  });

  const setMetaRow = SqlSchema.void({
    Request: SetPersonalMetaInput,
    execute: ({ key, value }) =>
      sql`
        INSERT INTO personal_meta (key, value)
        VALUES (${key}, ${value})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
  });

  const getInstructionsForThreadRow = SqlSchema.findOneOption({
    Request: GetPersonalBotThreadInput,
    Result: Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      instructions: Schema.String,
      // The bot's own prompt says which engine it runs on, so the selection
      // comes along: a bot with nothing to read invents an answer.
      modelSelection: Schema.fromJsonString(ModelSelection),
      memoryAutoSave: Schema.Number,
    }),
    execute: ({ threadId }) =>
      sql`
        SELECT b.name AS "name", b.title AS "title", b.instructions AS "instructions",
               b.model_selection_json AS "modelSelection",
               b.memory_auto_save AS "memoryAutoSave"
        FROM personal_bot_threads t
        JOIN personal_bots b ON b.bot_id = t.bot_id
        WHERE t.thread_id = ${threadId}
          AND b.deleted_at IS NULL
      `,
  });

  const listThreadAttachmentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PersonalThreadAttachmentsRawDbRow,
    execute: () =>
      sql`
        SELECT
          t.bot_id AS "botId",
          m.thread_id AS "threadId",
          m.created_at AS "createdAt",
          m.attachments_json AS "attachments"
        FROM personal_bot_threads t
        JOIN personal_bots b ON b.bot_id = t.bot_id AND b.deleted_at IS NULL
        JOIN projection_thread_messages m ON m.thread_id = t.thread_id
        WHERE m.attachments_json IS NOT NULL
          AND m.attachments_json <> '[]'
        ORDER BY m.created_at DESC, m.message_id DESC
        LIMIT 200
      `,
  });

  const decodeBotRow = (
    operation: string,
    rowOption: Option.Option<typeof PersonalBotRawDbRow.Type>,
  ) =>
    Option.match(rowOption, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (row) =>
        decodePersonalBotDbRow(row).pipe(
          Effect.mapError((cause) => PersistenceDecodeError.fromSchemaError(operation, cause)),
          Effect.map((decoded) => Option.some(toPersonalBot(decoded))),
        ),
    });

  /** The bot with the fallback it runs on right now, when it runs on one. */
  const withActiveFallback = (
    rowOption: Effect.Effect<Option.Option<PersonalBot>, PersonalBotRepositoryError>,
  ) =>
    rowOption.pipe(
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(option)
          : fallbackStateMap.pipe(
              Effect.map((states) => Option.some(withFallbackActive(option.value, states))),
            ),
      ),
    );

  const decodeThreadRow = (
    operation: string,
    rowOption: Option.Option<typeof PersonalBotThreadRawDbRow.Type>,
  ) =>
    Option.match(rowOption, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (row) =>
        decodePersonalBotThreadDbRow(row).pipe(
          Effect.mapError((cause) =>
            PersistenceDecodeError.fromSchemaError(operation, cause, {
              threadId: String(row.threadId),
            }),
          ),
          Effect.map((decoded) => Option.some(toPersonalBotThread(decoded))),
        ),
    });

  const createBot: PersonalBotRepository["Service"]["createBot"] = (input) =>
    createBotRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.createBot:query",
          "PersonalBotRepository.createBot:encodeRequest",
        ),
      ),
    );

  const getBotById: PersonalBotRepository["Service"]["getBotById"] = (input) =>
    getBotRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getBotById:query",
          "PersonalBotRepository.getBotById:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        withActiveFallback(decodeBotRow("PersonalBotRepository.getBotById:decodeRow", rowOption)),
      ),
    );

  const listBots: PersonalBotRepository["Service"]["listBots"] = () =>
    listBotRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listBots:query",
          "PersonalBotRepository.listBots:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePersonalBotDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "PersonalBotRepository.listBots:decodeRows",
                cause,
              ),
            ),
            Effect.map(toPersonalBot),
          ),
        ),
      ),
      Effect.flatMap((bots) =>
        fallbackStateMap.pipe(
          Effect.map((states) =>
            states.size === 0 ? bots : bots.map((bot) => withFallbackActive(bot, states)),
          ),
        ),
      ),
    );

  const updateBot: PersonalBotRepository["Service"]["updateBot"] = (input) =>
    updateBotRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.updateBot:query",
          "PersonalBotRepository.updateBot:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        withActiveFallback(decodeBotRow("PersonalBotRepository.updateBot:decodeRow", rowOption)),
      ),
    );

  const softDeleteBot: PersonalBotRepository["Service"]["softDeleteBot"] = (input) =>
    softDeleteBotRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.softDeleteBot:query",
          "PersonalBotRepository.softDeleteBot:encodeRequest",
        ),
      ),
    );

  const clearTeamLead: PersonalBotRepository["Service"]["clearTeamLead"] = (input) =>
    clearTeamLeadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.clearTeamLead:query",
          "PersonalBotRepository.clearTeamLead:encodeRequest",
        ),
      ),
    );

  const insertThreadLink: PersonalBotRepository["Service"]["insertThreadLink"] = (input) =>
    insertThreadLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.insertThreadLink:query",
          "PersonalBotRepository.insertThreadLink:encodeRequest",
        ),
      ),
    );

  const getThreadLink: PersonalBotRepository["Service"]["getThreadLink"] = (input) =>
    getThreadLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getThreadLink:query",
          "PersonalBotRepository.getThreadLink:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        decodeThreadRow("PersonalBotRepository.getThreadLink:decodeRow", rowOption),
      ),
    );

  const isGroupRelay: PersonalBotRepository["Service"]["isGroupRelay"] = (input) =>
    sql<{ readonly one: number }>`
      SELECT 1 AS "one" FROM personal_group_members WHERE thread_id = ${input.threadId} LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.isGroupRelay:query")),
    );

  const setThreadArchived: PersonalBotRepository["Service"]["setThreadArchived"] = (input) =>
    setThreadArchivedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.setThreadArchived:query",
          "PersonalBotRepository.setThreadArchived:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        decodeThreadRow("PersonalBotRepository.setThreadArchived:decodeRow", rowOption),
      ),
    );

  const recordThreadViewed: PersonalBotRepository["Service"]["recordThreadViewed"] = (input) =>
    sql`
      UPDATE personal_bot_threads
      SET last_viewed_at = ${input.viewedAt}
      WHERE thread_id = ${input.threadId}
        AND (last_viewed_at IS NULL OR last_viewed_at < ${input.viewedAt})
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.recordThreadViewed:query")),
    );

  const updateThreadState: PersonalBotRepository["Service"]["updateThreadState"] = (input) =>
    sql<{ readonly threadId: string }>`
      UPDATE personal_bot_threads
      SET pinned_at = CASE WHEN ${input.pinnedAt === undefined ? 0 : 1} = 1
            THEN ${input.pinnedAt ?? null} ELSE pinned_at END,
          snoozed_until = CASE WHEN ${input.snoozedUntil === undefined ? 0 : 1} = 1
            THEN ${input.snoozedUntil ?? null}
            WHEN ${input.wakeAt ?? null} IS NOT NULL AND snoozed_until > ${input.wakeAt ?? null}
            THEN ${input.wakeAt ?? null}
            ELSE snoozed_until END,
          marked_unread_at = CASE WHEN ${input.markedUnreadAt === undefined ? 0 : 1} = 1
            THEN ${input.markedUnreadAt ?? null} ELSE marked_unread_at END
      WHERE thread_id = ${input.threadId}
        AND archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM personal_group_members gm
          WHERE gm.thread_id = personal_bot_threads.thread_id
        )
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.updateThreadState:query")),
    );

  // A scan of the messages table with the substring test (about 40 ms on the
  // 24 MB / 35k-row live copy of 6 Oct), then joins for the few rows that
  // match. `instr(lower(text), needle)` finds the match; the snippet is cut in
  // SQL so a long reply never crosses into the server.
  const searchMessages: PersonalBotRepository["Service"]["searchMessages"] = (input) =>
    sql<{
      readonly messageId: string;
      readonly threadId: string;
      readonly botId: string | null;
      readonly groupId: string | null;
      readonly role: "user" | "assistant";
      readonly createdAt: string;
      readonly archived: number;
      readonly snippet: string;
      readonly snippetStart: number;
    }>`
      WITH hits AS (
        SELECT m.message_id, m.thread_id, m.role, m.created_at, m.text,
               instr(lower(m.text), ${input.needle}) AS pos
        FROM projection_thread_messages m
        WHERE m.role IN ('user', 'assistant')
          AND instr(lower(m.text), ${input.needle}) > 0
      )
      SELECT
        h.message_id AS "messageId",
        h.thread_id AS "threadId",
        t.bot_id AS "botId",
        g.group_id AS "groupId",
        h.role AS "role",
        h.created_at AS "createdAt",
        (t.archived_at IS NOT NULL OR p.archived_at IS NOT NULL OR g.archived_at IS NOT NULL)
          AS "archived",
        substr(h.text, CASE WHEN h.pos > 60 THEN h.pos - 60 ELSE 1 END, 200) AS "snippet",
        CASE WHEN h.pos > 60 THEN h.pos - 60 ELSE 1 END AS "snippetStart"
      FROM hits h
      JOIN projection_threads p ON p.thread_id = h.thread_id AND p.deleted_at IS NULL
      LEFT JOIN personal_bot_threads t ON t.thread_id = h.thread_id
      LEFT JOIN personal_bots b ON b.bot_id = t.bot_id
      LEFT JOIN personal_groups g ON g.thread_id = h.thread_id AND g.deleted_at IS NULL
      WHERE (t.thread_id IS NOT NULL OR g.group_id IS NOT NULL)
        AND (
          t.thread_id IS NULL
          OR (
            b.deleted_at IS NULL
            AND b.hide_previews = 0
            AND NOT EXISTS (
              SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = t.thread_id
            )
          )
        )
        AND (
          g.group_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM personal_group_members gm
            JOIN personal_bots hb ON hb.bot_id = gm.bot_id
            WHERE gm.group_id = g.group_id AND gm.left_at IS NULL AND hb.hide_previews = 1
          )
        )
      ORDER BY h.created_at DESC, h.message_id DESC
      LIMIT ${input.limit}
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): PersonalMessageSearchRow => ({
          ...row,
          archived: Number(row.archived) === 1,
        })),
      ),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.searchMessages:query")),
    );

  const listOpenChatTitles: PersonalBotRepository["Service"]["listOpenChatTitles"] = (input) =>
    sql<{ readonly title: string }>`
      SELECT p.title AS "title"
      FROM personal_bot_threads t
      JOIN projection_threads p ON p.thread_id = t.thread_id
      WHERE t.bot_id = ${input.botId}
        AND t.thread_id <> ${input.exceptThreadId ?? ""}
        AND t.archived_at IS NULL
        AND p.archived_at IS NULL
        AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = t.thread_id
        )
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.title)),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.listOpenChatTitles:query")),
    );

  const listOpenChats: PersonalBotRepository["Service"]["listOpenChats"] = (input) =>
    sql<{
      readonly threadId: string;
      readonly title: string;
      readonly activityAt: string;
      readonly pinnedAt: string | null;
      readonly taskChat: number;
    }>`
      SELECT
        t.thread_id AS "threadId",
        p.title AS "title",
        COALESCE(
          (
            SELECT max(a.created_at)
            FROM projection_thread_messages a
            WHERE a.thread_id = t.thread_id AND a.role NOT IN ('system', 'reasoning')
          ),
          p.created_at,
          t.created_at
        ) AS "activityAt",
        t.pinned_at AS "pinnedAt",
        EXISTS (
          SELECT 1 FROM personal_tasks d
          WHERE d.thread_id = t.thread_id
            AND d.source IN ('delegation', 'routine')
            AND d.created_at <= t.created_at
        ) AS "taskChat"
      FROM personal_bot_threads t
      JOIN projection_threads p ON p.thread_id = t.thread_id
      WHERE t.bot_id = ${input.botId}
        AND t.thread_id <> ${input.exceptThreadId ?? ""}
        AND t.archived_at IS NULL
        AND p.archived_at IS NULL
        AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = t.thread_id
        )
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): PersonalOpenChat => ({
          threadId: row.threadId as ThreadId,
          title: row.title,
          activityAt: row.activityAt,
          pinnedAt: row.pinnedAt,
          taskChat: Number(row.taskChat) === 1,
        })),
      ),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.listOpenChats:query")),
    );

  // One query for both chat reads, so "direct" means the same thing in the
  // list a lead picks from and in the check that follows. An empty `threadId`
  // or `botId` filter matches every row; `directOnly` keeps just the chats a
  // lead may hand work into. A task chat is told by the thread coming after the
  // task (or a routine relay post), the same markers the 48 h auto-archive uses
  // (taskChatAutoArchivePolicy.ts), so a chat that was continued by a task is
  // never one: its task came after the chat.
  const chatFactsRows = (input: {
    readonly threadId: string;
    readonly botId: string;
    readonly directOnly: boolean;
    readonly limit: number;
  }) =>
    sql<{
      readonly threadId: string;
      readonly botId: string;
      readonly title: string;
      readonly activityAt: string;
      readonly archived: number;
      readonly deleted: number;
      readonly groupRelay: number;
      readonly taskChat: number;
      readonly routineChat: number;
    }>`
      SELECT * FROM (
        SELECT
          t.thread_id AS "threadId",
          t.bot_id AS "botId",
          p.title AS "title",
          COALESCE(
            (
              SELECT max(a.created_at)
              FROM projection_thread_messages a
              WHERE a.thread_id = t.thread_id AND a.role NOT IN ('system', 'reasoning')
            ),
            p.created_at,
            t.created_at
          ) AS "activityAt",
          (t.archived_at IS NOT NULL OR p.archived_at IS NOT NULL) AS "archived",
          (p.deleted_at IS NOT NULL) AS "deleted",
          EXISTS (
            SELECT 1 FROM personal_group_members gm WHERE gm.thread_id = t.thread_id
          ) AS "groupRelay",
          EXISTS (
            SELECT 1 FROM personal_tasks d
            WHERE d.thread_id = t.thread_id
              AND (
                (d.source IN ('delegation', 'routine') AND d.created_at <= t.created_at)
                OR (d.source = 'routine' AND EXISTS (
                  SELECT 1 FROM projection_thread_messages relay
                  WHERE relay.thread_id = t.thread_id
                    AND relay.role = 'assistant' AND relay.message_id LIKE 'personal-relay-%'
                ))
              )
          ) AS "taskChat",
          EXISTS (
            SELECT 1 FROM personal_routines r WHERE r.thread_id = t.thread_id
          ) AS "routineChat"
        FROM personal_bot_threads t
        JOIN projection_threads p ON p.thread_id = t.thread_id
        JOIN personal_bots b ON b.bot_id = t.bot_id AND b.deleted_at IS NULL
        WHERE (${input.threadId} = '' OR t.thread_id = ${input.threadId})
          AND (${input.botId} = '' OR t.bot_id = ${input.botId})
      )
      WHERE ${input.directOnly ? 1 : 0} = 0
        OR ("deleted" = 0 AND "groupRelay" = 0 AND "taskChat" = 0 AND "routineChat" = 0)
      ORDER BY "activityAt" DESC, "threadId" ASC
      LIMIT ${input.limit}
    `;

  const toChatFacts = (row: {
    readonly threadId: string;
    readonly botId: string;
    readonly title: string;
    readonly activityAt: string;
    readonly archived: number;
    readonly deleted: number;
    readonly groupRelay: number;
    readonly taskChat: number;
    readonly routineChat: number;
  }): PersonalChatFacts => ({
    threadId: row.threadId as ThreadId,
    botId: row.botId as PersonalBotId,
    title: row.title,
    activityAt: row.activityAt,
    archived: Number(row.archived) === 1,
    deleted: Number(row.deleted) === 1,
    groupRelay: Number(row.groupRelay) === 1,
    taskChat: Number(row.taskChat) === 1,
    routineChat: Number(row.routineChat) === 1,
  });

  const getChatFacts: PersonalBotRepository["Service"]["getChatFacts"] = (input) =>
    chatFactsRows({ threadId: input.threadId, botId: "", directOnly: false, limit: 1 }).pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? Option.none() : Option.some(toChatFacts(rows[0])),
      ),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.getChatFacts:query")),
    );

  const listDirectChats: PersonalBotRepository["Service"]["listDirectChats"] = (input) =>
    chatFactsRows({
      threadId: "",
      botId: input.botId,
      directOnly: true,
      limit: Math.max(1, Math.trunc(input.limit)),
    }).pipe(
      Effect.map((rows) => rows.map(toChatFacts)),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.listDirectChats:query")),
    );

  const getRemovedChatOrigin: PersonalBotRepository["Service"]["getRemovedChatOrigin"] = (input) =>
    Effect.gen(function* () {
      const [owner] = yield* sql<{ readonly botId: string }>`
        SELECT bot_id AS "botId" FROM (
          SELECT bot_id, created_at FROM personal_tasks WHERE thread_id = ${input.threadId}
          UNION ALL
          SELECT bot_id, created_at FROM personal_routines WHERE thread_id = ${input.threadId}
        )
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (owner === undefined) return Option.none();
      const [thread] = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_threads WHERE thread_id = ${input.threadId}
      `;
      return Option.some({
        botId: owner.botId as PersonalBotId,
        title: thread?.title ?? null,
      });
    }).pipe(
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.getRemovedChatOrigin:query")),
    );

  const getChatTitleScope: PersonalBotRepository["Service"]["getChatTitleScope"] = (input) =>
    Effect.gen(function* () {
      const [self] = yield* sql<{ readonly botId: string; readonly archived: number }>`
        SELECT
          t.bot_id AS "botId",
          (t.archived_at IS NOT NULL OR p.archived_at IS NOT NULL) AS "archived"
        FROM personal_bot_threads t
        JOIN projection_threads p ON p.thread_id = t.thread_id AND p.deleted_at IS NULL
        WHERE t.thread_id = ${input.threadId}
          AND NOT EXISTS (
            SELECT 1 FROM personal_group_members relay WHERE relay.thread_id = t.thread_id
          )
      `.pipe(
        Effect.mapError(toPersistenceSqlError("PersonalBotRepository.getChatTitleScope:query")),
      );
      if (self === undefined) return Option.none();
      const botId = self.botId as PersonalBotId;
      const peerTitles = yield* listOpenChatTitles({ botId, exceptThreadId: input.threadId });
      return Option.some({ botId, archived: Number(self.archived) === 1, peerTitles });
    });

  const listFallbackStates: PersonalBotRepository["Service"]["listFallbackStates"] = () =>
    sql<{
      readonly botId: string;
      readonly fallbackModel: string;
      readonly fromInstanceId: string;
      readonly fromProvider: string;
      readonly reason: string | null;
      readonly startedAt: string;
      readonly resetAt: string | null;
      readonly noticeThreadId: string | null;
    }>`
      SELECT bot_id AS "botId", fallback_model_json AS "fallbackModel",
             from_instance_id AS "fromInstanceId", from_provider AS "fromProvider",
             reason AS "reason", started_at AS "startedAt", reset_at AS "resetAt",
             notice_thread_id AS "noticeThreadId"
      FROM personal_bot_fallbacks
      ORDER BY started_at ASC
    `.pipe(
      Effect.map((rows) =>
        rows.flatMap((row): PersonalBotFallbackState[] => {
          const model = decodeStoredModelSelection(row.fallbackModel);
          return Option.isNone(model)
            ? []
            : [
                {
                  botId: row.botId as PersonalBotId,
                  fallbackModel: model.value as ModelSelectionType,
                  fromInstanceId: row.fromInstanceId,
                  fromProvider: row.fromProvider,
                  reason: row.reason,
                  startedAt: row.startedAt,
                  resetAt: row.resetAt,
                  noticeThreadId: row.noticeThreadId,
                },
              ];
        }),
      ),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.listFallbackStates:query")),
    );

  const fallbackStateMap = listFallbackStates().pipe(
    Effect.map((states) => new Map(states.map((state) => [state.botId as string, state] as const))),
  );

  const startFallback: PersonalBotRepository["Service"]["startFallback"] = (state) =>
    sql<{ readonly botId: string }>`
      INSERT INTO personal_bot_fallbacks (
        bot_id, fallback_model_json, from_instance_id, from_provider, reason, started_at,
        reset_at, notice_thread_id
      )
      VALUES (
        ${state.botId}, ${JSON.stringify(state.fallbackModel)}, ${state.fromInstanceId},
        ${state.fromProvider}, ${state.reason}, ${state.startedAt}, ${state.resetAt},
        ${state.noticeThreadId}
      )
      ON CONFLICT(bot_id) DO NOTHING
      RETURNING bot_id AS "botId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.startFallback:query")),
    );

  const updateFallbackReset: PersonalBotRepository["Service"]["updateFallbackReset"] = (input) =>
    sql`
      UPDATE personal_bot_fallbacks SET reset_at = ${input.resetAt} WHERE bot_id = ${input.botId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.updateFallbackReset:query")),
    );

  const endFallback: PersonalBotRepository["Service"]["endFallback"] = (botId) =>
    sql<{ readonly botId: string }>`
      DELETE FROM personal_bot_fallbacks WHERE bot_id = ${botId} RETURNING bot_id AS "botId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.endFallback:query")),
    );

  const deleteThreadLink: PersonalBotRepository["Service"]["deleteThreadLink"] = (input) =>
    deleteThreadLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.deleteThreadLink:query",
          "PersonalBotRepository.deleteThreadLink:encodeRequest",
        ),
      ),
    );

  // The unread baseline is written once, the first time a list runs on a
  // database without one; after that the flag skips the write.
  let unreadSinceWritten = false;
  const ensureUnreadSince = Effect.suspend(() => {
    if (unreadSinceWritten) return Effect.void;
    return Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_meta (key, value)
        VALUES (${PERSONAL_CHAT_UNREAD_SINCE_META_KEY}, ${now})
        ON CONFLICT(key) DO NOTHING
      `;
      unreadSinceWritten = true;
    });
  });

  const listThreadLinkPreviews = () =>
    DateTime.now.pipe(
      Effect.flatMap((now) => listThreadLinkRows({ now: DateTime.formatIso(now) })),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listThreadLinks:query",
          "PersonalBotRepository.listThreadLinks:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePersonalBotThreadListDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "PersonalBotRepository.listThreadLinks:decodeRows",
                cause,
              ),
            ),
            Effect.map(toPersonalBotThreadWithPreview),
          ),
        ),
      ),
    );

  const listThreadLinks: PersonalBotRepository["Service"]["listThreadLinks"] = () =>
    ensureUnreadSince.pipe(
      Effect.mapError(toPersistenceSqlError("PersonalBotRepository.listThreadLinks:unreadSince")),
      Effect.andThen(listThreadLinkPreviews),
    );

  const listGroupPresence: PersonalBotRepository["Service"]["listGroupPresence"] = () =>
    listGroupPresenceRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listGroupPresence:query",
          "PersonalBotRepository.listGroupPresence:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePersonalBotGroupPresenceDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "PersonalBotRepository.listGroupPresence:decodeRows",
                cause,
              ),
            ),
            Effect.map((decoded): PersonalBotGroupPresence => ({
              botId: decoded.botId,
              groupIds: decoded.groupIds,
              hasPrivateChat: decoded.hasPrivateChat === 1,
            })),
          ),
        ),
      ),
    );

  const getMeta: PersonalBotRepository["Service"]["getMeta"] = (input) =>
    getMetaRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getMeta:query",
          "PersonalBotRepository.getMeta:decodeRow",
        ),
      ),
      Effect.map(Option.map((row) => row.value)),
    );

  const setMeta: PersonalBotRepository["Service"]["setMeta"] = (input) =>
    setMetaRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.setMeta:query",
          "PersonalBotRepository.setMeta:encodeRequest",
        ),
      ),
    );

  const getInstructionsForThread: PersonalBotRepository["Service"]["getInstructionsForThread"] = (
    input,
  ) =>
    getInstructionsForThreadRow(input).pipe(
      Effect.map(
        Option.map((row) => {
          const effort = row.modelSelection.options?.find(
            (option) => option.id === "variant",
          )?.value;
          return {
            name: row.name,
            title: row.title,
            instructions: row.instructions,
            model: row.modelSelection.model,
            memoryAutoSave: row.memoryAutoSave === 1,
            ...(typeof effort === "string" && effort.length > 0 ? { effort } : {}),
          };
        }),
      ),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.getInstructionsForThread:query",
          "PersonalBotRepository.getInstructionsForThread:decodeRow",
        ),
      ),
      // Some for every thread linked to a live bot, even with blank
      // instructions: the caller still owes that thread its identity and rules.
    );

  const listThreadAttachments: PersonalBotRepository["Service"]["listThreadAttachments"] = () =>
    listThreadAttachmentRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PersonalBotRepository.listThreadAttachments:query",
          "PersonalBotRepository.listThreadAttachments:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.flatMap((row) => Option.toArray(decodePersonalThreadAttachmentsDbRow(row))),
      ),
    );

  return {
    createBot,
    getBotById,
    listBots,
    updateBot,
    softDeleteBot,
    clearTeamLead,
    insertThreadLink,
    getThreadLink,
    isGroupRelay,
    setThreadArchived,
    recordThreadViewed,
    listFallbackStates,
    startFallback,
    updateFallbackReset,
    endFallback,
    updateThreadState,
    searchMessages,
    deleteThreadLink,
    listThreadLinks,
    listOpenChatTitles,
    listOpenChats,
    getChatFacts,
    listDirectChats,
    getRemovedChatOrigin,
    getChatTitleScope,
    listGroupPresence,
    getMeta,
    setMeta,
    getInstructionsForThread,
    listThreadAttachments,
  } satisfies PersonalBotRepository["Service"];
});

export const layer = Layer.effect(PersonalBotRepository, make);
