import { parseEvidence } from "./memoryEvidence.ts";
// The memory service's shared parts: its dependencies, how rows are read and filtered by scope, the full-text
// helpers and the in-memory state of a running server (what each chat's session was last given).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_MEMORY_MAX_LENGTH,
  PersonalMemoryError,
  type PersonalBotId,
  type PersonalMemoryEntry,
  type PersonalMemoryId,
  type PersonalMemoryListInput,
} from "@t3tools/contracts";

import { makeSensitiveExposureStore } from "../browser/sensitiveExposureStore.ts";
import { looksLikeSecret } from "../secretText.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import { parseAppsJson } from "./memoryApps.ts";
import {
  decodeMemoryRow,
  encodeMemoryIds,
  escapeLike,
  isMemoryError,
  MEMORY_COLUMNS,
  type PersonalMemoryScopeFilter,
} from "./memoryShared.ts";
import type { PersonalMemoryService } from "./PersonalMemoryService.ts";

/**
 * What each thread's session was last given in full: the preference set
 * (ids and versions), when, and how many turns since. In memory only: after
 * a server restart the next turn simply sends the full list again.
 */
export type SentPreferences = {
  readonly sessionKey: string;
  /** The ids and versions of the listed rules, as one string. */
  readonly setKey: string;
  /** The same, as a map: what the session has, to tell an addition from a change. */
  readonly ids: ReadonlyMap<string, number>;
  readonly sentAt: string;
  readonly turns: number;
};

export const makeMemoryCore = () =>
  Effect.gen(function* () {
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
      Effect.forEach(rows, (row) =>
        decodeMemoryRow(row).pipe(
          Effect.map(({ appsJson, demotedSignal, evidenceJson, temporalKind, ...entry }): PersonalMemoryEntry => ({
            temporalKind: temporalKind === "stable" || temporalKind === "historical" || temporalKind === "changing" ? temporalKind : null,
            evidence: parseEvidence(evidenceJson),
            ...entry,
            apps: parseAppsJson(appsJson),
            demoted: demotedSignal,
          })),
        ),
      );

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

    const listConditions = (input: PersonalMemoryListInput) => {
      const needle = input.query?.trim() ?? "";
      return [
        sql`m.deleted_at IS NULL`,
        input.status === "superseded"
          ? sql`m.superseded_at IS NOT NULL`
          : sql`m.superseded_at IS NULL`,
        input.scope === undefined ? undefined : sql`m.scope = ${input.scope}`,
        input.scopeId === undefined ? undefined : sql`m.scope_id = ${input.scopeId}`,
        input.kind === undefined ? undefined : sql`m.kind = ${input.kind}`,
        needle.length === 0
          ? undefined
          : sql`m.content LIKE ${`%${escapeLike(needle)}%`} ESCAPE '!'`,
      ].filter((condition) => condition !== undefined);
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

    /** The FTS rows for a match, best first, with their bm25 score (negative: more negative is better). */
    const searchScored = (
      match: string,
      filter: PersonalMemoryScopeFilter,
      limit: number,
      order: "score" | "newest" = "score",
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly score: number }>`
        SELECT ${sql.literal(MEMORY_COLUMNS)}, bm25(personal_memory_fts) AS "score"
        FROM personal_memory_fts f
        JOIN personal_memory m ON m.seq = f.rowid
        WHERE personal_memory_fts MATCH ${match}
          AND m.deleted_at IS NULL
          AND m.superseded_at IS NULL
          AND ${scopeCondition(filter)}
          AND ${filter.excludeTaskSummaries === true ? sql`m.kind <> 'task_summary'` : sql`1 = 1`}
          AND ${filter.excludePreferences === true ? sql`m.kind <> 'preference'` : sql`1 = 1`}
          AND ${filter.onlyKind === undefined ? sql`1 = 1` : sql`m.kind = ${filter.onlyKind}`}
        ORDER BY ${
          order === "score"
            ? sql`bm25(personal_memory_fts) ASC, m.updated_at DESC`
            : sql`m.updated_at DESC, bm25(personal_memory_fts) ASC`
        }
        LIMIT ${limit}
      `;
        const entries = yield* decodeAll(rows);
        return entries.map((entry, index) => ({ entry, bm25: rows[index]!.score }));
      });

    const teamOfBot: PersonalMemoryService["Service"]["teamOfBot"] = (botId) =>
      sql<{ readonly team: string | null }>`
      SELECT team FROM personal_bots WHERE bot_id = ${botId}
    `.pipe(
        Effect.map((rows) => rows[0]?.team ?? null),
        Effect.orElseSucceed(() => null),
      );

    const botForThread: PersonalMemoryService["Service"]["botForThread"] = (threadId) =>
      sql<{ readonly botId: PersonalBotId }>`
      SELECT bot_id AS "botId" FROM personal_bot_threads WHERE thread_id = ${threadId}
    `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.botId)),
        Effect.orElseSucceed(() => Option.none<PersonalBotId>()),
      );

    /** The state of a running server; none of it survives a restart (the next turn just sends more). */
    const state = {
      /** When old traces were last cleared: once an hour is plenty. */
      tracesPrunedAtMs: Number.NEGATIVE_INFINITY,
      sentPreferences: new Map<string, SentPreferences>(),
      /**
       * The apps a session's chat has been about. They only grow until the session
       * key changes, so a chat that drifts between apps lists each app's rules
       * once instead of every time the topic flips back.
       */
      stickyApps: new Map<string, { readonly sessionKey: string; readonly slugs: Set<string> }>(),
      /** What the last built turn would record, kept until its send succeeds. */
      pendingSent: new Map<string, SentPreferences>(),
    };

    return {
      sql,
      exposures,
      tasks,
      fail,
      storageFailure,
      decodeAll,
      readEntry,
      rejectUnsafe,
      scopeCondition,
      listConditions,
      documentFrequency,
      searchScored,
      teamOfBot,
      botForThread,
      state,
    };
  });

export type MemoryCore = Effect.Success<ReturnType<typeof makeMemoryCore>>;
