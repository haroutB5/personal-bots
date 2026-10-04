import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";

export const PersonalMemoryId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalMemoryId"));
export type PersonalMemoryId = typeof PersonalMemoryId.Type;

/**
 * shared: every bot (facts about the user themselves). team: one team's bots
 * (scopeId = team name, e.g. "dev"). bot: one bot (scopeId = botId).
 * project: one project (scopeId = projectId).
 */
export const PersonalMemoryScope = Schema.Literals(["shared", "team", "bot", "project"]);
export type PersonalMemoryScope = typeof PersonalMemoryScope.Type;

/**
 * What the owner said about a note or task summary in the "Context used" view:
 * outdated (no longer true) or not relevant (does not belong to what it was
 * given for). Either ranks it lower in future turns; nothing is deleted.
 */
export const PersonalMemoryFeedbackSignal = Schema.Literals(["outdated", "not_relevant"]);
export type PersonalMemoryFeedbackSignal = typeof PersonalMemoryFeedbackSignal.Type;

/** task_summary entries are derived from finished tasks and never treated as preferences. */
export const PersonalMemoryKind = Schema.Literals(["note", "preference", "task_summary"]);
export type PersonalMemoryKind = typeof PersonalMemoryKind.Type;

export const PERSONAL_MEMORY_MAX_LENGTH = 2_000;

export const PersonalMemoryContent = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PERSONAL_MEMORY_MAX_LENGTH),
);

export const PersonalMemoryEntry = Schema.Struct({
  memoryId: PersonalMemoryId,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  kind: PersonalMemoryKind,
  content: Schema.String,
  /** Where it came from: `user`, `bot:<botId>`, `task:<taskId>`. */
  source: Schema.String,
  sensitivity: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  version: Schema.Number,
  /** Set when a newer entry replaced this one: kept for Restore, never given to a bot. */
  supersededAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromString)),
  /** The entry that replaced it, when there is one. */
  supersededBy: Schema.optional(Schema.NullOr(PersonalMemoryId)),
  /** Why, in words: "Replaced by a newer save", or the tidy-up's reason. */
  supersededReason: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * Apps a rule is limited to (slugs such as "matchday"). Null or absent: global,
   * listed on every turn of every bot that can see it. A scoped rule is listed in
   * full only on a turn about one of its apps.
   */
  apps: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  /** The owner's mark on a note or task summary: it is ranked lower while set. */
  demoted: Schema.optional(Schema.NullOr(PersonalMemoryFeedbackSignal)),
});
export type PersonalMemoryEntry = typeof PersonalMemoryEntry.Type;

/**
 * Where a note a bot saved on its own came from, as far as the turn knew:
 * chat (the owner's own message), task, routine, bot (another bot's or a
 * group's message), app (a server notice or continue).
 */
export type PersonalMemoryNoteOrigin = "chat" | "task" | "routine" | "bot" | "app";

const NOTE_ORIGINS: ReadonlyArray<PersonalMemoryNoteOrigin> = [
  "chat",
  "task",
  "routine",
  "bot",
  "app",
];

/** A note's `source`: `bot:<botId>;from=<origin>`, plus `+web` when the turn read a web page first. */
export function botNoteSource(
  botId: string,
  origin: PersonalMemoryNoteOrigin,
  readWeb: boolean,
): string {
  return `bot:${botId};from=${origin}${readWeb ? "+web" : ""}`;
}

export type PersonalMemorySource =
  | { readonly kind: "user" }
  | {
      readonly kind: "bot";
      readonly botId: string;
      /** Absent on entries saved before 1.60.22. */
      readonly origin: PersonalMemoryNoteOrigin | null;
      readonly readWeb: boolean;
    }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "other"; readonly source: string };

export function parseMemorySource(source: string): PersonalMemorySource {
  if (source === "user") return { kind: "user" };
  if (source.startsWith("task:")) return { kind: "task", taskId: source.slice(5) };
  if (!source.startsWith("bot:")) return { kind: "other", source };
  const [botId = "", detail = ""] = source.slice(4).split(";from=");
  const [origin = "", web] = detail.split("+");
  return {
    kind: "bot",
    botId,
    origin: NOTE_ORIGINS.includes(origin as PersonalMemoryNoteOrigin)
      ? (origin as PersonalMemoryNoteOrigin)
      : null,
    readWeb: web === "web",
  };
}

const ORIGIN_TAG: Record<PersonalMemoryNoteOrigin, string> = {
  chat: "from the user's message",
  task: "from a task",
  routine: "from a routine",
  bot: "from another bot",
  app: "from an app notice",
};

/** The short tag a bot-saved note carries ("from a task, after web reading"), or null. */
export function noteSourceTag(source: string): string | null {
  const parsed = parseMemorySource(source);
  if (parsed.kind !== "bot" || parsed.origin === null) return null;
  return `${ORIGIN_TAG[parsed.origin]}${parsed.readWeb ? ", after web reading" : ""}`;
}

export const PersonalMemoryListInput = Schema.Struct({
  scope: Schema.optional(PersonalMemoryScope),
  scopeId: Schema.optional(Schema.String),
  kind: Schema.optional(PersonalMemoryKind),
  /** current (default): what bots receive. superseded: replaced entries, for Restore. */
  status: Schema.optional(Schema.Literals(["current", "superseded"])),
});
export type PersonalMemoryListInput = typeof PersonalMemoryListInput.Type;

export const PersonalMemoryListResult = Schema.Struct({
  entries: Schema.Array(PersonalMemoryEntry),
});
export type PersonalMemoryListResult = typeof PersonalMemoryListResult.Type;

export const PersonalMemorySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  /** Limits results to shared entries plus this bot's; omitted = every scope. */
  botId: Schema.optional(PersonalBotId),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type PersonalMemorySearchInput = typeof PersonalMemorySearchInput.Type;

export const PersonalMemoryUpdateInput = Schema.Struct({
  memoryId: PersonalMemoryId,
  content: Schema.optional(PersonalMemoryContent),
  kind: Schema.optional(Schema.Literals(["note", "preference"])),
});
export type PersonalMemoryUpdateInput = typeof PersonalMemoryUpdateInput.Type;

export const PersonalMemoryDeleteInput = Schema.Struct({ memoryId: PersonalMemoryId });
export type PersonalMemoryDeleteInput = typeof PersonalMemoryDeleteInput.Type;

/** The most entries one bulk delete takes; the phone sends larger selections in parts. */
export const PERSONAL_MEMORY_BATCH_MAX = 500;

/** Deletes several entries, one at a time, each exactly as `personalMemory.delete` would. */
export const PersonalMemoryDeleteManyInput = Schema.Struct({
  memoryIds: Schema.Array(PersonalMemoryId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PERSONAL_MEMORY_BATCH_MAX),
  ),
});
export type PersonalMemoryDeleteManyInput = typeof PersonalMemoryDeleteManyInput.Type;

/** What a bulk memory delete did: the entries it removed, and the ones it could not, with the reason. */
export const PersonalMemoryBatchResult = Schema.Struct({
  done: Schema.Array(PersonalMemoryId),
  failed: Schema.Array(
    Schema.Struct({
      memoryId: PersonalMemoryId,
      message: Schema.String,
    }),
  ),
});
export type PersonalMemoryBatchResult = typeof PersonalMemoryBatchResult.Type;

/** Brings a superseded entry back: bots receive it again. */
export const PersonalMemoryRestoreInput = Schema.Struct({ memoryId: PersonalMemoryId });
export type PersonalMemoryRestoreInput = typeof PersonalMemoryRestoreInput.Type;

/** Undo on a "Saved a note" chat line: archives that note and brings back what it replaced. */
export const PersonalMemoryUndoNoteInput = Schema.Struct({
  memoryId: PersonalMemoryId,
  /** archive (default): a "Saved a note" line. restore: a "Forgot a note" line, note-only. */
  undo: Schema.optional(Schema.Literals(["archive", "restore"])),
});
export type PersonalMemoryUndoNoteInput = typeof PersonalMemoryUndoNoteInput.Type;

/** One entry, current or archived: a note line reads it to show whether its Undo was used. */
export const PersonalMemoryGetInput = Schema.Struct({ memoryId: PersonalMemoryId });
export type PersonalMemoryGetInput = typeof PersonalMemoryGetInput.Type;

/** merge: several entries folded into one. supersede: older entries replaced. leave: unsure, untouched. */
/**
 * merge: several entries folded into one. supersede: older entries archived.
 * reclassify: one entry's kind or reach changes (never its text). save: a bot's new
 * entry (content, toKind, toScope, toScopeId), replacing memoryIds if any. forget: a
 * bot asks to archive memoryIds. split: one long entry becomes several single
 * facts (parts), and the long one is archived. rescope: one entry's app scope
 * changes (toApps; null is global), never its text, kind or reach. leave:
 * unsure, untouched.
 */
export const PersonalMemoryTidyAction = Schema.Literals([
  "merge",
  "supersede",
  "reclassify",
  "save",
  "forget",
  "split",
  "rescope",
  "leave",
]);
export type PersonalMemoryTidyAction = typeof PersonalMemoryTidyAction.Type;

/**
 * applied: made by the run. preview: a preview run listed it. pending: needs
 * the owner's OK (a merge's new wording, or retiring an entry with no newer
 * one). approved / rejected: the owner's answer. left: unsure, untouched.
 */
export const PersonalMemoryTidyChangeStatus = Schema.Literals([
  "applied",
  "preview",
  "pending",
  "approved",
  "rejected",
  "left",
  /** Taken back by a later proposals file before the owner answered. */
  "withdrawn",
]);
export type PersonalMemoryTidyChangeStatus = typeof PersonalMemoryTidyChangeStatus.Type;

/** An entry a pending change is bound to, as it was when proposed. */
export const PersonalMemoryBoundEntry = Schema.Struct({
  memoryId: PersonalMemoryId,
  kind: Schema.String,
  scope: Schema.String,
  scopeId: Schema.NullOr(Schema.String),
  /** Held to its text only: the newer entry a supersede keeps. */
  textOnly: Schema.Boolean,
});
export type PersonalMemoryBoundEntry = typeof PersonalMemoryBoundEntry.Type;

/** One single fact a long entry is split into, with the kind and reach it gets. */
export const PersonalMemorySplitPart = Schema.Struct({
  content: Schema.String,
  kind: Schema.Literals(["note", "preference"]),
  scope: Schema.Literals(["shared", "team"]),
  /** The team's name for a team reach, else null. */
  scopeId: Schema.NullOr(Schema.String),
});
export type PersonalMemorySplitPart = typeof PersonalMemorySplitPart.Type;

export const PersonalMemoryTidyChange = Schema.Struct({
  changeId: Schema.Number,
  status: PersonalMemoryTidyChangeStatus,
  action: PersonalMemoryTidyAction,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  /** The entries merged or superseded (or, for leave, looked at). */
  memoryIds: Schema.Array(PersonalMemoryId),
  /** The entry that now carries the fact. */
  resultMemoryId: Schema.NullOr(PersonalMemoryId),
  /**
   * A merge's combined text; a save's new text; a supersede's newer entry as
   * it read when proposed (null for older changes).
   */
  content: Schema.NullOr(Schema.String),
  /**
   * What an approval is bound to, per entry, as proposed: the entries it
   * archives, merges, forgets or reclassifies by text, kind and reach; the
   * entry a supersede keeps by text only (textOnly). Empty on older changes,
   * which are bound to exact entry versions instead.
   */
  bound: Schema.optional(Schema.Array(PersonalMemoryBoundEntry)),
  /** A split's single facts, in order, each with its own kind and reach. */
  parts: Schema.optional(Schema.Array(PersonalMemorySplitPart)),
  /**
   * A reclassify's new kind, scope and scope id (team name), where they
   * change; a save's or split's kind and reach ("bot": only the proposing bot).
   */
  toKind: Schema.optional(Schema.NullOr(Schema.Literals(["note", "preference"]))),
  toScope: Schema.optional(Schema.NullOr(Schema.Literals(["shared", "team", "bot"]))),
  toScopeId: Schema.optional(Schema.NullOr(Schema.String)),
  /** A rescope's new app scope (slugs); null is global. */
  toApps: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  /** Who proposed it: the tidy-up, a bot ("bot:<id>") or a local proposals file. */
  proposedBy: Schema.optional(Schema.NullOr(Schema.String)),
  /** What an approval is bound to: the change and every entry version it saw. */
  changeHash: Schema.String,
  reason: Schema.String,
});
export type PersonalMemoryTidyChange = typeof PersonalMemoryTidyChange.Type;

/** One nightly (or preview) run of the memory tidy-up and what it changed: its changelog. */
export const PersonalMemoryTidyRun = Schema.Struct({
  runId: Schema.String,
  startedAt: Schema.DateTimeUtcFromString,
  finishedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  status: Schema.Literals(["running", "done", "failed"]),
  /** A preview: the changes were listed, not made. */
  dryRun: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  merged: Schema.Number,
  superseded: Schema.Number,
  /** Changes this run put on the approval list. */
  pending: Schema.optional(Schema.Number),
  leftAlone: Schema.Number,
  error: Schema.NullOr(Schema.String),
  changes: Schema.Array(PersonalMemoryTidyChange),
});
export type PersonalMemoryTidyRun = typeof PersonalMemoryTidyRun.Type;

export const PersonalMemoryTidyLogInput = Schema.Struct({
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
});
export type PersonalMemoryTidyLogInput = typeof PersonalMemoryTidyLogInput.Type;

/**
 * What the nightly tidy-up (03:30) does. preview: lists what it would change
 * and changes nothing (the default until the owner has reviewed one). on:
 * makes the changes. off: does not run.
 */
export const PersonalMemoryTidyMode = Schema.Literals(["off", "preview", "on"]);
export type PersonalMemoryTidyMode = typeof PersonalMemoryTidyMode.Type;

export const PersonalMemoryTidyLogResult = Schema.Struct({
  mode: PersonalMemoryTidyMode,
  runs: Schema.Array(PersonalMemoryTidyRun),
});
export type PersonalMemoryTidyLogResult = typeof PersonalMemoryTidyLogResult.Type;

export const PersonalMemoryTidySetModeInput = Schema.Struct({ mode: PersonalMemoryTidyMode });
export type PersonalMemoryTidySetModeInput = typeof PersonalMemoryTidySetModeInput.Type;

/** The owner's answer to a pending tidy-up change. */
export const PersonalMemoryTidyDecideInput = Schema.Struct({
  changeId: Schema.Number,
  approve: Schema.Boolean,
  /** The hash the card or list was showing; the tap is refused unless it is this change's. */
  changeHash: Schema.String,
});

/** An entry a bot's change would replace or forget, shown whole on the card. */
export const PersonalMemoryCardTarget = Schema.Struct({
  memoryId: PersonalMemoryId,
  kind: PersonalMemoryKind,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  content: Schema.String,
});
export type PersonalMemoryCardTarget = typeof PersonalMemoryCardTarget.Type;

/**
 * A bot's change to memory other bots see, as a Save / Don't save card in the
 * chat it happened in. Nothing applies until the owner taps Save.
 */
export const PersonalMemoryCard = Schema.Struct({
  changeId: Schema.Number,
  changeHash: Schema.String,
  threadId: Schema.String,
  action: Schema.Literals(["save", "forget"]),
  /** "bot:<id>". */
  proposedBy: Schema.NullOr(Schema.String),
  /** A save's new entry: its exact text, kind and reach. */
  content: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.Literals(["note", "preference"])),
  /** "bot": only the proposing bot will see it. */
  scope: Schema.NullOr(Schema.Literals(["shared", "team", "bot"])),
  scopeId: Schema.NullOr(Schema.String),
  /** A save's apps (slugs) when the rule is limited to some; null is global. */
  apps: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  /** The entries it replaces (save) or forgets (forget), whole, as they were proposed. */
  targets: Schema.Array(PersonalMemoryCardTarget),
  status: PersonalMemoryTidyChangeStatus,
  createdAt: Schema.DateTimeUtcFromString,
  decidedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalMemoryCard = typeof PersonalMemoryCard.Type;

export const PersonalMemoryCardsInput = Schema.Struct({ threadId: TrimmedNonEmptyString });
export type PersonalMemoryCardsInput = typeof PersonalMemoryCardsInput.Type;

export const PersonalMemoryCardsResult = Schema.Struct({
  cards: Schema.Array(PersonalMemoryCard),
});
export type PersonalMemoryCardsResult = typeof PersonalMemoryCardsResult.Type;
export type PersonalMemoryTidyDecideInput = typeof PersonalMemoryTidyDecideInput.Type;

/** Runs the tidy-up now. dryRun (the default) only lists what it would change. */
export const PersonalMemoryTidyRunInput = Schema.Struct({
  dryRun: Schema.optional(Schema.Boolean),
});
export type PersonalMemoryTidyRunInput = typeof PersonalMemoryTidyRunInput.Type;

/** Marks a note or task summary outdated or not relevant, or clears the mark. */
export const PersonalMemoryFeedbackInput = Schema.Struct({
  memoryId: PersonalMemoryId,
  signal: Schema.Literals(["outdated", "not_relevant", "clear"]),
});
export type PersonalMemoryFeedbackInput = typeof PersonalMemoryFeedbackInput.Type;

export const PersonalMemoryFeedbackResult = Schema.Struct({
  memoryId: PersonalMemoryId,
  /** The mark now, null when cleared. */
  signal: Schema.NullOr(PersonalMemoryFeedbackSignal),
});
export type PersonalMemoryFeedbackResult = typeof PersonalMemoryFeedbackResult.Type;

/** Which memory one assistant turn was given: the turn is named by the message that started it. */
export const PersonalMemoryTurnContextInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
});
export type PersonalMemoryTurnContextInput = typeof PersonalMemoryTurnContextInput.Type;

const TurnContextRule = Schema.Struct({
  memoryId: PersonalMemoryId,
  /** The rule as it reads now ("" when it is no longer current). */
  content: Schema.String,
  apps: Schema.NullOr(Schema.Array(Schema.String)),
  /** False when the rule has been replaced or forgotten since the turn. */
  current: Schema.Boolean,
});

/**
 * What a turn's memory block held and why, as recorded when the turn started:
 * the "Context used" view. Rules are looked up as they read now; notes and
 * summaries carry the snippet they had.
 */
export const PersonalMemoryTurnContext = Schema.Struct({
  messageId: Schema.String,
  createdAt: Schema.String,
  /** The apps the turn was about, and where each was found (title, message, recent, role, earlier). */
  apps: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      label: Schema.String,
      via: Schema.Array(Schema.String),
    }),
  ),
  rules: Schema.Struct({
    /** False on a reminder turn: the rules listed earlier in this chat still applied. */
    sent: Schema.Boolean,
    items: Schema.Array(TurnContextRule),
    /** Rules sent on top of the earlier list (a chat that started covering another app). */
    added: Schema.Array(PersonalMemoryId),
    /** "Matchday: 5 rules, CalTrack: 1 rule": the groups not listed. */
    index: Schema.NullOr(Schema.String),
    /** Rules of the turn's apps that did not fit the caps. */
    leftOut: Schema.Array(TurnContextRule),
  }),
  notes: Schema.Array(
    Schema.Struct({
      memoryId: PersonalMemoryId,
      kind: PersonalMemoryKind,
      snippet: Schema.String,
      /** Why it was picked: matched words, ageing, an app it names. */
      why: Schema.Array(Schema.String),
      score: Schema.Number,
      feedback: Schema.NullOr(PersonalMemoryFeedbackSignal),
      /** False when it has been replaced, forgotten or deleted since. */
      current: Schema.Boolean,
    }),
  ),
  leftOut: Schema.Array(
    Schema.Struct({
      memoryId: PersonalMemoryId,
      kind: PersonalMemoryKind,
      snippet: Schema.String,
      reason: Schema.String,
    }),
  ),
  query: Schema.Struct({
    terms: Schema.Array(Schema.String),
    /** The message alone said too little, so the chat's topic led the search. */
    followUp: Schema.Boolean,
  }),
});
export type PersonalMemoryTurnContext = typeof PersonalMemoryTurnContext.Type;

/** Share of a per-turn rule cap at which the Memory screen warns. */
export const PERSONAL_MEMORY_RULES_WARN_SHARE = 0.8;

/**
 * How full the most rules any bot can receive at once are, against the
 * per-turn caps. Computed with every app counted as active, the worst case.
 */
export const PersonalMemoryRulesUsageRow = Schema.Struct({
  botId: Schema.String,
  botName: Schema.String,
  /** Rules this bot can receive at once: global plus every app's. */
  entries: Schema.Number,
  chars: Schema.Number,
  globalRules: Schema.Number,
  appRules: Schema.Number,
  /** entries / maxEntries and chars / maxChars. */
  entryShare: Schema.Number,
  charShare: Schema.Number,
  /** The larger of the two shares. */
  share: Schema.Number,
  /** Rules that would not fit when every app is active: named, never silently dropped. */
  leftOut: Schema.Array(Schema.Struct({ memoryId: PersonalMemoryId, content: Schema.String })),
});
export type PersonalMemoryRulesUsageRow = typeof PersonalMemoryRulesUsageRow.Type;

export const PersonalMemoryRulesUsage = Schema.Struct({
  maxEntries: Schema.Number,
  maxChars: Schema.Number,
  warnShare: Schema.Number,
  /** ok: under the warning share. near: at or over it. over: some rules would not fit. */
  level: Schema.Literals(["ok", "near", "over"]),
  /** False when the kill switch makes every rule global. */
  scoping: Schema.Boolean,
  /** The fullest bots, fullest first (at most 3). */
  rows: Schema.Array(PersonalMemoryRulesUsageRow),
});
export type PersonalMemoryRulesUsage = typeof PersonalMemoryRulesUsage.Type;

export class PersonalMemoryError extends Schema.TaggedError<PersonalMemoryError>()(
  "PersonalMemoryError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The canned user turn behind "Wrapup". It lives here, beside the memory
 * contracts, because the server's save_memory consent guard reads the user's
 * own words: if this wording and that guard drift apart, wrapup silently
 * summarizes a chat and then refuses to store it, which is what shipped once.
 * A server test asserts the guard still accepts this exact string.
 */
export const WRAPUP_CHAT_PROMPT =
  "Wrap up this chat: summarize the key points, decisions and any preferences I expressed, then remember that summary with save_memory so future chats can find it. Keep the summary concise.";

/** An app a rule can be limited to: its slug is the name of its sheet in dev-team/apps. */
export interface PersonalMemoryApp {
  readonly slug: string;
  /** How it is named in the index line and on the Memory screen. */
  readonly label: string;
  /** Other names the owner and the bots use for it. */
  readonly aliases: ReadonlyArray<string>;
}

export const PERSONAL_MEMORY_APPS: ReadonlyArray<PersonalMemoryApp> = [
  { slug: "matchday", label: "Matchday", aliases: ["matchday"] },
  { slug: "caltrack", label: "CalTrack", aliases: ["caltrack", "cal track"] },
  { slug: "rainhb", label: "rainhb", aliases: ["rainhb", "rain hb"] },
  {
    slug: "gymming-ironflow",
    label: "IronFlow",
    aliases: ["ironflow", "iron flow", "gymming", "irongymm", "gymming-ironflow"],
  },
  { slug: "coachbuild", label: "CoachBuild", aliases: ["coachbuild", "coach build"] },
  {
    slug: "tennis-poll",
    label: "tennis-poll",
    aliases: ["tennis-poll", "tennis poll", "tennispoll"],
  },
  {
    slug: "personal-bots",
    label: "hbots",
    aliases: ["hbots", "personal-bots", "personal bots", "bots app", "the bots app"],
  },
  { slug: "homegym", label: "HomeGym", aliases: ["homegym", "home gym"] },
  {
    slug: "tennisstringrec",
    label: "StringFit",
    aliases: ["stringfit", "string fit", "tennisstringrec", "tennis string rec"],
  },
  { slug: "credittracker", label: "CreditTracker", aliases: ["credittracker", "credit tracker"] },
  { slug: "sofamatch", label: "sofamatch", aliases: ["sofamatch", "sofa match"] },
  { slug: "splitmoney", label: "splitmoney", aliases: ["splitmoney", "split money"] },
  { slug: "shutterbook", label: "shutterbook", aliases: ["shutterbook"] },
  { slug: "pianotut", label: "pianoTut", aliases: ["pianotut", "piano tut"] },
];

/** An app's display name; an unregistered slug reads as itself. */
export const personalMemoryAppLabel = (slug: string): string =>
  PERSONAL_MEMORY_APPS.find((app) => app.slug === slug)?.label ?? slug;
