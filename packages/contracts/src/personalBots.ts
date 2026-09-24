import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ModelSelection, OrchestrationMessageRole } from "./orchestration.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

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
});
export type PersonalBotThreadNewestMessage = typeof PersonalBotThreadNewestMessage.Type;

export const PersonalBotThread = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
  createdAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Only on `personalBots.list`; absent on create/archive results. */
  newestMessage: Schema.optional(Schema.NullOr(PersonalBotThreadNewestMessage)),
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
  notificationsMute: Schema.optional(PersonalBotNotificationMute),
});
export type PersonalBotUpdateInput = typeof PersonalBotUpdateInput.Type;

export const PersonalBotDeleteInput = Schema.Struct({
  botId: PersonalBotId,
});
export type PersonalBotDeleteInput = typeof PersonalBotDeleteInput.Type;

export const PersonalBotCreateThreadInput = Schema.Struct({
  botId: PersonalBotId,
  threadId: ThreadId,
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

export class PersonalBotsError extends Schema.TaggedError<PersonalBotsError>()(
  "PersonalBotsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
