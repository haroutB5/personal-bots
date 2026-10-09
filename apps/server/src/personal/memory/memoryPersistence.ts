// Writing and reading memory entries: list, get, save (with replace), forget, restore, undo, update, remove, bot
// proposals, feedback, the usage record of a turn and the task summaries.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  PERSONAL_MEMORY_LIST_DEFAULT_LIMIT,
  PersonalMemoryId,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  type PersonalMemoryEntry,
  type ThreadId,
} from "@t3tools/contracts";

import { forkParked } from "../../serverActivation.ts";
import { rootExposureKey, threadExposureKey } from "../browser/sensitiveExposureStore.ts";
import { looksLikeSecret, redactSecrets } from "../secretText.ts";
import { appsToJson, normaliseApps } from "./memoryApps.ts";
import type { MemoryCore } from "./memoryCore.ts";
import { tracePruneDue } from "./memoryAgeingPolicy.ts";
import { undoRoute } from "./memoryProvenancePolicy.ts";
import { replaceRefusal, visibleTo } from "./memoryScopePolicy.ts";
import {
  encodeMemoryIds,
  encodeVersions,
  FORGOTTEN_REASON,
  MEMORY_COLUMNS,
  NOTE_FORGOTTEN_REASON,
  PERSONAL_MEMORY_MAX_PENDING_PER_BOT,
  REPLACED_REASON,
  RULE_FORGOTTEN_REASON,
  SUMMARY_MAX_CHARS,
  UNDONE_REASON,
  type PersonalMemorySaveInput,
} from "./memoryShared.ts";
import { entrySnapshotsJson, localDay } from "./memoryTidy.ts";
import { encodeTraceJson, TRACE_KEEP_DAYS, type MemoryTurnTrace } from "./memoryTurnTrace.ts";
import type { PersonalMemoryService } from "./PersonalMemoryService.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const makeMemoryPersistence = (core: MemoryCore) => {
  const {
    sql,
    exposures,
    tasks,
    fail,
    storageFailure,
    decodeAll,
    readEntry,
    rejectUnsafe,
    listConditions,
    teamOfBot,
    state,
  } = core;

  const list: PersonalMemoryService["Service"]["list"] = (input) =>
    sql`
      SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
      WHERE ${sql.and(listConditions(input))}
      ORDER BY m.updated_at DESC, m.seq DESC
      LIMIT ${input.limit ?? PERSONAL_MEMORY_LIST_DEFAULT_LIMIT}
    `.pipe(Effect.flatMap(decodeAll), storageFailure("list"));

  const listPage: PersonalMemoryService["Service"]["listPage"] = (input) =>
    Effect.gen(function* () {
      const entries = yield* list(input);
      const counted = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM personal_memory m WHERE ${sql.and(listConditions(input))}
      `.pipe(storageFailure("list"));
      return { entries, total: counted[0]?.n ?? entries.length };
    });

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
          entry_snapshots_json, to_apps_json
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
          ${entrySnapshotsJson(targets)},
          ${input.action === "save" && input.kind === "preference" ? appsToJson(input.apps) : null}
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
        const refusal = replaceRefusal(target, input.scope);
        if (refusal !== null) return yield* fail(refusal);
        if (target.supersededAt != null) continue;
        targets.push(target);
      }
      return targets;
    });

  /** The same apps, whatever their order; null and an empty list are both global. */
  const appsKey = (apps: ReadonlyArray<string> | null | undefined) =>
    JSON.stringify([...(normaliseApps(apps) ?? [])].toSorted());

  const save: PersonalMemoryService["Service"]["save"] = (input) =>
    Effect.gen(function* () {
      const content = input.content.trim();
      yield* rejectUnsafe(content);
      if ((input.evidence?.length ?? 0) > 8)
        return yield* fail("At most 8 evidence references are allowed.");
      for (const ref of input.evidence ?? []) {
        yield* rejectUnsafe(ref);
        if (
          ref.length > 500 ||
          /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(ref) ||
          /[?#]/.test(ref) ||
          /\b(?:sig|signature)\s*[:=]/i.test(ref)
        ) {
          return yield* fail(
            "Evidence references must be at most 500 characters; URL queries and fragments are not stored.",
          );
        }
      }
      const now = yield* DateTime.now;
      for (const date of [input.observedAt, input.verifiedAt]) {
        if (
          date !== undefined &&
          (date.length > 80 ||
            !Number.isFinite(Date.parse(date)) ||
            Date.parse(date) > DateTime.toEpochMillis(now))
        ) {
          return yield* fail(
            "Observation and verification dates must be valid dates, not in the future.",
          );
        }
      }
      const observedAt = input.observedAt
        ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(input.observedAt)))
        : null;
      const verifiedAt = input.verifiedAt
        ? DateTime.formatIso(DateTime.makeUnsafe(Date.parse(input.verifiedAt)))
        : null;
      if (input.temporalKind === "changing" && (!input.observedAt || !input.evidence?.length)) {
        return yield* fail(
          "Changing facts need observedAt and evidence identifying a source to recheck.",
        );
      }
      if (input.verifiedAt && !input.evidence?.length)
        return yield* fail("Verification needs an evidence reference.");
      if (
        input.observedAt &&
        input.verifiedAt &&
        Date.parse(input.verifiedAt) < Date.parse(input.observedAt)
      ) {
        return yield* fail("Verification cannot precede the observation.");
      }
      // Saving the same fact twice in one scope returns the first entry. What
      // "the same" means depends on the kind: a note is the same as any live
      // entry with its text (a rule is never demoted by a note save), but a
      // rule is the same only as a live rule with the same text and the same
      // apps. A note with the rule's text, or a rule limited to other apps, is
      // not: the rule is saved and that entry is replaced by it (below).
      const sameText = yield* sql`
        SELECT ${sql.literal(MEMORY_COLUMNS)} FROM personal_memory m
        WHERE m.deleted_at IS NULL AND m.superseded_at IS NULL AND m.scope = ${input.scope}
          AND m.scope_id IS ${input.scopeId} AND m.content = ${content}
        ORDER BY m.seq ASC
      `.pipe(Effect.flatMap(decodeAll));
      const wantedApps = appsKey(input.apps);
      const existing = sameText.find((entry) =>
        input.kind === "preference"
          ? entry.kind === "preference" && appsKey(entry.apps) === wantedApps
          : entry.kind === "preference" ||
            (entry.temporalKind === (input.temporalKind ?? null) &&
              entry.observedAt === observedAt &&
              entry.verifiedAt === verifiedAt &&
              encodeMemoryIds(entry.evidence ?? []) === encodeMemoryIds(input.evidence ?? [])),
      );
      const explicit = yield* replaceTargets(input, existing?.memoryId ?? null);
      // Entries with this very text that a new rule supersedes: a note it
      // promotes, or the same rule limited to other apps. With `replaces`
      // naming one of them it is already a target.
      const implicit =
        existing === undefined && input.kind === "preference"
          ? sameText.filter(
              (entry) =>
                (entry.kind === "note" || entry.kind === "preference") &&
                !explicit.some((target) => target.memoryId === entry.memoryId),
            )
          : [];
      const targets = [...explicit, ...implicit];
      if (
        input.kind === "note" &&
        targets.some((entry) => entry.conflict) &&
        (!input.verifiedAt || !input.evidence?.length)
      ) {
        return yield* fail(
          "A conflicted factual claim needs a source-checked correction with verifiedAt and evidence. Replace all resolved claims together.",
        );
      }
      if (existing !== undefined && targets.length === 0) return { ...existing, created: false };
      const memoryId = existing?.memoryId ?? PersonalMemoryId.make(NodeCrypto.randomUUID());
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      // What this call archived, read inside the transaction that archives it: the
      // receipt a chat line's Undo is bound to is this save's own (replacing entry
      // and version), never whatever a later save or restore made of the entry.
      const archivedEntries: Array<PersonalMemoryEntry> = [];
      yield* Effect.gen(function* () {
        if (existing === undefined) {
          yield* sql`
            INSERT INTO personal_memory (
              memory_id, scope, scope_id, kind, content, source, sensitivity,
              created_at, updated_at, deleted_at, version, apps_json,
              temporal_kind, observed_at, verified_at, evidence_json, origin_thread_id, origin_message_id
            )
            VALUES (
              ${memoryId}, ${input.scope}, ${input.scopeId}, ${input.kind}, ${content},
              ${input.source}, 'normal', ${nowIso}, ${nowIso}, NULL, 1,
              ${input.kind === "preference" ? appsToJson(input.apps) : null},
              ${input.temporalKind ?? null}, ${observedAt}, ${verifiedAt},
              ${encodeMemoryIds(input.evidence ?? [])}, ${input.originThreadId ?? null}, ${input.originMessageId ?? null}
            )
          `;
        }
        for (const target of targets) {
          const archived = yield* sql<{ readonly id: string }>`
            UPDATE personal_memory
            SET superseded_at = ${nowIso}, superseded_by = ${memoryId},
                superseded_reason = ${REPLACED_REASON}, version = version + 1
            WHERE memory_id = ${target.memoryId} AND deleted_at IS NULL AND superseded_at IS NULL
            RETURNING memory_id AS "id"
          `;
          if (archived.length > 0) {
            archivedEntries.push(yield* readEntry(PersonalMemoryId.make(target.memoryId)));
          }
        }
      }).pipe(sql.withTransaction);
      // A save into an entry that was already there still changed these, so the
      // chat can offer their Undo.
      return {
        ...(yield* readEntry(memoryId)),
        created: existing === undefined,
        archived: archivedEntries,
      };
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
      // Archived another way (forgotten, undone, ...): nothing to forget. An entry a
      // save replaced is different: the owner's explicit forget is the last word, so
      // the replacement link goes, the reason becomes the forget and the version
      // moves, and no earlier "Replaced" Undo can bring the entry back.
      if (current.supersededAt != null && current.supersededReason !== REPLACED_REASON) {
        return current;
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE personal_memory
        SET superseded_at = ${nowIso}, superseded_by = NULL,
            superseded_reason = ${input.reason ?? FORGOTTEN_REASON}, version = version + 1
        WHERE memory_id = ${input.memoryId} AND deleted_at IS NULL
          AND (superseded_at IS NULL OR superseded_reason = ${REPLACED_REASON})
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

  /**
   * Whether `noticeMessageId` is a "Replaced" line in `threadId` carrying exactly this receipt: the
   * Undo is only honoured from the chat whose line it is.
   */
  const noticeInChat = (input: {
    readonly threadId: string;
    readonly noticeMessageId: string;
    readonly memoryId: PersonalMemoryId;
    readonly replacedBy: string;
    readonly version: number;
  }) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly contextJson: string | null }>`
        SELECT context_json AS "contextJson" FROM projection_thread_messages
        WHERE message_id = ${input.noticeMessageId} AND thread_id = ${input.threadId}
      `;
      for (const row of rows) {
        const parsed = decodeJson(row.contextJson ?? "null");
        if (Option.isNone(parsed)) continue;
        const records = (parsed.value as { readonly records?: ReadonlyArray<unknown> } | null)
          ?.records;
        for (const record of records ?? []) {
          const { kind, payload } = record as {
            readonly kind?: string;
            readonly payload?: Record<string, unknown>;
          };
          if (
            kind === PERSONAL_CHAT_NOTICE_CONTEXT_KIND &&
            payload?.notice === "memory-saved" &&
            payload.undo === "unreplace" &&
            payload.memoryId === input.memoryId &&
            payload.replacedBy === input.replacedBy &&
            payload.version === input.version
          ) {
            return true;
          }
        }
      }
      return false;
    });

  /**
   * The Undo of a "Replaced a note/rule" chat line: a save into an entry that already existed archived
   * this one (see `save`). The line carries a receipt (the replacing entry and the archived entry's
   * version right after that save) and the Undo is tied to it: the entry comes back only while it is
   * still archived by that very replacement at that very version, so a line from an earlier save, or
   * one the entry has moved on from (restored and replaced again, forgotten), changes nothing and is
   * refused. The entry that replaced it is not touched. Kind, reason, replacement and version are part
   * of the update itself.
   */
  const unreplace = (input: {
    readonly memoryId: PersonalMemoryId;
    readonly replacedBy?: PersonalMemoryId | undefined;
    readonly version?: number | undefined;
    readonly threadId?: string | undefined;
    readonly noticeMessageId?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const { replacedBy, version, threadId, noticeMessageId } = input;
      if (
        replacedBy === undefined ||
        version === undefined ||
        threadId === undefined ||
        noticeMessageId === undefined
      ) {
        return yield* fail(
          "That Undo does not say which save it belongs to. Restore the entry from Archived on the Memory screen.",
        );
      }
      const inChat = yield* noticeInChat({
        threadId,
        noticeMessageId,
        memoryId: input.memoryId,
        replacedBy,
        version,
      });
      if (!inChat) return yield* fail("That Undo does not belong to this chat.");
      yield* sql`
        UPDATE personal_memory
        SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
            version = version + 1
        WHERE memory_id = ${input.memoryId} AND kind IN ('note', 'preference') AND deleted_at IS NULL
          AND superseded_at IS NOT NULL AND superseded_by = ${replacedBy}
          AND superseded_reason = ${REPLACED_REASON} AND version = ${version}
      `;
      const now = yield* readEntry(input.memoryId);
      // Already back (a second tap): nothing to do. Archived but no longer by that save: refused.
      if (now.supersededAt != null) {
        return yield* fail(
          "That Undo is out of date: the entry changed after the save it belongs to.",
        );
      }
      return now;
    });

  const undoNote: PersonalMemoryService["Service"]["undoNote"] = (input) =>
    Effect.gen(function* () {
      if (input.undo === "unreplace") return yield* unreplace(input);
      const current = yield* readEntry(input.memoryId);
      // Two rule Undos (1.60.42), see undoRoute.
      const route = undoRoute(current, input.undo);
      if (route === "rule") return yield* undoRule(input, current);
      if (route === "refuse") {
        return yield* fail("Only a note a bot saved can be undone from the chat.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      if (input.undo === "restore") {
        // Kind and reason are part of the update itself: an entry that became
        // a preference, or was archived some other way, is never brought back.
        const restored = yield* sql<{ readonly id: string }>`
          UPDATE personal_memory
          SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
              version = version + 1
          WHERE memory_id = ${input.memoryId} AND kind = 'note' AND deleted_at IS NULL
            AND superseded_at IS NOT NULL
            AND superseded_reason IN (${FORGOTTEN_REASON}, ${NOTE_FORGOTTEN_REASON})
          RETURNING memory_id AS "id"
        `;
        if (restored.length === 0) {
          const now = yield* readEntry(input.memoryId);
          if (now.kind !== "note") {
            return yield* fail("Only a note a bot saved can be undone from the chat.");
          }
          return now;
        }
        return yield* readEntry(input.memoryId);
      }
      if (current.supersededAt != null) return current;
      yield* Effect.gen(function* () {
        // The kind is checked again here, in the same transaction as the archive.
        const archived = yield* sql<{ readonly id: string }>`
          UPDATE personal_memory
          SET superseded_at = ${nowIso}, superseded_by = NULL,
              superseded_reason = ${UNDONE_REASON}, version = version + 1
          WHERE memory_id = ${input.memoryId} AND kind = 'note'
            AND deleted_at IS NULL AND superseded_at IS NULL
          RETURNING memory_id AS "id"
        `;
        if (archived.length === 0) return;
        // Only notes this note's own save replaced: never a preference, and
        // never an entry a split or an approval linked to it.
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
              version = version + 1
          WHERE superseded_by = ${input.memoryId} AND kind = 'note'
            AND superseded_reason = ${REPLACED_REASON} AND deleted_at IS NULL
        `;
      }).pipe(sql.withTransaction);
      return yield* readEntry(input.memoryId);
    }).pipe(storageFailure("undo"));

  /**
   * The Undo of a "Saved a rule" / "Forgot a rule" chat line. The kind and the reason are part of
   * each update itself, so a rule that changed since (or was archived some other way) is never
   * touched, and a note that became a rule has no such Undo. A restore is gated by the forget
   * reason alone: the source of a rule that was forgotten says nothing about how it was saved.
   */
  const undoRule = (
    input: {
      readonly memoryId: PersonalMemoryId;
      readonly undo?: "archive" | "restore" | "unreplace" | undefined;
    },
    current: PersonalMemoryEntry,
  ) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      if (input.undo === "restore") {
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
              version = version + 1
          WHERE memory_id = ${input.memoryId} AND kind = 'preference' AND deleted_at IS NULL
            AND superseded_at IS NOT NULL AND superseded_reason = ${RULE_FORGOTTEN_REASON}
        `;
        return yield* readEntry(input.memoryId);
      }
      if (current.supersededAt != null) return current;
      yield* Effect.gen(function* () {
        const archived = yield* sql<{ readonly id: string }>`
          UPDATE personal_memory
          SET superseded_at = ${nowIso}, superseded_by = NULL,
              superseded_reason = ${UNDONE_REASON}, version = version + 1
          WHERE memory_id = ${input.memoryId} AND kind = 'preference' AND source = ${current.source}
            AND deleted_at IS NULL AND superseded_at IS NULL
          RETURNING memory_id AS "id"
        `;
        if (archived.length === 0) return;
        // The rules and notes (a note the rule promoted, say) this rule's own save replaced come back.
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
              version = version + 1
          WHERE superseded_by = ${input.memoryId} AND kind IN ('preference', 'note')
            AND superseded_reason = ${REPLACED_REASON} AND deleted_at IS NULL
        `;
      }).pipe(sql.withTransaction);
      return yield* readEntry(input.memoryId);
    });

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
            verified_at = ${content === current.content ? (current.verifiedAt ?? null) : null},
            observed_at = ${content === current.content ? (current.observedAt ?? null) : null},
            evidence_json = ${content === current.content ? encodeMemoryIds(current.evidence ?? []) : null},
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
        SET content = '', evidence_json = NULL, observed_at = NULL, verified_at = NULL, conflict = NULL,
            origin_thread_id = NULL, origin_message_id = NULL,
            deleted_at = ${nowIso}, updated_at = ${nowIso}, version = version + 1
        WHERE memory_id = ${input.memoryId} AND deleted_at IS NULL
      `;
    }).pipe(storageFailure("delete"));

  const recordUsage = (
    threadId: ThreadId,
    memoryIds: ReadonlyArray<PersonalMemoryId>,
    messageId: string | undefined,
    trace: MemoryTurnTrace,
  ) =>
    Effect.gen(function* () {
      const active = yield* sql<{ readonly taskId: string; readonly attempt: number }>`
        SELECT task_id AS "taskId", attempt AS "attempt" FROM personal_task_attempts
        WHERE provider_thread_id = ${threadId} AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1
      `;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const traceJson = yield* encodeTraceJson(trace);
      yield* sql`
        INSERT INTO personal_memory_usage (
          thread_id, task_id, attempt, memory_ids_json, created_at, message_id, trace_json
        )
        VALUES (
          ${threadId}, ${active[0]?.taskId ?? null}, ${active[0]?.attempt ?? null},
          ${encodeMemoryIds(memoryIds)}, ${nowIso}, ${messageId ?? null}, ${traceJson}
        )
      `;
      // A trace is kept for TRACE_KEEP_DAYS; the usage row itself stays.
      const nowMs = DateTime.toEpochMillis(now);
      if (tracePruneDue(nowMs, state.tracesPrunedAtMs)) {
        state.tracesPrunedAtMs = nowMs;
        const cutoff = DateTime.formatIso(DateTime.subtract(now, { days: TRACE_KEEP_DAYS }));
        yield* sql`
          UPDATE personal_memory_usage SET trace_json = NULL
          WHERE usage_id IN (
            SELECT usage_id FROM personal_memory_usage
            WHERE trace_json IS NOT NULL AND created_at < ${cutoff} LIMIT 500
          )
        `;
      }
    });

  const setFeedback: PersonalMemoryService["Service"]["setFeedback"] = (input) =>
    Effect.gen(function* () {
      const entry = yield* readEntry(input.memoryId);
      if (entry.kind === "preference") {
        return yield* fail(
          "A rule cannot be marked outdated or not relevant here: tell the bot to change or forget it, or change it on the Memory screen.",
        );
      }
      if (input.signal === "clear") {
        yield* sql`DELETE FROM personal_memory_feedback WHERE memory_id = ${input.memoryId}`;
        return { memoryId: input.memoryId, signal: null };
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_memory_feedback (memory_id, signal, created_at)
        VALUES (${input.memoryId}, ${input.signal}, ${nowIso})
        ON CONFLICT (memory_id) DO UPDATE SET signal = excluded.signal, created_at = excluded.created_at
      `;
      return { memoryId: input.memoryId, signal: input.signal };
    }).pipe(storageFailure("feedback"));

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
    listPage,
    get,
    propose,
    resolveRef,
    save,
    forget,
    restore,
    undoNote,
    update,
    remove,
    recordUsage,
    setFeedback,
    saveTaskSummary,
    start,
  };
};

export type MemoryPersistence = ReturnType<typeof makeMemoryPersistence>;
