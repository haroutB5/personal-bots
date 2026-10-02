import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_MEMORY_MAX_LENGTH,
  PersonalMemoryError,
  PersonalMemoryId,
  PersonalMemoryKind,
  PersonalMemoryScope,
  type PersonalBotId,
  type PersonalMemoryEntry,
  type PersonalMemoryListInput,
  type PersonalMemorySearchInput,
  type PersonalMemoryUpdateInput,
  type PersonalTask,
  type ThreadId,
} from "@t3tools/contracts";

import { forkParked } from "../../serverActivation.ts";
import {
  makeSensitiveExposureStore,
  rootExposureKey,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import {
  localDay,
  memorySimilarity,
  SIMILAR_MEMORY_THRESHOLD,
  entrySnapshotsJson,
} from "./memoryTidy.ts";

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
const BLOCK_ENTRY_MAX_CHARS = 500;
const SUMMARY_MAX_CHARS = 600;

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(?:password|passwd|passcode|pwd|pin code|secret|api[_ -]?key|access[_ -]?key|auth[_ -]?token|token|bearer|private[_ -]?key|client[_ -]?secret)\b\s*(?:is|=|:)\s*\S+/i,
];

/**
 * The text with anything credential-shaped replaced by "[redacted]": for
 * reasons, errors and file names the app stores or shows beside memory.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`),
      "[redacted]",
    );
  }
  return out.replace(/[A-Za-z0-9+/_=-]{40,}/g, (token) =>
    /[A-Za-z]/.test(token) && /\d/.test(token) ? "[redacted]" : token,
  );
}

/**
 * True when text looks like it carries a credential. Memory never stores
 * secrets: the secret store is the only place for those.
 */
export function looksLikeSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // A long unbroken token mixing letters and digits reads as a key.
  for (const token of text.match(/[A-Za-z0-9+/_=-]{40,}/g) ?? []) {
    if (/[A-Za-z]/.test(token) && /\d/.test(token)) return true;
  }
  return false;
}

const STOP_WORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my no not of on or our please should so than that the their them then there these they this to up us was we were what when where which who why will with would you your".split(
    " ",
  ),
);

/** A message's searchable words, in order, once each. */
export function memoryQueryTerms(text: string): ReadonlyArray<string> {
  const terms: Array<string> = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
    if (STOP_WORDS.has(raw) || terms.includes(raw)) continue;
    terms.push(raw);
  }
  return terms;
}

/**
 * Turns free text into an FTS5 OR query of quoted terms; null when nothing is
 * searchable. With `documentFrequency` (how many entries hold each term), the
 * 16 rarest terms that appear in memory at all are used, not the first 16 of
 * the message: a long brief no longer spends its terms on words every entry has.
 */
export function buildMemoryMatchQuery(
  text: string,
  documentFrequency?: ReadonlyMap<string, number>,
): string | null {
  const all = memoryQueryTerms(text);
  const terms =
    documentFrequency === undefined
      ? all.slice(0, 16)
      : all
          .filter((term) => (documentFrequency.get(term) ?? 0) > 0)
          .toSorted((a, b) => documentFrequency.get(a)! - documentFrequency.get(b)!)
          .slice(0, 16);
  if (terms.length === 0) return null;
  // Quoting neutralises FTS syntax; a trailing * matches plurals and stems.
  return terms.map((term) => (term.length >= 4 ? `"${term}"*` : `"${term}"`)).join(" OR ");
}

const KIND_LABEL: Record<PersonalMemoryKind, string> = {
  note: "note",
  preference: "preference",
  task_summary: "task summary",
};

/** The day an entry was saved, as YYYY-MM-DD in the server's time zone. */
export const memoryDay = (entry: Pick<PersonalMemoryEntry, "createdAt">) =>
  localDay(DateTime.toEpochMillis(entry.createdAt));

/** The short id a bot sees in its memory block and may pass back (replaces, forget_memory). */
export const memoryRef = (entry: Pick<PersonalMemoryEntry, "memoryId">) =>
  entry.memoryId.slice(0, 8);

/** Shortens long text at a sentence (or failing that a word) boundary, never mid-word. */
export function clipAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("; "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf("\n"),
  );
  if (sentence >= maxChars * 0.5) return `${head.slice(0, sentence + 1).trimEnd()} [...]`;
  const word = head.lastIndexOf(" ");
  return `${(word > 0 ? head.slice(0, word) : head).trimEnd()} [...]`;
}

export const MEMORY_BLOCK_HEADER =
  "Known facts (from memory), added by the app; the user did not type them. When these disagree with something else, the order is: the app's rules and your own bot instructions first, then the user's current message, then the saved preferences below, then notes. Preferences are the user's standing instructions, oldest first; where two conflict, the later-saved one wins. Each line shows [day saved · id]: to change one, call save_memory with replaces: [id]; to drop one the user no longer wants, call forget_memory with its id. Notes and task summaries were picked for this message and may be out of date; task summaries record past work and are not preferences.";

const memoryLine = (entry: PersonalMemoryEntry) => {
  // A preference is a rule; cutting it short can drop the rule itself.
  const content =
    entry.kind === "preference"
      ? entry.content
      : clipAtSentence(entry.content, BLOCK_ENTRY_MAX_CHARS);
  return `- [${KIND_LABEL[entry.kind]}] [${memoryDay(entry)} · ${memoryRef(entry)}] ${content.replace(/\s+/g, " ")}`;
};

/**
 * The block put in front of a bot's turn: it travels with the user's message,
 * so it says who wrote it. `preferencesRepeat` replaces the preference list
 * with one line when this session already has the same list.
 */
export function formatMemoryBlock(input: {
  readonly preferences: ReadonlyArray<PersonalMemoryEntry>;
  readonly relevant: ReadonlyArray<PersonalMemoryEntry>;
  /** Older preferences left out by the caps. */
  readonly droppedPreferences?: number | undefined;
  readonly preferencesRepeat?: { readonly count: number } | undefined;
}): string | null {
  const lines: Array<string> = [];
  if (input.preferencesRepeat !== undefined) {
    lines.push(
      `- The ${input.preferencesRepeat.count} saved preferences listed earlier in this chat still apply unchanged; none were added, replaced or forgotten since.`,
    );
  } else {
    lines.push(...input.preferences.map(memoryLine));
    if ((input.droppedPreferences ?? 0) > 0) {
      lines.push(
        `- ${input.droppedPreferences} older preferences are not shown here (too many to list); use search_memory to find them.`,
      );
    }
  }
  lines.push(...input.relevant.map(memoryLine));
  if (lines.length === 0) return null;
  return [MEMORY_BLOCK_HEADER, ...lines].join("\n");
}

const MemoryDbRow = Schema.Struct({
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
});
const decodeMemoryRow = Schema.decodeUnknownEffect(MemoryDbRow);
const encodeMemoryIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeVersions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);
const isMemoryError = Schema.is(PersonalMemoryError);

const MEMORY_COLUMNS = `
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
  m.superseded_reason AS "supersededReason"
`;

export interface PersonalMemorySaveInput {
  readonly scope: PersonalMemoryScope;
  readonly scopeId: string | null;
  readonly kind: "note" | "preference";
  readonly content: string;
  readonly source: string;
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

const FORGOTTEN_REASON = "Forgotten at the user's request.";

/** How widely a scope reaches; a save may not replace a wider entry than itself. */
const SCOPE_REACH: Record<PersonalMemoryScope, number> = {
  bot: 1,
  project: 1,
  team: 2,
  shared: 3,
};

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

/** Same text, ignoring case and spacing: one rule saved in two scopes is listed once. */
const dedupeKey = (content: string) => content.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The newest preferences that fit the caps. Entries come newest first; once
 * one does not fit, it and every older one are dropped (a shorter older rule
 * never jumps the queue), and the kept ones are returned oldest first.
 */
export function capPreferences(entries: ReadonlyArray<PersonalMemoryEntry>): {
  readonly kept: ReadonlyArray<PersonalMemoryEntry>;
  readonly dropped: number;
} {
  const kept: Array<PersonalMemoryEntry> = [];
  const seen = new Set<string>();
  let chars = 0;
  let dropped = 0;
  let full = false;
  for (const entry of entries) {
    const key = dedupeKey(entry.content);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      full ||
      kept.length >= PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES ||
      chars + entry.content.length > PERSONAL_MEMORY_PREFERENCE_MAX_CHARS
    ) {
      full = true;
      dropped += 1;
      continue;
    }
    kept.push(entry);
    chars += entry.content.length;
  }
  return { kept: kept.toReversed(), dropped };
}

export class PersonalMemoryService extends Context.Service<
  PersonalMemoryService,
  {
    readonly list: (
      input: PersonalMemoryListInput,
    ) => Effect.Effect<ReadonlyArray<PersonalMemoryEntry>, PersonalMemoryError>;
    readonly search: (
      input: PersonalMemorySearchInput & PersonalMemoryScopeFilter,
    ) => Effect.Effect<ReadonlyArray<PersonalMemoryEntry>, PersonalMemoryError>;
    readonly save: (
      input: PersonalMemorySaveInput,
    ) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    readonly update: (
      input: PersonalMemoryUpdateInput,
    ) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    readonly remove: (input: {
      readonly memoryId: PersonalMemoryId;
    }) => Effect.Effect<void, PersonalMemoryError>;
    /**
     * A bot was asked to forget an entry: it is archived (superseded with no
     * successor), so bots stop receiving it and the owner can still restore it.
     */
    readonly forget: (input: {
      readonly memoryId: PersonalMemoryId;
      readonly actorBotId: PersonalBotId;
    }) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * The full id for one a bot quoted: a full id, or the short id from its
     * memory block, among entries that bot can see. Fails when unknown or
     * ambiguous.
     */
    readonly resolveRef: (input: {
      readonly ref: string;
      readonly botId: PersonalBotId;
    }) => Effect.Effect<PersonalMemoryId, PersonalMemoryError>;
    /**
     * The owner's own recent messages in a thread (not task briefs, routine
     * prompts, group relays or server notices, which are all written by the
     * app or a bot), newest first, and whether the owner started the thread.
     * save_memory checks a bot's quoted userRequest against these.
     */
    readonly ownerMessages: (threadId: ThreadId) => Effect.Effect<{
      readonly startedByOwner: boolean;
      readonly texts: ReadonlyArray<string>;
      /** The user-role message that started the current turn, and whether the owner wrote it. */
      readonly current: { readonly text: string; readonly byOwner: boolean } | null;
    }>;
    /** One entry, current or archived (not deleted). */
    readonly get: (
      memoryId: PersonalMemoryId,
    ) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * Puts a bot's save or forget on the owner's approval list instead of
     * applying it. Returns the change id.
     */
    readonly propose: (input: PersonalMemoryProposal) => Effect.Effect<number, PersonalMemoryError>;
    /** The team a bot is on, for team-scoped saves. */
    readonly teamOfBot: (botId: PersonalBotId) => Effect.Effect<string | null>;
    /** Brings a superseded entry back: bots receive it again. */
    readonly restore: (input: {
      readonly memoryId: PersonalMemoryId;
    }) => Effect.Effect<PersonalMemoryEntry, PersonalMemoryError>;
    /**
     * Current notes and preferences a bot can see that read like the same
     * subject as `content`, closest first: save_memory hands them back so the
     * bot can replace one instead of adding a twin.
     */
    readonly similar: (input: {
      readonly content: string;
      readonly botId: PersonalBotId;
      readonly excludeIds?: ReadonlyArray<PersonalMemoryId> | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<ReadonlyArray<PersonalMemoryMatch>, PersonalMemoryError>;
    /** The bot of a personal-bot thread, or none for ordinary T3 threads. */
    readonly botForThread: (threadId: ThreadId) => Effect.Effect<Option.Option<PersonalBotId>>;
    /**
     * Memory for a turn on a personal-bot thread (shared + that bot, + the
     * project when given), formatted as context for that turn: every
     * preference (capped), then the notes and task summaries relevant to it.
     * `record` logs the ids against the thread's active task attempt.
     * `excludeTaskSummaries` is set for task and routine turns: a task's
     * objective must not carry the bot's summaries of unrelated past tasks.
     */
    readonly contextForThread: (input: {
      readonly threadId: ThreadId;
      readonly query: string;
      readonly projectId?: string | undefined;
      readonly record: boolean;
      readonly excludeTaskSummaries?: boolean | undefined;
      /**
       * The provider session this turn runs in. Given: the full preference
       * list is sent once per session and again only when it changed, after
       * the chat was compacted, or every few turns. Absent: always in full.
       */
      readonly session?: { readonly key: string; readonly fresh: boolean } | undefined;
    }) => Effect.Effect<{
      readonly block: string | null;
      readonly memoryIds: ReadonlyArray<PersonalMemoryId>;
    }>;
    /**
     * The provider accepted the turn contextForThread last built for this
     * thread: only now does that session count as having the preference list
     * (or one more reminder turn). A send that failed leaves the full list due.
     */
    readonly confirmPreferencesSent: (threadId: ThreadId) => Effect.Effect<void>;
    /** Stores a labelled summary of a completed task (idempotent per task). */
    readonly saveTaskSummary: (task: PersonalTask) => Effect.Effect<void>;
    /** Saves task summaries as tasks complete. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/personal/memory/PersonalMemoryService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const exposures = makeSensitiveExposureStore(sql);
  const tasks = yield* Effect.serviceOption(PersonalTaskService.PersonalTaskService);

  const fail = (message: string, cause?: unknown) =>
    new PersonalMemoryError({ message, ...(cause === undefined ? {} : { cause }) });

  const storageFailure =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersonalMemoryError, R> =>
      effect.pipe(
        Effect.mapError((cause) =>
          isMemoryError(cause) ? cause : fail(`Personal memory ${operation} failed.`, cause),
        ),
      );

  const decodeAll = (rows: ReadonlyArray<unknown>) =>
    Effect.forEach(rows, (row) => decodeMemoryRow(row));

  /** Current or superseded; never a deleted one. */
  const readEntry = (memoryId: PersonalMemoryId) =>
    sql`
      SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
      WHERE m.memory_id = ${memoryId} AND m.deleted_at IS NULL
    `.pipe(
      Effect.flatMap(decodeAll),
      Effect.flatMap((entries) =>
        entries[0] === undefined
          ? Effect.fail(fail(`Memory '${memoryId}' was not found.`))
          : Effect.succeed(entries[0]),
      ),
    );

  const rejectUnsafe = (content: string) => {
    if (content.trim().length === 0) return Effect.fail(fail("Memory content is empty."));
    if (content.length > PERSONAL_MEMORY_MAX_LENGTH) {
      return Effect.fail(
        fail(`Memory entries are limited to ${PERSONAL_MEMORY_MAX_LENGTH} characters.`),
      );
    }
    if (looksLikeSecret(content)) {
      return Effect.fail(
        fail(
          "This looks like a password, token or key. Memory never stores secrets; use a secret request instead.",
        ),
      );
    }
    return Effect.void;
  };

  const scopeCondition = (filter: PersonalMemoryScopeFilter) => {
    if (filter.botId === undefined && filter.projectId === undefined) return sql`1 = 1`;
    const allowed = [
      sql`m.scope = 'shared'`,
      filter.botId === undefined
        ? undefined
        : sql`(m.scope = 'bot' AND m.scope_id = ${filter.botId})`,
      filter.botId === undefined
        ? undefined
        : sql`(m.scope = 'team' AND lower(m.scope_id) = (
            SELECT lower(b.team) FROM personal_bots b WHERE b.bot_id = ${filter.botId}
          ))`,
      filter.projectId === undefined
        ? undefined
        : sql`(m.scope = 'project' AND m.scope_id = ${filter.projectId})`,
    ].filter((condition) => condition !== undefined);
    return sql.or(allowed);
  };

  const list: PersonalMemoryService["Service"]["list"] = (input) => {
    const conditions = [
      sql`m.deleted_at IS NULL`,
      input.status === "superseded"
        ? sql`m.superseded_at IS NOT NULL`
        : sql`m.superseded_at IS NULL`,
      input.scope === undefined ? undefined : sql`m.scope = ${input.scope}`,
      input.scopeId === undefined ? undefined : sql`m.scope_id = ${input.scopeId}`,
      input.kind === undefined ? undefined : sql`m.kind = ${input.kind}`,
    ].filter((condition) => condition !== undefined);
    return sql`
      SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
      WHERE ${sql.and(conditions)}
      ORDER BY m.updated_at DESC, m.seq DESC
      LIMIT 500
    `.pipe(Effect.flatMap(decodeAll), storageFailure("list"));
  };

  /** How many entries hold each term (or a word it starts), from the FTS vocabulary. */
  const documentFrequency = (terms: ReadonlyArray<string>) =>
    terms.length === 0
      ? Effect.succeed(new Map<string, number>())
      : sql<{ readonly term: string; readonly df: number }>`
          SELECT q.value AS "term", COALESCE(SUM(v.doc), 0) AS "df"
          FROM json_each(${encodeMemoryIds(terms)}) q
          LEFT JOIN personal_memory_fts_vocab v
            ON v.term >= q.value AND v.term < q.value || char(1114111)
          GROUP BY q.value
        `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.term, row.df]))));

  const search: PersonalMemoryService["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const frequency =
        input.ranked === true
          ? yield* documentFrequency(memoryQueryTerms(input.query).slice(0, 200))
          : undefined;
      const match = buildMemoryMatchQuery(input.query, frequency);
      if (match === null) return [];
      const rows = yield* sql<{ readonly score: number }>`
        SELECT ${sql.literal(MEMORY_COLUMNS)}, bm25(personal_memory_fts) AS "score"
        FROM personal_memory_fts f
        JOIN personal_memory m ON m.seq = f.rowid
        WHERE personal_memory_fts MATCH ${match}
          AND m.deleted_at IS NULL
          AND m.superseded_at IS NULL
          AND ${scopeCondition(input)}
          AND ${input.excludeTaskSummaries === true ? sql`m.kind <> 'task_summary'` : sql`1 = 1`}
          AND ${input.excludePreferences === true ? sql`m.kind <> 'preference'` : sql`1 = 1`}
          AND ${input.onlyKind === undefined ? sql`1 = 1` : sql`m.kind = ${input.onlyKind}`}
        ORDER BY bm25(personal_memory_fts) ASC, m.updated_at DESC
        LIMIT ${input.limit ?? PERSONAL_MEMORY_RETRIEVAL_LIMIT}
      `;
      // bm25 is negative, best first: keep what scores within the floor of the best.
      const best = rows[0]?.score ?? 0;
      const kept =
        input.ranked === true
          ? rows.filter((row) => row.score <= best * PERSONAL_MEMORY_SCORE_FLOOR)
          : rows;
      return yield* decodeAll(kept);
    }).pipe(storageFailure("search"));

  const ownerMessages: PersonalMemoryService["Service"]["ownerMessages"] = (threadId) =>
    Effect.gen(function* () {
      // App-written user-role messages all carry a "personal-" id (task and
      // steer briefs, routine runs, group relays, notices, lead answers).
      const recent = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user' AND message_id NOT LIKE 'personal-%'
        ORDER BY created_at DESC LIMIT 30
      `;
      const first = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user'
        ORDER BY created_at ASC LIMIT 1
      `;
      // The message that started the turn running now, not just the newest
      // one: a message queued during a task turn has not started anything.
      const latest = yield* sql<{ readonly messageId: string; readonly text: string }>`
        SELECT m.message_id AS "messageId", m.text AS "text"
        FROM projection_thread_sessions s
        JOIN projection_turns t ON t.thread_id = s.thread_id AND t.turn_id = s.active_turn_id
        JOIN projection_thread_messages m ON m.message_id = t.pending_message_id
        WHERE s.thread_id = ${threadId} AND m.role = 'user'
        LIMIT 1
      `;
      return {
        startedByOwner: first[0] !== undefined && !first[0].messageId.startsWith("personal-"),
        texts: recent.map((row) => row.text),
        current:
          latest[0] === undefined
            ? null
            : { text: latest[0].text, byOwner: !latest[0].messageId.startsWith("personal-") },
      };
    }).pipe(Effect.orElseSucceed(() => ({ startedByOwner: false, texts: [], current: null })));

  const get: PersonalMemoryService["Service"]["get"] = (memoryId) =>
    readEntry(memoryId).pipe(storageFailure("read"));

  const propose: PersonalMemoryService["Service"]["propose"] = (input) =>
    Effect.gen(function* () {
      if (input.action === "save") yield* rejectUnsafe(input.content.trim());
      if (input.action === "save" && input.scope === "bot" && input.scopeId !== input.botId) {
        return yield* fail("A bot-only entry can only be proposed for the bot itself.");
      }
      const proposedBy = `bot:${input.botId}`;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const day = localDay(DateTime.toEpochMillis(now));
      const runId = `bot-proposals-${day}`;
      yield* sql`
        INSERT OR IGNORE INTO personal_memory_tidy_runs
          (run_id, started_at, finished_at, status, dry_run, nightly, model)
        VALUES (${runId}, ${nowIso}, ${nowIso}, 'done', 1, 0, ${`proposals: from bots, ${day}`})
      `;
      const targets = input.action === "save" ? input.replaces : [input.target];
      const versions = Object.fromEntries(targets.map((entry) => [entry.memoryId, entry.version]));
      // One statement checks the cap and inserts, so concurrent calls cannot
      // both see room for one more.
      const inserted = yield* sql<{ readonly id: number }>`
        INSERT INTO personal_memory_tidy_changes (
          run_id, status, action, scope, scope_id, memory_ids_json, result_memory_id, content,
          to_kind, to_scope, to_scope_id, versions_json, proposed_by, thread_id, reason, created_at,
          entry_snapshots_json
        )
        SELECT
          ${runId}, 'pending', ${input.action},
          ${input.action === "save" ? input.scope : input.target.scope},
          ${input.action === "save" ? input.scopeId : input.target.scopeId},
          ${encodeMemoryIds(targets.map((entry) => entry.memoryId))}, NULL,
          ${input.action === "save" ? input.content.trim() : null},
          ${input.action === "save" ? input.kind : null},
          ${input.action === "save" ? input.scope : null},
          ${input.action === "save" ? input.scopeId : null},
          ${encodeVersions(versions)}, ${proposedBy}, ${input.threadId},
          ${redactSecrets(input.reason).slice(0, 600)},
          ${nowIso},
          ${entrySnapshotsJson(targets)}
        WHERE (
          SELECT COUNT(*) FROM personal_memory_tidy_changes
          WHERE status = 'pending' AND proposed_by = ${proposedBy}
        ) < ${PERSONAL_MEMORY_MAX_PENDING_PER_BOT}
        RETURNING change_id AS "id"
      `;
      const id = inserted;
      if (id[0] === undefined) {
        return yield* fail(
          "Not proposed: you already have many memory changes waiting for the user's OK. Tell the user instead.",
        );
      }
      yield* sql`
        UPDATE personal_memory_tidy_runs
        SET pending = (SELECT COUNT(*) FROM personal_memory_tidy_changes
          WHERE run_id = ${runId} AND status = 'pending')
        WHERE run_id = ${runId}
      `;
      return id[0]!.id;
    }).pipe(storageFailure("propose"));

  const teamOfBot: PersonalMemoryService["Service"]["teamOfBot"] = (botId) =>
    sql<{ readonly team: string | null }>`
      SELECT team FROM personal_bots WHERE bot_id = ${botId}
    `.pipe(
      Effect.map((rows) => rows[0]?.team ?? null),
      Effect.orElseSucceed(() => null),
    );

  /** Whether a bot (on a team) can see an entry. */
  const visibleTo = (
    entry: PersonalMemoryEntry,
    botId: PersonalBotId,
    team: string | null | undefined,
  ) =>
    entry.scope === "shared" ||
    (entry.scope === "bot" && entry.scopeId === botId) ||
    (entry.scope === "team" &&
      team != null &&
      entry.scopeId !== null &&
      entry.scopeId.toLowerCase() === team.toLowerCase());

  const resolveRef: PersonalMemoryService["Service"]["resolveRef"] = (input) =>
    Effect.gen(function* () {
      const ref = input.ref.trim();
      const team = yield* teamOfBot(input.botId);
      if (ref.length < 6 || !/^[A-Za-z0-9-]+$/.test(ref)) {
        return yield* fail(`'${ref}' is not a memory id: use the id shown in your memory block.`);
      }
      const rows = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL AND (m.memory_id = ${ref} OR m.memory_id LIKE ${`${ref}%`})
        LIMIT 5
      `.pipe(Effect.flatMap(decodeAll));
      const exact = rows.find((entry) => entry.memoryId === ref);
      const candidates = (exact === undefined ? rows : [exact]).filter((entry) =>
        visibleTo(entry, input.botId, team),
      );
      if (candidates.length === 0) return yield* fail(`Memory '${ref}' was not found.`);
      if (candidates.length > 1) {
        return yield* fail(`'${ref}' matches several entries: give more of the id.`);
      }
      return candidates[0]!.memoryId;
    }).pipe(storageFailure("lookup"));

  /**
   * The entries a save may replace, or why not. Already-superseded ones and
   * the saved entry itself are skipped, so a repeated call is harmless.
   */
  const replaceTargets = (input: PersonalMemorySaveInput, savedId: PersonalMemoryId | null) =>
    Effect.gen(function* () {
      const targets: Array<PersonalMemoryEntry> = [];
      for (const memoryId of new Set(input.replaces ?? [])) {
        if (memoryId === savedId) continue;
        const found = yield* readEntry(memoryId).pipe(Effect.option);
        const target = Option.getOrUndefined(found);
        const visible =
          target !== undefined &&
          (input.actorBotId === undefined || visibleTo(target, input.actorBotId, input.actorTeam));
        if (target === undefined || !visible) {
          return yield* fail(`Memory '${memoryId}' was not found, so nothing was saved.`);
        }
        if (target.kind === "task_summary") {
          return yield* fail("Task summaries cannot be replaced, so nothing was saved.");
        }
        if (SCOPE_REACH[target.scope] > SCOPE_REACH[input.scope]) {
          return yield* fail(
            `This save reaches fewer bots than the ${target.scope} entry it would replace, so those bots would lose it. Save it as ${target.scope} instead. Nothing was saved.`,
          );
        }
        if (target.supersededAt != null) continue;
        targets.push(target);
      }
      return targets;
    });

  const save: PersonalMemoryService["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const content = input.content.trim();
      yield* rejectUnsafe(content);
      // Saving the same fact twice in one scope returns the first entry.
      const duplicate = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.scope = ${input.scope}
          AND m.scope_id IS ${input.scopeId} AND m.content = ${content}
        LIMIT 1
      `.pipe(Effect.flatMap(decodeAll));
      const existing = duplicate[0];
      const targets = yield* replaceTargets(input, existing?.memoryId ?? null);
      if (existing !== undefined && targets.length === 0) return existing;
      const memoryId = existing?.memoryId ?? PersonalMemoryId.make(NodeCrypto.randomUUID());
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.gen(function* () {
        if (existing === undefined) {
          yield* sql`
            INSERT INTO personal_memory (
              memory_id, scope, scope_id, kind, content, source, sensitivity,
              created_at, updated_at, deleted_at, version
            )
            VALUES (
              ${memoryId}, ${input.scope}, ${input.scopeId}, ${input.kind}, ${content},
              ${input.source}, 'normal', ${nowIso}, ${nowIso}, NULL, 1
            )
          `;
        }
        for (const target of targets) {
          yield* sql`
            UPDATE personal_memory
            SET superseded_at = ${nowIso}, superseded_by = ${memoryId},
                superseded_reason = 'Replaced by a newer save.', version = version + 1
            WHERE memory_id = ${target.memoryId} AND deleted_at IS NULL AND superseded_at IS NULL
          `;
        }
      }).pipe(sql.withTransaction);
      return yield* readEntry(memoryId);
    }).pipe(storageFailure("save"));

  const forget: PersonalMemoryService["Service"]["forget"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readEntry(input.memoryId);
      const team = yield* teamOfBot(input.actorBotId);
      if (!visibleTo(current, input.actorBotId, team)) {
        return yield* fail(`Memory '${input.memoryId}' was not found.`);
      }
      if (current.kind === "task_summary") {
        return yield* fail("Task summaries are removed from the Memory screen, not by a bot.");
      }
      if (current.supersededAt != null) return current;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE personal_memory
        SET superseded_at = ${nowIso}, superseded_by = NULL,
            superseded_reason = ${FORGOTTEN_REASON}, version = version + 1
        WHERE memory_id = ${input.memoryId} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      return yield* readEntry(input.memoryId);
    }).pipe(storageFailure("forget"));

  const restore: PersonalMemoryService["Service"]["restore"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readEntry(input.memoryId);
      if (current.supersededAt == null) return current;
      yield* sql`
        UPDATE personal_memory
        SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
            version = version + 1
        WHERE memory_id = ${input.memoryId} AND deleted_at IS NULL
      `;
      return yield* readEntry(input.memoryId);
    }).pipe(storageFailure("restore"));

  const similar: PersonalMemoryService["Service"]["similar"] = (input) =>
    Effect.gen(function* () {
      const candidates = yield* search({
        query: input.content.slice(0, 2_000) || " ",
        botId: input.botId,
        excludeTaskSummaries: true,
        limit: 30,
      });
      const excluded = new Set<string>(input.excludeIds ?? []);
      return candidates
        .filter((entry) => !excluded.has(entry.memoryId) && entry.scope !== "project")
        .map((entry) => ({ entry, similarity: memorySimilarity(input.content, entry.content) }))
        .filter((match) => match.similarity >= SIMILAR_MEMORY_THRESHOLD)
        .toSorted((a, b) => b.similarity - a.similarity)
        .slice(0, input.limit ?? 5);
    }).pipe(storageFailure("similar"));

  const update: PersonalMemoryService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const current = yield* readEntry(input.memoryId);
      if (current.kind === "task_summary" && input.kind !== undefined) {
        return yield* fail("Task summaries keep their kind.");
      }
      const content = input.content?.trim() ?? current.content;
      yield* rejectUnsafe(content);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE personal_memory
        SET content = ${content},
            kind = ${input.kind ?? current.kind},
            updated_at = ${nowIso},
            version = version + 1
        WHERE memory_id = ${input.memoryId} AND deleted_at IS NULL
      `;
      return yield* readEntry(input.memoryId);
    }).pipe(storageFailure("update"));

  // A tombstone: the text is blanked (so the FTS index drops it) and the row
  // stays so a replayed task completion cannot re-add its summary.
  const remove: PersonalMemoryService["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE personal_memory
        SET content = '', deleted_at = ${nowIso}, updated_at = ${nowIso}, version = version + 1
        WHERE memory_id = ${input.memoryId} AND deleted_at IS NULL
      `;
    }).pipe(storageFailure("delete"));

  const botForThread: PersonalMemoryService["Service"]["botForThread"] = (threadId) =>
    sql<{ readonly botId: PersonalBotId }>`
      SELECT bot_id AS "botId" FROM personal_bot_threads WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.botId)),
      Effect.orElseSucceed(() => Option.none<PersonalBotId>()),
    );

  const recordUsage = (threadId: ThreadId, memoryIds: ReadonlyArray<PersonalMemoryId>) =>
    Effect.gen(function* () {
      const active = yield* sql<{ readonly taskId: string; readonly attempt: number }>`
        SELECT task_id AS "taskId", attempt AS "attempt" FROM personal_task_attempts
        WHERE provider_thread_id = ${threadId} AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1
      `;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_memory_usage (thread_id, task_id, attempt, memory_ids_json, created_at)
        VALUES (
          ${threadId}, ${active[0]?.taskId ?? null}, ${active[0]?.attempt ?? null},
          ${encodeMemoryIds(memoryIds)}, ${nowIso}
        )
      `;
    });

  /**
   * What each thread's session was last given in full: the preference set
   * (ids and versions), when, and how many turns since. In memory only: after
   * a server restart the next turn simply sends the full list again.
   */
  type SentPreferences = {
    readonly sessionKey: string;
    readonly setKey: string;
    readonly sentAt: string;
    readonly turns: number;
  };
  const sentPreferences = new Map<string, SentPreferences>();
  /** What the last built turn would record, kept until its send succeeds. */
  const pendingSent = new Map<string, SentPreferences>();

  const confirmPreferencesSent: PersonalMemoryService["Service"]["confirmPreferencesSent"] = (
    threadId,
  ) =>
    Effect.sync(() => {
      const pending = pendingSent.get(threadId);
      if (pending === undefined) return;
      pendingSent.delete(threadId);
      sentPreferences.set(threadId, pending);
    });

  /** Whether the provider compacted this chat since `sinceIso` (its context may have lost the list). */
  const compactedSince = (threadId: ThreadId, sinceIso: string) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND kind = 'context-compaction' AND created_at > ${sinceIso}
    `.pipe(
      Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
      // Unknown means resend: a missing list costs more than a repeated one.
      Effect.orElseSucceed(() => true),
    );

  const contextForThread: PersonalMemoryService["Service"]["contextForThread"] = (input) =>
    Effect.gen(function* () {
      const botId = yield* botForThread(input.threadId);
      if (Option.isNone(botId)) return { block: null, memoryIds: [] };
      const scope = { botId: botId.value, projectId: input.projectId };
      // Every preference the bot can see, whatever the message says; the
      // caps keep the newest by when they were saved.
      const allPreferences = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL
          AND m.superseded_at IS NULL
          AND m.kind = 'preference'
          AND ${scopeCondition(scope)}
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT 500
      `.pipe(Effect.flatMap(decodeAll), storageFailure("preferences"));
      const preferences = capPreferences(allPreferences);
      if (preferences.dropped > 0) {
        yield* Effect.logWarning("personal memory preferences capped for a turn", {
          threadId: input.threadId,
          included: preferences.kept.length,
          dropped: preferences.dropped,
          maxEntries: PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
          maxChars: PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
        });
      }
      // Long briefs keep their tail: the rarest terms often sit near the end.
      const query = input.query.slice(0, PERSONAL_MEMORY_QUERY_MAX_CHARS) || " ";
      const notes = yield* search({
        query,
        ...scope,
        onlyKind: "note",
        ranked: true,
        limit: PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT,
      });
      const summaries =
        input.excludeTaskSummaries === true
          ? []
          : yield* search({
              query,
              ...scope,
              onlyKind: "task_summary",
              ranked: true,
              limit: PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT,
            });
      const seen = new Set(preferences.kept.map((entry) => dedupeKey(entry.content)));
      const relevant: Array<PersonalMemoryEntry> = [];
      for (const entry of [...notes, ...summaries]) {
        const key = dedupeKey(entry.content);
        if (seen.has(key)) continue;
        seen.add(key);
        relevant.push(entry);
      }

      // The full list once per session; then a one-line reminder while
      // nothing changed, the chat was not compacted and it is not due again.
      const setKey = preferences.kept
        .map((entry) => `${entry.memoryId}:${entry.version}`)
        .join(",");
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const previous = sentPreferences.get(input.threadId);
      const repeat =
        input.session !== undefined &&
        !input.session.fresh &&
        preferences.kept.length > 0 &&
        previous !== undefined &&
        previous.sessionKey === input.session.key &&
        previous.setKey === setKey &&
        previous.turns + 1 < PERSONAL_MEMORY_RESEND_EVERY_TURNS &&
        !(yield* compactedSince(input.threadId, previous.sentAt));
      // Recorded only once the send succeeds (confirmPreferencesSent): a turn
      // that never reached the provider must not mark the list as given.
      if (input.session !== undefined) {
        pendingSent.set(
          input.threadId,
          repeat && previous !== undefined
            ? { ...previous, turns: previous.turns + 1 }
            : { sessionKey: input.session.key, setKey, sentAt: nowIso, turns: 0 },
        );
      } else pendingSent.delete(input.threadId);

      const sentPreferenceEntries = repeat ? [] : preferences.kept;
      const memoryIds = [...sentPreferenceEntries, ...relevant].map((entry) => entry.memoryId);
      if (input.record && memoryIds.length > 0) {
        yield* recordUsage(input.threadId, memoryIds);
      }
      return {
        block: formatMemoryBlock({
          preferences: sentPreferenceEntries,
          relevant,
          droppedPreferences: preferences.dropped,
          preferencesRepeat: repeat ? { count: preferences.kept.length } : undefined,
        }),
        memoryIds,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal memory retrieval failed; continuing without memory", {
              threadId: input.threadId,
              cause: redactSecrets(Cause.pretty(cause)).slice(0, 2_000),
            }).pipe(Effect.as({ block: null, memoryIds: [] })),
      ),
    );

  const saveTaskSummary: PersonalMemoryService["Service"]["saveTaskSummary"] = (task) =>
    Effect.gen(function* () {
      const summary = task.result?.summary.trim() ?? "";
      if (task.status !== "completed" || summary.length === 0) return;
      const clipped =
        summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS)}...` : summary;
      const content = `Task "${task.title}": ${clipped}`;
      // Never persist anything credential-shaped, even from a bot's reply.
      if (looksLikeSecret(content)) return;
      // Nor anything from a task tree that had a user-marked sensitive site
      // open: bot-scope memory is injected into every new chat of the bot,
      // where the egress guard would see a clean thread carrying the page.
      // A record that cannot be read counts as tainted.
      const tainted = yield* exposures
        .read([
          rootExposureKey(task.rootTaskId),
          ...(task.threadId === null ? [] : [threadExposureKey(task.threadId)]),
        ])
        .pipe(
          Effect.map((exposure) => exposure.sources.size > 0),
          Effect.orElseSucceed(() => true),
        );
      if (tainted) {
        return yield* Effect.logInfo(
          "personal memory skipped a task summary: its task tree saw a sensitive site",
          { taskId: task.taskId },
        );
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_memory (
          memory_id, scope, scope_id, kind, content, source, sensitivity,
          created_at, updated_at, deleted_at, version
        )
        VALUES (
          ${NodeCrypto.randomUUID()}, 'bot', ${task.botId}, 'task_summary', ${content},
          ${`task:${task.taskId}`}, 'normal', ${nowIso}, ${nowIso}, NULL, 1
        )
        ON CONFLICT DO NOTHING
      `;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal memory could not save a task summary", {
              taskId: task.taskId,
              cause: redactSecrets(Cause.pretty(cause)).slice(0, 2_000),
            }),
      ),
    );

  const start: PersonalMemoryService["Service"]["start"] = () =>
    Option.match(tasks, {
      onNone: () => Effect.void,
      onSome: (service) =>
        forkParked(Stream.runForEach(service.changes, saveTaskSummary)).pipe(Effect.asVoid),
    });

  return {
    list,
    search,
    save,
    update,
    remove,
    forget,
    resolveRef,
    ownerMessages,
    get,
    propose,
    teamOfBot,
    restore,
    similar,
    botForThread,
    contextForThread,
    confirmPreferencesSent,
    saveTaskSummary,
    start,
  } satisfies PersonalMemoryService["Service"];
});

export const layer = Layer.effect(PersonalMemoryService, make);
