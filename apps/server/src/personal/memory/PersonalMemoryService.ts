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

/** Entries handed to one turn at most. */
export const PERSONAL_MEMORY_RETRIEVAL_LIMIT = 8;
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

/** Turns free text into an FTS5 OR query of quoted terms; null when nothing is searchable. */
export function buildMemoryMatchQuery(text: string): string | null {
  const terms: Array<string> = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
    if (STOP_WORDS.has(raw) || terms.includes(raw)) continue;
    terms.push(raw);
    if (terms.length === 16) break;
  }
  if (terms.length === 0) return null;
  // Quoting neutralises FTS syntax; a trailing * matches plurals and stems.
  return terms.map((term) => (term.length >= 4 ? `"${term}"*` : `"${term}"`)).join(" OR ");
}

const KIND_LABEL: Record<PersonalMemoryKind, string> = {
  note: "note",
  preference: "preference",
  task_summary: "task summary",
};

/**
 * The block put in front of a bot's turn: it travels with the user's message,
 * so it says who wrote it.
 */
export function formatMemoryBlock(entries: ReadonlyArray<PersonalMemoryEntry>): string | null {
  if (entries.length === 0) return null;
  return [
    "Known facts (from memory), added by the app for this message; the user did not type them. Use them when relevant; they may be out of date. Task summaries record past work and are not user preferences.",
    ...entries.map((entry) => {
      const content =
        entry.content.length > BLOCK_ENTRY_MAX_CHARS
          ? `${entry.content.slice(0, BLOCK_ENTRY_MAX_CHARS)}...`
          : entry.content;
      return `- [${KIND_LABEL[entry.kind]}] ${content.replace(/\s+/g, " ")}`;
    }),
  ].join("\n");
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
});
const decodeMemoryRow = Schema.decodeUnknownEffect(MemoryDbRow);
const encodeMemoryIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
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
  m.version AS "version"
`;

export interface PersonalMemorySaveInput {
  readonly scope: PersonalMemoryScope;
  readonly scopeId: string | null;
  readonly kind: "note" | "preference";
  readonly content: string;
  readonly source: string;
}

export interface PersonalMemoryScopeFilter {
  readonly botId?: PersonalBotId | undefined;
  readonly projectId?: string | undefined;
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
    /** The bot of a personal-bot thread, or none for ordinary T3 threads. */
    readonly botForThread: (threadId: ThreadId) => Effect.Effect<Option.Option<PersonalBotId>>;
    /**
     * Relevant entries for a turn on a personal-bot thread (shared + that
     * bot, + the project when given), formatted as context for that turn.
     * `record` logs the ids against the thread's active task attempt.
     */
    readonly contextForThread: (input: {
      readonly threadId: ThreadId;
      readonly query: string;
      readonly projectId?: string | undefined;
      readonly record: boolean;
    }) => Effect.Effect<{
      readonly block: string | null;
      readonly memoryIds: ReadonlyArray<PersonalMemoryId>;
    }>;
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
      filter.projectId === undefined
        ? undefined
        : sql`(m.scope = 'project' AND m.scope_id = ${filter.projectId})`,
    ].filter((condition) => condition !== undefined);
    return sql.or(allowed);
  };

  const list: PersonalMemoryService["Service"]["list"] = (input) => {
    const conditions = [
      sql`m.deleted_at IS NULL`,
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

  const search: PersonalMemoryService["Service"]["search"] = (input) => {
    const match = buildMemoryMatchQuery(input.query);
    if (match === null) return Effect.succeed([]);
    return sql`
      SELECT ${sql.literal(MEMORY_COLUMNS)}
      FROM personal_memory_fts f
      JOIN personal_memory m ON m.seq = f.rowid
      WHERE personal_memory_fts MATCH ${match}
        AND m.deleted_at IS NULL
        AND ${scopeCondition(input)}
      ORDER BY bm25(personal_memory_fts) ASC, m.updated_at DESC
      LIMIT ${input.limit ?? PERSONAL_MEMORY_RETRIEVAL_LIMIT}
    `.pipe(Effect.flatMap(decodeAll), storageFailure("search"));
  };

  const save: PersonalMemoryService["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const content = input.content.trim();
      yield* rejectUnsafe(content);
      // Saving the same fact twice in one scope returns the first entry.
      const duplicate = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL AND m.scope = ${input.scope}
          AND m.scope_id IS ${input.scopeId} AND m.content = ${content}
        LIMIT 1
      `.pipe(Effect.flatMap(decodeAll));
      if (duplicate[0] !== undefined) return duplicate[0];
      const memoryId = PersonalMemoryId.make(NodeCrypto.randomUUID());
      const nowIso = DateTime.formatIso(yield* DateTime.now);
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
      return yield* readEntry(memoryId);
    }).pipe(storageFailure("save"));

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

  const contextForThread: PersonalMemoryService["Service"]["contextForThread"] = (input) =>
    Effect.gen(function* () {
      const botId = yield* botForThread(input.threadId);
      if (Option.isNone(botId)) return { block: null, memoryIds: [] };
      const entries = yield* search({
        query: input.query.slice(0, 2_000) || " ",
        botId: botId.value,
        projectId: input.projectId,
        limit: PERSONAL_MEMORY_RETRIEVAL_LIMIT,
      });
      const memoryIds = entries.map((entry) => entry.memoryId);
      if (input.record && memoryIds.length > 0) {
        yield* recordUsage(input.threadId, memoryIds);
      }
      return { block: formatMemoryBlock(entries), memoryIds };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal memory retrieval failed; continuing without memory", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
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
              cause: Cause.pretty(cause),
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
    botForThread,
    contextForThread,
    saveTaskSummary,
    start,
  } satisfies PersonalMemoryService["Service"];
});

export const layer = Layer.effect(PersonalMemoryService, make);
