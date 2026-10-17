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
 * 20, was 12 until 1.66.62: a full re-send of the ~46 rules costs 10-12k chars,
 * and the one-line reminder in between carries the same standing rules, so the
 * extra eight turns of reminders are cheaper than eight more full lists.
 */
export const PERSONAL_MEMORY_RESEND_EVERY_TURNS = 20;
/**
 * Standing preferences in one turn at most, newest first. Harout's rules live
 * as preferences, and a rule only picked when its words matched the message
 * was missed (a 25 Sep release-check rule did not surface on 1 Oct), so they
 * are all included up to these caps, oldest dropped first and logged.
 */
export const PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES = 60;
export const PERSONAL_MEMORY_PREFERENCE_MAX_CHARS = 15_000;
/**
 * How much of a note or a task summary one memory line carries, 300 since
 * 1.66.62 (was 500). A preference is never clipped: cutting a rule short can
 * drop the rule itself, so the cap is notes and summaries only (see
 * `memoryLine` in `memoryBlock.ts`).
 */
export const BLOCK_ENTRY_MAX_CHARS = 300;
export const SUMMARY_MAX_CHARS = 600;
/**
 * Most characters one `search_memory` result may carry, keeping the best
 * matches first (app-scoped rules the query named come first and count against
 * it). A CTO search returned 21.7k chars into a fresh chat on 17 Oct.
 */
export const PERSONAL_MEMORY_SEARCH_MAX_CHARS = 6_000;
/**
 * Kill switch for that cap: `T3CODE_PERSONAL_MEMORY_SEARCH_MAX_CHARS` (the
 * `PERSONAL_` spelling works too) takes a positive whole number of characters,
 * or `off` / `0` / `false` / `no` / `disabled` to return every match as before.
 * Anything else falls back to the default. Read on every call.
 */
export const memorySearchMaxChars = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = (env.T3CODE_PERSONAL_MEMORY_SEARCH_MAX_CHARS ?? env.PERSONAL_MEMORY_SEARCH_MAX_CHARS)
    ?.trim()
    .toLowerCase();
  if (raw === undefined || raw.length === 0) return PERSONAL_MEMORY_SEARCH_MAX_CHARS;
  if (["off", "0", "false", "no", "disabled"].includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : PERSONAL_MEMORY_SEARCH_MAX_CHARS;
};

/**
 * Keeps the leading entries whose JSON fits `maxChars` and counts the rest.
 * The first entry is always kept, so a single oversized match still reaches the
 * bot. `maxChars` of 0 or less keeps everything (the kill switch).
 */
export function capByJsonChars<T>(
  entries: ReadonlyArray<T>,
  maxChars: number,
): { readonly entries: ReadonlyArray<T>; readonly dropped: number } {
  if (maxChars <= 0 || entries.length === 0) return { entries, dropped: 0 };
  const kept: Array<T> = [];
  let used = 2; // the surrounding []
  for (const entry of entries) {
    const size = JSON.stringify(entry)?.length ?? 0;
    if (kept.length > 0 && used + size + 1 > maxChars) break;
    kept.push(entry);
    used += size + 1;
  }
  return { entries: kept, dropped: entries.length - kept.length };
}

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
  temporalKind: Schema.NullOr(Schema.String),
  observedAt: Schema.NullOr(Schema.String),
  verifiedAt: Schema.NullOr(Schema.String),
  evidenceJson: Schema.NullOr(Schema.String),
  originThreadId: Schema.NullOr(Schema.String),
  originMessageId: Schema.NullOr(Schema.String),
  conflict: Schema.NullOr(Schema.String),

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
  m.temporal_kind AS "temporalKind",
  m.observed_at AS "observedAt",
  m.verified_at AS "verifiedAt",
  m.evidence_json AS "evidenceJson",
  m.origin_thread_id AS "originThreadId",
  m.origin_message_id AS "originMessageId",
  m.conflict AS "conflict",

  (SELECT f.signal FROM personal_memory_feedback f WHERE f.memory_id = m.memory_id) AS "demotedSignal"
`;

export interface PersonalMemorySaveInput {
  readonly temporalKind?: "stable" | "historical" | "changing" | undefined;
  readonly observedAt?: string | undefined;
  readonly verifiedAt?: string | undefined;
  readonly evidence?: ReadonlyArray<string> | undefined;
  readonly originThreadId?: string | undefined;
  readonly originMessageId?: string | undefined;
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
