// Choosing what a bot is shown: keyword search, the notes and task summaries picked for a turn (with ageing and
// the owner's feedback), the rules listed for a turn and how often they are resent, plus the usage views.
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PersonalMemoryId,
  type PersonalBotId,
  type PersonalMemoryEntry,
  type PersonalMemoryKind,
  type PersonalMemoryTurnContext,
  type ThreadId,
  PERSONAL_MEMORY_RULES_WARN_SHARE,
} from "@t3tools/contracts";

import { memoryProvenanceLabel } from "./memoryEvidence.ts";
import { redactSecrets } from "../secretText.ts";
import {
  APP_SIGNAL_RECENT_CHARS,
  APP_SIGNAL_RECENT_MESSAGES,
  appLabel,
  appScopingEnabled,
  detectActiveApps,
  formatAppIndex,
  MEMORY_APPS,
  mentionsApp,
  selectRules,
  type ActiveApp,
} from "./memoryApps.ts";
import { buildMemoryMatchQuery, formatMemoryBlock, memoryLine, memoryRef } from "./memoryBlock.ts";
import type { MemoryCore } from "./memoryCore.ts";
import type { MemoryPersistence } from "./memoryPersistence.ts";
import {
  candidateQueryTerms,
  capByChars,
  contextualRetrievalEnabled,
  FOLLOW_UP_FLOOR,
  limitSummariesPerTitle,
  memoryQueryTerms,
  rankCandidates,
  type DemotionSignal,
  RELEVANT_MAX_CHARS,
  selectQueryTerms,
  termsToMatch,
  type Ranked,
} from "./memoryRetrieval.ts";
import { carryActiveApps, preferenceSend, sessionHoldsRules } from "./memoryContextPolicy.ts";
import { capPreferences, dedupeKey, visibleTo } from "./memoryScopePolicy.ts";
import {
  errorTagOf,
  MEMORY_COLUMNS,
  PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT,
  PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT,
  PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
  PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
  PERSONAL_MEMORY_QUERY_MAX_CHARS,
  PERSONAL_MEMORY_RESEND_EVERY_TURNS,
  PERSONAL_MEMORY_RETRIEVAL_LIMIT,
  PERSONAL_MEMORY_SCORE_FLOOR,
  STICKY_APPS_MAX,
  type PersonalMemoryScopeFilter,
} from "./memoryShared.ts";
import { memorySimilarity, SIMILAR_MEMORY_THRESHOLD } from "./memoryTidy.ts";
import {
  decodeTraceJson,
  snippetOf,
  TRACE_LEFT_OUT_MAX,
  TRACE_LEFT_OUT_SNIPPET_CHARS,
  TRACE_PICKED_SNIPPET_CHARS,
  type MemoryTurnTrace,
} from "./memoryTurnTrace.ts";
import type { PersonalMemoryService } from "./PersonalMemoryService.ts";

export const makeMemoryRetrieval = (core: MemoryCore, persistence: MemoryPersistence) => {
  const {
    sql,
    storageFailure,
    decodeAll,
    scopeCondition,
    documentFrequency,
    searchScored,
    botForThread,
    state,
  } = core;
  const { recordUsage } = persistence;
  const { sentPreferences, stickyApps, pendingSent } = state;

  const search: PersonalMemoryService["Service"]["search"] = (input) =>
    Effect.gen(function* () {
      const frequency =
        input.ranked === true
          ? yield* documentFrequency(memoryQueryTerms(input.query).slice(0, 200))
          : undefined;
      const match = buildMemoryMatchQuery(input.query, frequency);
      if (match === null) return [];
      const scored = yield* searchScored(
        match,
        input,
        input.limit ?? PERSONAL_MEMORY_RETRIEVAL_LIMIT,
      );
      // bm25 is negative, best first: keep what scores within the floor of the best.
      const best = scored[0]?.bm25 ?? 0;
      const kept =
        input.ranked === true
          ? scored.filter((row) => row.bm25 <= best * PERSONAL_MEMORY_SCORE_FLOOR)
          : scored;
      return kept.map((row) => row.entry);
    }).pipe(storageFailure("search"));

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

  /** What the turn is about besides its own message: the chat's title, the messages just before it, the bot's role. */
  const turnSignals = (
    threadId: ThreadId,
    botId: PersonalBotId,
    currentMessageId: string | undefined,
  ) =>
    Effect.gen(function* () {
      const titles = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_threads WHERE thread_id = ${threadId} LIMIT 1
      `;
      const recent = yield* sql<{ readonly text: string }>`
        SELECT substr(text, 1, ${APP_SIGNAL_RECENT_CHARS}) AS "text"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND message_id <> ${currentMessageId ?? ""}
          AND role = 'user'
        ORDER BY created_at DESC LIMIT ${APP_SIGNAL_RECENT_MESSAGES}
      `;
      const roles = yield* sql<{ readonly name: string; readonly description: string }>`
        SELECT name, description FROM personal_bots WHERE bot_id = ${botId} LIMIT 1
      `;
      return {
        title: titles[0]?.title ?? "",
        recent: recent.map((row) => row.text),
        botRole: `${roles[0]?.name ?? ""}\n${roles[0]?.description ?? ""}`,
      };
    }).pipe(
      // Context only sharpens the pick: without it the message alone decides.
      Effect.orElseSucceed(() => ({ title: "", recent: [] as Array<string>, botRole: "" })),
    );

  const entryWithTime = (entry: PersonalMemoryEntry) => ({
    ...entry,
    updatedAtMs: DateTime.toEpochMillis(entry.updatedAt),
  });

  /** Most candidates fetched per kind before they are scored, weighed and capped. */
  const CANDIDATES_PER_KIND = 30;
  /** Newest keyword matches added to those, per kind. */
  const NEWEST_PER_KIND = 15;

  /**
   * The notes and task summaries a turn is given. Contextual (default): the
   * search words come from the message, the chat title, the active apps and
   * the last few turns; status entries lose weight with age; the result is
   * capped by count and by characters. Legacy (kill switch): the message's
   * rarest words alone, as before 1.60.40.
   */
  const pickRelevant = (input: {
    readonly scope: PersonalMemoryScopeFilter;
    readonly query: string;
    readonly signals: { readonly title: string; readonly recent: ReadonlyArray<string> };
    readonly activeApps: ReadonlyArray<ActiveApp>;
    readonly ruleApps: ReadonlyArray<string>;
    readonly nowMs: number;
    readonly excludeTaskSummaries: boolean;
  }) =>
    Effect.gen(function* () {
      const empty = {
        entries: [] as Array<PersonalMemoryEntry>,
        picked: [] as MemoryTurnTrace["picked"],
        leftOut: [] as MemoryTurnTrace["leftOut"],
        query: { terms: [] as ReadonlyArray<string>, followUp: false },
      };
      if (!contextualRetrievalEnabled()) {
        const notes = yield* search({
          query: input.query,
          ...input.scope,
          onlyKind: "note",
          ranked: true,
          limit: PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT,
        });
        const summaries = input.excludeTaskSummaries
          ? []
          : yield* search({
              query: input.query,
              ...input.scope,
              onlyKind: "task_summary",
              ranked: true,
              limit: PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT,
            });
        const entries = [...notes, ...summaries].filter((entry) => entry.demoted !== "outdated");
        return {
          ...empty,
          entries,
          picked: entries.map((entry) => ({
            memoryId: entry.memoryId,
            kind: entry.kind,
            score: 0,
            why: ["keyword match (legacy retrieval)"],
            snippet: snippetOf(entry.content, TRACE_PICKED_SNIPPET_CHARS),
            provenance: memoryProvenanceLabel(entry),
          })),
        };
      }
      const appWords = input.activeApps.map((app) => `${appLabel(app.slug)} ${app.slug}`);
      const queryInput = {
        current: input.query,
        title: input.signals.title,
        appWords,
        recent: input.signals.recent,
      };
      const frequency = yield* documentFrequency(candidateQueryTerms(queryInput).slice(0, 300));
      const totals = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM personal_memory WHERE deleted_at IS NULL AND superseded_at IS NULL
      `;
      const chosen = selectQueryTerms(queryInput, frequency, totals[0]?.n ?? 0);
      const match = termsToMatch(chosen.terms);
      const query = { terms: chosen.terms, followUp: chosen.followUp };
      if (match === null) return { ...empty, query };
      const activeSet = new Set(input.activeApps.map((app) => app.slug));
      const knownApps = [...new Set([...MEMORY_APPS.map((app) => app.slug), ...input.ruleApps])];
      // The candidates: the best keyword matches, plus the newest matches, so
      // that ageing can lift a recent entry the best-30 would have missed.
      const poolFor = (kind: "note" | "task_summary") =>
        Effect.gen(function* () {
          const filter = { ...input.scope, onlyKind: kind } as const;
          const best = yield* searchScored(match, filter, CANDIDATES_PER_KIND);
          const newest = yield* searchScored(match, filter, NEWEST_PER_KIND, "newest");
          const seen = new Set(best.map((row) => row.entry.memoryId));
          return [...best, ...newest.filter((row) => !seen.has(row.entry.memoryId))];
        });
      const notePool = yield* poolFor("note");
      const summaryPool = input.excludeTaskSummaries ? [] : yield* poolFor("task_summary");
      // What the owner marked outdated or not relevant ranks lower.
      const poolIds = [...notePool, ...summaryPool].map((row) => row.entry.memoryId);
      const demoted = new Map<string, DemotionSignal>();
      if (poolIds.length > 0) {
        const marks = yield* sql<{ readonly memoryId: string; readonly signal: string }>`
          SELECT memory_id AS "memoryId", signal FROM personal_memory_feedback
          WHERE ${sql.in("memory_id", poolIds)}
        `;
        for (const mark of marks) {
          if (mark.signal === "outdated" || mark.signal === "not_relevant") {
            demoted.set(mark.memoryId, mark.signal);
          }
        }
      }
      const rank =
        (limit: number) =>
        (
          candidates: ReadonlyArray<{ readonly entry: PersonalMemoryEntry; readonly bm25: number }>,
        ) =>
          rankCandidates(
            // An hourly routine writes dozens of summaries that read alike: keep two per title.
            limitSummariesPerTitle(
              candidates.map((row) => row.entry),
              undefined,
              (entry) => DateTime.toEpochMillis(entry.updatedAt),
            ).map((entry) => ({
              entry: entryWithTime(entry),
              bm25: candidates.find((row) => row.entry === entry)!.bm25,
            })),
            {
              nowMs: input.nowMs,
              activeApps: activeSet,
              mentionsApp,
              knownApps,
              demoted,
              floor: chosen.followUp ? FOLLOW_UP_FLOOR : PERSONAL_MEMORY_SCORE_FLOOR,
              limit,
            },
          );
      const notes = rank(PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT)(notePool);
      const summaries = input.excludeTaskSummaries
        ? { picked: [], leftOut: [] }
        : rank(PERSONAL_MEMORY_CONTEXT_SUMMARY_LIMIT)(summaryPool);
      // Notes first: when the characters run out, task summaries go first.
      const capped = capByChars(
        [...notes.picked, ...summaries.picked],
        (row: Ranked<PersonalMemoryEntry & { readonly updatedAtMs: number }>) =>
          memoryLine(row.entry).length,
        RELEVANT_MAX_CHARS,
      );
      const leftOut = [
        ...capped.leftOut.map((row) => ({
          memoryId: row.entry.memoryId,
          kind: row.entry.kind,
          reason: "over the per-turn character limit",
          snippet: snippetOf(row.entry.content, TRACE_LEFT_OUT_SNIPPET_CHARS),
        })),
        ...[...notes.leftOut, ...summaries.leftOut].map((row) => ({
          memoryId: row.entry.memoryId,
          kind: row.entry.kind,
          reason:
            row.why.length > 0
              ? `matched much less than the best entries (${row.why.join(", ")})`
              : "matched much less than the best entries",
          snippet: snippetOf(row.entry.content, TRACE_LEFT_OUT_SNIPPET_CHARS),
        })),
      ].slice(0, TRACE_LEFT_OUT_MAX);
      return {
        entries: capped.kept.map((row): PersonalMemoryEntry => {
          const { updatedAtMs: _ignored, ...entry } = row.entry;
          return entry;
        }),
        picked: capped.kept.map((row) => ({
          memoryId: row.entry.memoryId,
          kind: row.entry.kind,
          score: Number(row.score.toFixed(3)),
          why: row.why,
          snippet: snippetOf(row.entry.content, TRACE_PICKED_SNIPPET_CHARS),
          provenance: memoryProvenanceLabel(row.entry),
        })),
        leftOut,
        query,
      };
    });

  const contextForThread: PersonalMemoryService["Service"]["contextForThread"] = (input) =>
    Effect.gen(function* () {
      // Whatever an earlier build left unconfirmed is stale from here on, and a
      // build that fails below must not leave it to be confirmed by this turn.
      pendingSent.delete(input.threadId);
      const botId = yield* botForThread(input.threadId);
      if (Option.isNone(botId)) return { block: null, memoryIds: [] };
      const scope = { botId: botId.value, projectId: input.projectId };
      const nowDate = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(nowDate);
      // Every preference the bot can see, whatever the message says.
      const allPreferences = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL
          AND m.superseded_at IS NULL
          AND m.kind = 'preference'
          AND ${scopeCondition(scope)}
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT 500
      `.pipe(Effect.flatMap(decodeAll), storageFailure("preferences"));

      // Long briefs keep their head: the rarest terms are picked from all of it.
      const query = input.query.slice(0, PERSONAL_MEMORY_QUERY_MAX_CHARS) || " ";
      const signals = yield* turnSignals(input.threadId, botId.value, input.messageId);
      const scoping = appScopingEnabled();
      const ruleApps = [...new Set(allPreferences.flatMap((entry) => entry.apps ?? []))];
      const detected = detectActiveApps({ ...signals, current: query }, ruleApps);
      // A session keeps the apps it has been about (they only grow), so a chat
      // that flips between apps lists each one's rules once, not on every flip.
      const sticky = input.session === undefined ? undefined : stickyApps.get(input.threadId);
      const activeApps = carryActiveApps({
        detected,
        session: input.session,
        sticky,
        max: STICKY_APPS_MAX,
      });
      if (input.session !== undefined) {
        stickyApps.set(input.threadId, {
          sessionKey: input.session.key,
          slugs: new Set(activeApps.map((app) => app.slug)),
        });
      } else stickyApps.delete(input.threadId);
      const active = new Set(activeApps.map((app) => app.slug));

      // The rules listed this turn. App scoping on: global rules always, plus
      // the rules of this turn's apps while they fit the caps; the rest are
      // counted in an index line, and any that do not fit are named. Off: the
      // old list (newest first up to the caps, older ones dropped and counted).
      let listed: ReadonlyArray<PersonalMemoryEntry>;
      let droppedPreferences = 0;
      let appIndex: string | null = null;
      let appIndexGroups: ReadonlyArray<{ readonly slug: string; readonly count: number }> = [];
      let leftOutRules: ReadonlyArray<PersonalMemoryEntry> = [];
      if (scoping) {
        const picked = selectRules(
          allPreferences.map((entry) => ({
            entry,
            memoryId: entry.memoryId,
            content: entry.content,
            apps: entry.apps ?? null,
          })),
          {
            active,
            scoping: true,
            caps: {
              maxEntries: PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
              maxChars: PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
            },
          },
        );
        listed = picked.kept.map((rule) => rule.entry).toReversed();
        leftOutRules = picked.leftOut.map((rule) => rule.entry);
        appIndex = formatAppIndex(picked.index);
        appIndexGroups = picked.index.map((group) => ({ slug: group.slug, count: group.count }));
        if (leftOutRules.length > 0) {
          yield* Effect.logWarning("personal memory rules left out for a turn", {
            threadId: input.threadId,
            activeApps: [...active],
            leftOut: leftOutRules.map((entry) => memoryRef(entry)),
            maxEntries: PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
            maxChars: PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
          });
        }
      } else {
        const capped = capPreferences(allPreferences);
        listed = capped.kept;
        droppedPreferences = capped.dropped;
        if (capped.dropped > 0) {
          yield* Effect.logWarning("personal memory preferences capped for a turn", {
            threadId: input.threadId,
            included: capped.kept.length,
            dropped: capped.dropped,
            maxEntries: PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
            maxChars: PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
          });
        }
      }

      const picks = yield* pickRelevant({
        scope,
        query,
        signals,
        activeApps,
        ruleApps,
        nowMs,
        excludeTaskSummaries: input.excludeTaskSummaries === true,
      });
      const seen = new Set(listed.map((entry) => dedupeKey(entry.content)));
      const relevant: Array<PersonalMemoryEntry> = [];
      for (const entry of picks.entries) {
        const key = dedupeKey(entry.content);
        if (seen.has(key)) continue;
        seen.add(key);
        relevant.push(entry);
      }

      // The full list once per session; then a one-line reminder while
      // nothing changed, the chat was not compacted and it is not due again.
      // Rules of an app the chat has since started covering are sent alone,
      // on top of the list already there. The index and any left-out line are
      // printed on every turn, so a change in them needs no resend.
      const currentIds = new Map<string, number>(
        listed.map((entry) => [entry.memoryId as string, entry.version] as const),
      );
      const setKey = listed.map((entry) => `${entry.memoryId}:${entry.version}`).join(",");
      const nowIso = DateTime.formatIso(nowDate);
      const previous = sentPreferences.get(input.threadId);
      const reusable =
        sessionHoldsRules({
          session: input.session,
          listedCount: listed.length,
          previous,
          resendEvery: PERSONAL_MEMORY_RESEND_EVERY_TURNS,
        }) &&
        previous !== undefined &&
        !(yield* compactedSince(input.threadId, previous.sentAt));
      const { repeat, addedRules, delta } = preferenceSend({
        reusable,
        previous,
        setKey,
        currentIds,
        listed,
        scoping,
      });
      // Recorded only once the send succeeds (confirmPreferencesSent): a turn
      // that never reached the provider must not mark the list as given.
      if (input.session !== undefined) {
        pendingSent.set(
          input.threadId,
          (repeat || delta) && previous !== undefined
            ? { ...previous, setKey, ids: currentIds, turns: previous.turns + 1 }
            : {
                sessionKey: input.session.key,
                setKey,
                ids: currentIds,
                sentAt: nowIso,
                turns: 0,
              },
        );
      } else pendingSent.delete(input.threadId);

      const sentPreferenceEntries = repeat || delta ? [] : listed;
      const memoryIds = [...sentPreferenceEntries, ...(delta ? addedRules : []), ...relevant].map(
        (entry) => entry.memoryId,
      );
      const blockInput = {
        preferences: sentPreferenceEntries,
        droppedPreferences,
        preferencesRepeat: repeat
          ? { count: listed.length }
          : delta && previous !== undefined
            ? { count: previous.ids.size, added: addedRules }
            : undefined,
        appIndex,
        leftOutRules,
      };
      const block = formatMemoryBlock({ ...blockInput, relevant });
      const preferencesBlock =
        relevant.length > 0 && (sentPreferenceEntries.length > 0 || repeat || delta)
          ? formatMemoryBlock({ ...blockInput, relevant: [] })
          : null;
      const trace: MemoryTurnTrace = {
        activeApps: activeApps.map((app) => ({ slug: app.slug, via: [...app.via] })),
        rules: {
          global: listed.filter((entry) => !scoping || (entry.apps ?? null) === null).length,
          scoped: listed.filter((entry) => scoping && (entry.apps ?? null) !== null).length,
        },
        appIndex: appIndexGroups,
        appIndexLine: appIndex,
        rulesLeftOut: leftOutRules.map((entry) => entry.memoryId),
        rulesListed: listed.map((entry) => entry.memoryId),
        rulesSent: !repeat,
        rulesAdded: delta ? addedRules.map((entry) => entry.memoryId) : [],
        query: { terms: [...picks.query.terms], followUp: picks.query.followUp },
        picked: picks.picked.map((row) => ({ ...row, why: [...row.why] })),
        leftOut: picks.leftOut,
      };
      // Every recorded turn leaves a row (a reminder turn used the rules sent
      // earlier), with the trace the "Context used" view reads.
      if (input.record) {
        yield* recordUsage(input.threadId, memoryIds, input.messageId, trace);
      }
      return {
        block,
        ...(preferencesBlock === null ? {} : { preferencesBlock }),
        memoryIds,
        trace,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal memory retrieval failed; continuing without memory", {
              threadId: input.threadId,
              errorTag: errorTagOf(Cause.squash(cause)),
              cause: redactSecrets(Cause.pretty(cause)).slice(0, 2_000),
            }).pipe(Effect.as({ block: null, memoryIds: [] })),
      ),
    );

  const turnContext: PersonalMemoryService["Service"]["turnContext"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly createdAt: string; readonly traceJson: string | null }>`
        SELECT created_at AS "createdAt", trace_json AS "traceJson" FROM personal_memory_usage
        WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}
          AND trace_json IS NOT NULL
        ORDER BY usage_id DESC LIMIT 1
      `;
      const row = rows[0];
      if (row?.traceJson == null) return null;
      const trace = Option.getOrNull(decodeTraceJson(row.traceJson));
      if (trace === null) return null;
      const ids = [
        ...new Set([
          ...trace.rulesListed,
          ...trace.rulesLeftOut,
          ...trace.picked.map((entry) => entry.memoryId),
        ]),
      ];
      const live =
        ids.length === 0
          ? []
          : yield* sql`
              SELECT ${sql.literal(MEMORY_COLUMNS)}, m.deleted_at AS "deletedAt"
              FROM personal_memory m WHERE ${sql.in("m.memory_id", ids)}
            `.pipe(
              Effect.flatMap((found) =>
                decodeAll(found).pipe(
                  Effect.map((entries) =>
                    entries.map((entry, index) => ({
                      entry,
                      deleted:
                        (found[index] as { readonly deletedAt?: string | null }).deletedAt != null,
                    })),
                  ),
                ),
              ),
            );
      const byId = new Map(live.map((item) => [item.entry.memoryId as string, item] as const));
      const isCurrent = (id: string) => {
        const item = byId.get(id);
        return item !== undefined && !item.deleted && item.entry.supersededAt == null;
      };
      const rule = (id: string) => {
        const item = byId.get(id);
        return {
          memoryId: PersonalMemoryId.make(id),
          content: item === undefined || item.deleted ? "" : item.entry.content,
          apps: item?.entry.apps ?? null,
          current: isCurrent(id),
          provenance: item ? memoryProvenanceLabel(item.entry) : "provenance unavailable",
        };
      };
      return {
        messageId: input.messageId,
        createdAt: row.createdAt,
        apps: trace.activeApps.map((app) => ({
          slug: app.slug,
          label: appLabel(app.slug),
          via: [...app.via],
        })),
        rules: {
          sent: trace.rulesSent,
          items: trace.rulesListed.map(rule),
          added: trace.rulesAdded.map((id) => PersonalMemoryId.make(id)),
          index: trace.appIndexLine,
          leftOut: trace.rulesLeftOut.map(rule),
        },
        notes: trace.picked.map((entry) => ({
          memoryId: PersonalMemoryId.make(entry.memoryId),
          kind: entry.kind as PersonalMemoryKind,
          snippet: entry.snippet,
          why: [...entry.why],
          score: entry.score,
          feedback: byId.get(entry.memoryId)?.entry.demoted ?? null,
          current: isCurrent(entry.memoryId),
          provenance: entry.provenance ?? (byId.get(entry.memoryId) ? memoryProvenanceLabel(byId.get(entry.memoryId)!.entry) : "provenance unavailable"),
        })),
        leftOut: trace.leftOut.map((entry) => ({
          memoryId: PersonalMemoryId.make(entry.memoryId),
          kind: entry.kind as PersonalMemoryKind,
          snippet: entry.snippet,
          reason: entry.reason,
        })),
        query: { terms: [...trace.query.terms], followUp: trace.query.followUp },
      } satisfies PersonalMemoryTurnContext;
    }).pipe(storageFailure("turn context"));

  const rulesForApps: PersonalMemoryService["Service"]["rulesForApps"] = (input) =>
    Effect.gen(function* () {
      if (input.apps.length === 0) return [];
      const wanted = new Set(input.apps);
      const rows = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.kind = 'preference'
          AND m.apps_json IS NOT NULL AND ${scopeCondition({ botId: input.botId })}
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT 500
      `.pipe(Effect.flatMap(decodeAll));
      return rows.filter((entry) => (entry.apps ?? []).some((app) => wanted.has(app)));
    }).pipe(storageFailure("rules for apps"));

  const rulesUsage: PersonalMemoryService["Service"]["rulesUsage"] = () =>
    Effect.gen(function* () {
      const bots = yield* sql<{
        readonly botId: PersonalBotId;
        readonly name: string;
        readonly team: string | null;
      }>`SELECT bot_id AS "botId", name, team FROM personal_bots`;
      const prefs = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.kind = 'preference'
          AND m.scope <> 'project'
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT 1000
      `.pipe(Effect.flatMap(decodeAll));
      const scoping = appScopingEnabled();
      const caps = {
        maxEntries: PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
        maxChars: PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
      };
      const allApps = new Set(prefs.flatMap((entry) => entry.apps ?? []));
      // Bots that can see the same rules are one row: their team, or the bot alone.
      const groups = new Map<
        string,
        {
          names: Array<string>;
          team: string | null;
          visible: Array<PersonalMemoryEntry>;
          botId: string;
        }
      >();
      for (const bot of bots) {
        const visible = prefs.filter((entry) => visibleTo(entry, bot.botId, bot.team));
        const key = visible.map((entry) => entry.memoryId).join(",");
        const group = groups.get(key);
        if (group === undefined) {
          groups.set(key, { names: [bot.name], team: bot.team, visible, botId: bot.botId });
        } else group.names.push(bot.name);
      }
      const rows = [...groups.values()].map((group) => {
        const rules = group.visible.map((entry) => ({
          entry,
          memoryId: entry.memoryId,
          content: entry.content,
          apps: entry.apps ?? null,
        }));
        const picked = selectRules(rules, { active: allApps, scoping, caps });
        const legacy = scoping ? null : capPreferences(group.visible);
        const kept = legacy === null ? picked.kept.map((rule) => rule.entry) : legacy.kept;
        const leftOut =
          legacy === null
            ? picked.leftOut.map((rule) => rule.entry)
            : group.visible.filter((entry) => !legacy.kept.includes(entry)).slice(0, 20);
        const all = [...kept, ...leftOut];
        const chars = all.reduce((total, entry) => total + entry.content.length, 0);
        const entryShare = all.length / caps.maxEntries;
        const charShare = chars / caps.maxChars;
        return {
          botId: group.botId,
          botName:
            group.names.length > 1
              ? `${group.team === null ? "Bots" : group.team} (${group.names.length} bots)`
              : (group.names[0] ?? group.botId),
          entries: all.length,
          chars,
          globalRules: all.filter((entry) => !scoping || (entry.apps ?? null) === null).length,
          appRules: all.filter((entry) => scoping && (entry.apps ?? null) !== null).length,
          entryShare,
          charShare,
          share: Math.max(entryShare, charShare),
          leftOut: leftOut.map((entry) => ({ memoryId: entry.memoryId, content: entry.content })),
        };
      });
      const top = rows.toSorted((a, b) => b.share - a.share).slice(0, 3);
      const worst = top[0];
      return {
        ...caps,
        warnShare: PERSONAL_MEMORY_RULES_WARN_SHARE,
        level:
          worst === undefined
            ? ("ok" as const)
            : worst.leftOut.length > 0
              ? ("over" as const)
              : worst.share >= PERSONAL_MEMORY_RULES_WARN_SHARE
                ? ("near" as const)
                : ("ok" as const),
        scoping,
        rows: top,
      };
    }).pipe(storageFailure("rules usage"));

  return {
    search,
    similar,
    confirmPreferencesSent,
    contextForThread,
    turnContext,
    rulesForApps,
    rulesUsage,
  };
};

export type MemoryRetrieval = ReturnType<typeof makeMemoryRetrieval>;
