// Shared parts of the memory service: the per-turn limits, how rows are decoded, the save and proposal types and
// the reasons an entry is archived. Every memory module imports from here; PersonalMemoryService.ts re-exports
// what it always exported.
import * as Schema from "effect/Schema";

import {
  PersonalMemoryError,
  PersonalMemoryId,
  PersonalMemoryKind,
  PersonalMemoryScope,
  type PersonalBotId,
  type PersonalMemoryEntry,
  type ThreadId,
} from "@t3tools/contracts";

/** Default result count for a memory search (the search_memory tool). */
export const PERSONAL_MEMORY_RETRIEVAL_LIMIT = 8;
/**
 * Notes and task summaries picked by relevance for one turn, each with its own
 * quota so a long run of task summaries cannot crowd notes out. Preferences
 * are not counted here: every one the bot can see is always included.
 */
export const PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT = 6;
export const PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT = 6;
export const PERSONAL_MEMORY_CONTEXT_RELEVANT_LIMIT =
  PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT + PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT;
/**
 * A relevant entry must score at least this share of the best match's bm25
 * score: one shared common word is not relevance.
 */
export const PERSONAL_MEMORY_SCORE_FLOOR = 0.2;
/** How much of a turn's text picks its notes and task summaries. */
export const PERSONAL_MEMORY_QUERY_MAX_CHARS = 8_000;
/**
 * The full preference list goes to a session once, then again only when the
 * set changed, after the provider compacted the chat, or every this many turns.
 */
export const PERSONAL_MEMORY_RESEND_EVERY_TURNS = 12;
/**
 * Standing preferences in one turn at most, newest first. Harout's rules live
 * as preferences, and a rule only picked when its words matched the message
 * was missed (a 25 Sep release-check rule did not surface on 1 Oct), so they
 * are all included up to these caps, oldest dropped first and logged.
 */
export const PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES = 60;
export const PERSONAL_MEMORY_PREFERENCE_MAX_CHARS = 15_000;
export const BLOCK_ENTRY_MAX_CHARS = 500;
export const SUMMARY_MAX_CHARS = 600;

/** Most apps one session's chat can have been about. */
export const STICKY_APPS_MAX = 8;

export const MemoryDbRow = Schema.Struct({
  memoryId: PersonalMemoryId,
  scope: PersonalMemoryScope,
  scopeId: Schema.NullOr(Schema.String),
  kind: PersonalMemoryKind,
  content: Schema.String,
  source: Schema.String,
  sensitivity: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  version: Schema.Number,
  supersededAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  supersededBy: Schema.NullOr(PersonalMemoryId),
  supersededReason: Schema.NullOr(Schema.String),
  appsJson: Schema.NullOr(Schema.String),
  demotedSignal: Schema.NullOr(Schema.Literals(["outdated", "not_relevant"])),
});
export const decodeMemoryRow = Schema.decodeUnknownEffect(MemoryDbRow);
export const encodeMemoryIds = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
export const encodeVersions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);
export const isMemoryError = Schema.is(PersonalMemoryError);

/** A failure's `_tag` when it has one, for a log line that names the kind of error. */
export const errorTagOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : "UnknownError";

export const MEMORY_COLUMNS = `
  m.memory_id AS "memoryId",
  m.scope AS "scope",
  m.scope_id AS "scopeId",
  m.kind AS "kind",
  m.content AS "content",
  m.source AS "source",
  m.sensitivity AS "sensitivity",
  m.created_at AS "createdAt",
  m.updated_at AS "updatedAt",
  m.version AS "version",
  m.superseded_at AS "supersededAt",
  m.superseded_by AS "supersededBy",
  m.superseded_reason AS "supersededReason",
  m.apps_json AS "appsJson",
  (SELECT f.signal FROM personal_memory_feedback f WHERE f.memory_id = m.memory_id) AS "demotedSignal"
`;

export interface PersonalMemorySaveInput {
  readonly scope: PersonalMemoryScope;
  readonly scopeId: string | null;
  readonly kind: "note" | "preference";
  readonly content: string;
  readonly source: string;
  /** Apps a preference is limited to (slugs); null or absent is global. Ignored for notes. */
  readonly apps?: ReadonlyArray<string> | null | undefined;
  /**
   * Entries this one replaces: they are superseded by it, kept for Restore
   * and never given to a bot again.
   */
  readonly replaces?: ReadonlyArray<PersonalMemoryId> | undefined;
  /**
   * The bot saving it. A bot may replace only entries it can see (shared, or
   * its own), and a bot-only entry may replace only that bot's entries: a
   * private save must not hide a shared fact from every other bot.
   */
  readonly actorBotId?: PersonalBotId | undefined;
  /** The saving bot's team: team entries it can see and replace. */
  readonly actorTeam?: string | undefined;
}

export const FORGOTTEN_REASON = "Forgotten at the user's request.";
/** Why a note a bot forgot on its own was archived. */
export const NOTE_FORGOTTEN_REASON = "Forgotten by a bot (a note it found out of date).";
/** Why a rule was archived at the owner's word in a chat; only this does a rule's Undo bring back. */
export const RULE_FORGOTTEN_REASON = "Forgotten by a bot at the user's word.";
/** Why a save's replace archived an entry; only these does a note's Undo bring back. */
export const REPLACED_REASON = "Replaced by a newer save.";
/** Why a note was archived from its chat line's Undo. */
export const UNDONE_REASON = "Undone from the chat.";

/** A bot's memory write waiting for the owner's tap. */
export type PersonalMemoryProposal =
  | {
      readonly action: "save";
      readonly botId: PersonalBotId;
      /** The chat the card is shown in; null puts it on the approval list only. */
      readonly threadId: ThreadId | null;
      readonly kind: "note" | "preference";
      /** "bot": a preference only the proposing bot will follow (scopeId is that bot). */
      readonly scope: "shared" | "team" | "bot";
      readonly scopeId: string | null;
      readonly content: string;
      /** Apps a preference is limited to; null or absent is global. */
      readonly apps?: ReadonlyArray<string> | null | undefined;
      readonly replaces: ReadonlyArray<PersonalMemoryEntry>;
      readonly reason: string;
    }
  | {
      readonly action: "forget";
      readonly botId: PersonalBotId;
      readonly threadId: ThreadId | null;
      readonly target: PersonalMemoryEntry;
      readonly reason: string;
    };

/** Pending bot proposals one bot may have at a time. */
export const PERSONAL_MEMORY_MAX_PENDING_PER_BOT = 20;

/** A saved entry close to a new one, with how alike they are (0 to 1). */
/** What a save hands back: the entry, and whether this call made it. */
export type PersonalMemorySaved = PersonalMemoryEntry & {
  readonly created?: boolean;
  /**
   * The entries this save archived (as they are now): a replacement into an entry
   * that already existed still changes them, so the chat shows an Undo for each.
   */
  readonly archived?: ReadonlyArray<PersonalMemoryEntry>;
};

export interface PersonalMemoryMatch {
  readonly entry: PersonalMemoryEntry;
  readonly similarity: number;
}

export interface PersonalMemoryScopeFilter {
  readonly botId?: PersonalBotId | undefined;
  readonly projectId?: string | undefined;
  /** Leaves task summaries out before ranking, so the limit fills with other kinds. */
  readonly excludeTaskSummaries?: boolean | undefined;
  /** Leaves preferences out: a turn's context lists them all separately. */
  readonly excludePreferences?: boolean | undefined;
  /** Only this kind (a turn's per-kind quotas). */
  readonly onlyKind?: PersonalMemoryKind | undefined;
  /** Rarest terms first, and drop matches far weaker than the best (a turn's pick). */
  readonly ranked?: boolean | undefined;
}

/** A LIKE pattern for text that may hold % or _: `!` is the escape character. */
export const escapeLike = (text: string): string => text.replace(/[!%_]/g, (char) => `!${char}`);
