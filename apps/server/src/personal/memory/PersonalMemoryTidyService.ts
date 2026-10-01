import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersonalMemoryError,
  PersonalMemoryId,
  PersonalMemoryTidyMode,
  PersonalMemoryTidyRun,
  ProviderInstanceId,
  type PersonalMemoryTidyChangeStatus,
  type PersonalMemoryTidyChange,
  type PersonalMemoryTidyLogResult,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { isExpensiveSeedModel } from "../seedModel.ts";
import {
  buildTidyPrompt,
  decisionsFromJudge,
  exactDuplicateDecisions,
  localDay,
  localMinuteOfDay,
  TIDY_MAX_ENTRIES_PER_CALL,
  TidyJudgeOutput,
  validateDecisions,
  type TidyDecision,
  type TidyEntry,
} from "./memoryTidy.ts";
import { looksLikeSecret } from "./PersonalMemoryService.ts";

/**
 * The nightly memory tidy-up. At 03:30 local time (or the first check after,
 * if the laptop slept) it reads every current note and preference, scope by
 * scope, folds exact duplicates itself, asks a cheap model which entries are
 * the same subject or out of date, checks each answer (`memoryTidy.ts`) and,
 * in mode "on", supersedes or merges. It never deletes: superseded entries
 * keep their text and can be restored from the Memory screen. Every run and
 * change is written to the changelog, including what it left alone.
 *
 * Mode "preview" (the default) does all of that but changes nothing, so the
 * owner can read what it would do first. Mode "off" skips the nightly run.
 */
export class PersonalMemoryTidy extends Context.Service<
  PersonalMemoryTidy,
  {
    /** One run now. dryRun lists the changes without making them. */
    readonly run: (input: {
      readonly dryRun: boolean;
    }) => Effect.Effect<PersonalMemoryTidyRun, PersonalMemoryError>;
    /** The owner's answer to a pending change: approve makes it, reject drops it. */
    readonly decide: (input: {
      readonly changeId: number;
      readonly approve: boolean;
    }) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    readonly log: (input: {
      readonly limit?: number | undefined;
    }) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    readonly setMode: (
      mode: PersonalMemoryTidyMode,
    ) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    /** Checks every 10 minutes whether tonight's run is due. Park-aware. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/personal/memory/PersonalMemoryTidyService/PersonalMemoryTidy") {}

/** Asks a model about one scope's entries. */
export class PersonalMemoryTidyJudge extends Context.Service<
  PersonalMemoryTidyJudge,
  {
    /** The model it uses, for the changelog. */
    readonly model: string;
    readonly judge: (prompt: string) => Effect.Effect<TidyJudgeOutput, string>;
  }
>()("t3/personal/memory/PersonalMemoryTidyService/PersonalMemoryTidyJudge") {}

export const PERSONAL_MEMORY_TIDY_MODEL_ENV = "PERSONAL_MEMORY_TIDY_MODEL";
/** Cheap and good enough for "same subject / clearly out of date"; never Fable. */
export const PERSONAL_MEMORY_TIDY_DEFAULT_MODEL = "claude-sonnet-5-5";
const TIDY_EFFORT = "low";

/** The model the tidy-up runs on: the env override unless it is an expensive one. */
export function tidyModel(override: string | undefined): string {
  const pinned = override?.trim();
  return pinned !== undefined && pinned.length > 0 && !isExpensiveSeedModel(pinned)
    ? pinned
    : PERSONAL_MEMORY_TIDY_DEFAULT_MODEL;
}

/** The live judge: the Claude provider's structured, tool-less one-shot call. */
export const judgeLayer = Layer.effect(
  PersonalMemoryTidyJudge,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const model = tidyModel(process.env[PERSONAL_MEMORY_TIDY_MODEL_ENV]);
    const instanceId = ProviderInstanceId.make("claudeAgent");
    return PersonalMemoryTidyJudge.of({
      model,
      judge: (prompt) =>
        Effect.gen(function* () {
          const instance = yield* registry.getInstance(instanceId);
          const generate = instance?.textGeneration.generateStructured;
          if (generate === undefined) {
            return yield* Effect.fail("The Claude provider is not available.");
          }
          return yield* generate({
            prompt,
            outputSchema: TidyJudgeOutput,
            modelSelection: {
              instanceId,
              model,
              ...(model.includes("haiku")
                ? {}
                : { options: [{ id: "effort", value: TIDY_EFFORT }] }),
            },
          }).pipe(Effect.mapError((error) => error.message));
        }),
    });
  }),
);

/** Local time of the nightly run. */
export const TIDY_HOUR = 3;
export const TIDY_MINUTE = 30;
const TIDY_CHECK_MS = 10 * 60 * 1000;

/** Whether the nightly run is due: past 03:30 local, and none has started today. */
export function nightlyRunDue(nowMs: number, lastNightlyStartMs: number | null): boolean {
  if (localMinuteOfDay(nowMs) < TIDY_HOUR * 60 + TIDY_MINUTE) return false;
  return lastNightlyStartMs === null || localDay(lastNightlyStartMs) !== localDay(nowMs);
}

const EntryRow = Schema.Struct({
  memoryId: Schema.String,
  scope: Schema.Literals(["shared", "team", "bot", "project"]),
  scopeId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["note", "preference"]),
  content: Schema.String,
  source: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  version: Schema.Number,
});
const decodeEntryRows = Schema.decodeUnknownEffect(Schema.Array(EntryRow));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeIds = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeRun = Schema.decodeUnknownEffect(PersonalMemoryTidyRun);
const isMemoryError = Schema.is(PersonalMemoryError);
const isTidyMode = Schema.is(PersonalMemoryTidyMode);

interface RunRow {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: string;
  readonly dryRun: number;
  readonly model: string | null;
  readonly merged: number;
  readonly superseded: number;
  readonly pending: number;
  readonly leftAlone: number;
  readonly error: string | null;
}

interface ChangeRow {
  readonly changeId: number;
  readonly runId: string;
  readonly status: string;
  readonly action: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly memoryIdsJson: string;
  readonly resultMemoryId: string | null;
  readonly content: string | null;
  readonly reason: string;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const judge = yield* PersonalMemoryTidyJudge;
  const config = yield* Effect.serviceOption(ServerConfig);
  const staticDir = config._tag === "Some" ? config.value.staticDir : undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** The live app version, from the served client's version.txt (null in tests). */
  const readAppVersion =
    staticDir === undefined
      ? Effect.succeed(null)
      : fileSystem.readFileString(path.join(staticDir, "version.txt")).pipe(
          Effect.map((text) => /^version=(.+)$/m.exec(text)?.[1]?.trim() || null),
          Effect.orElseSucceed(() => null),
        );
  // A nightly run and a "Preview now" never overlap.
  const lock = yield* Semaphore.make(1);

  const fail = (message: string, cause?: unknown) =>
    new PersonalMemoryError({ message, ...(cause === undefined ? {} : { cause }) });
  const storageFailure =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, PersonalMemoryError, R> =>
      effect.pipe(
        Effect.mapError((cause) =>
          isMemoryError(cause) ? cause : fail(`Memory tidy-up ${operation} failed.`, cause),
        ),
      );

  const readMode = sql<{ readonly mode: string }>`
    SELECT mode FROM personal_memory_tidy_settings WHERE settings_id = 1
  `.pipe(Effect.map((rows) => (isTidyMode(rows[0]?.mode) ? rows[0]!.mode : ("preview" as const))));

  // Shared entries only: team and bot entries are left to the bots that own them.
  const readEntries = sql`
    SELECT memory_id AS "memoryId", scope, scope_id AS "scopeId", kind, content, source,
      created_at AS "createdAt", updated_at AS "updatedAt", version
    FROM personal_memory
    WHERE deleted_at IS NULL AND superseded_at IS NULL AND scope = 'shared'
      AND kind IN ('note', 'preference')
    ORDER BY created_at DESC, seq DESC
  `.pipe(
    Effect.flatMap(decodeEntryRows),
    Effect.map((rows) =>
      rows.map((row): TidyEntry => ({
        memoryId: row.memoryId,
        scope: row.scope,
        scopeId: row.scopeId,
        kind: row.kind,
        content: row.content,
        source: row.source,
        createdAtMs: Date.parse(row.createdAt),
        updatedAtMs: Date.parse(row.updatedAt),
        version: row.version,
      })),
    ),
  );

  /** The proposed changes: exact duplicates first, then the model's. */
  const plan = (entries: ReadonlyArray<TidyEntry>, nowMs: number, appVersion: string | null) =>
    Effect.gen(function* () {
      const exact = exactDuplicateDecisions(entries);
      const folded = new Set(exact.flatMap((decision) => decision.memoryIds));
      const rest = entries.filter((entry) => !folded.has(entry.memoryId));
      let judged: ReadonlyArray<TidyDecision> = [];
      let error: string | null = null;
      if (rest.length >= 2) {
        const { prompt, refs } = buildTidyPrompt({
          entries: rest.slice(0, TIDY_MAX_ENTRIES_PER_CALL),
          todayIso: localDay(nowMs),
          appVersion,
        });
        const output = yield* judge.judge(prompt).pipe(Effect.result);
        if (output._tag === "Success") judged = decisionsFromJudge(output.success, refs);
        else error = output.failure;
      }
      return {
        ...validateDecisions(entries, [...exact, ...judged], nowMs, looksLikeSecret),
        error,
      };
    });

  /**
   * Makes one change, only if every entry it touches is still current (and,
   * for a run, exactly as planned): an edit, restore or delete in between
   * wins. Null when skipped.
   */
  const applyDecision = (
    decision: TidyDecision,
    versions: ReadonlyMap<string, number> | null,
    source: string,
    nowIso: string,
  ) =>
    Effect.gen(function* () {
      if (decision.action === "leave") return null;
      const ids = decision.memoryIds;
      const touched =
        decision.action === "supersede" && decision.by !== null ? [...ids, decision.by] : ids;
      const current = yield* sql<{
        readonly memoryId: string;
        readonly version: number;
        readonly kind: string;
        readonly scope: string;
        readonly scopeId: string | null;
        readonly createdAt: string;
      }>`
        SELECT memory_id AS "memoryId", version, kind, scope, scope_id AS "scopeId",
          created_at AS "createdAt"
        FROM personal_memory
        WHERE deleted_at IS NULL AND superseded_at IS NULL
          AND ${sql.in("memory_id", touched)}
      `;
      const byId = new Map(current.map((row) => [row.memoryId, row]));
      const intact = touched.every((id) => {
        const row = byId.get(id);
        return (
          row !== undefined &&
          (versions === null || versions.get(id) === undefined || versions.get(id) === row.version)
        );
      });
      if (!intact) return null;
      let resultId: string | null = decision.action === "supersede" ? decision.by : null;
      if (decision.action === "merge") {
        const members = ids.map((id) => byId.get(id)!);
        const first = members[0]!;
        resultId = NodeCrypto.randomUUID();
        // Dated by its newest member, so it keeps its place among the others.
        const newest = members
          .map((row) => row.createdAt)
          .toSorted()
          .at(-1)!;
        yield* sql`
          INSERT INTO personal_memory (
            memory_id, scope, scope_id, kind, content, source, sensitivity,
            created_at, updated_at, deleted_at, version
          )
          VALUES (
            ${resultId}, ${first.scope}, ${first.scopeId}, ${first.kind},
            ${decision.content.trim()}, ${source}, 'normal', ${newest}, ${nowIso}, NULL, 1
          )
        `;
      }
      const reason =
        decision.action === "merge"
          ? `Merged by the tidy-up: ${decision.reason}`
          : decision.by === null
            ? `Retired by the tidy-up: ${decision.reason}`
            : `Archived by the tidy-up for a newer entry: ${decision.reason}`;
      for (const id of ids) {
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = ${nowIso}, superseded_by = ${resultId},
              superseded_reason = ${reason}, version = version + 1
          WHERE memory_id = ${id} AND deleted_at IS NULL AND superseded_at IS NULL
        `;
      }
      return { resultId };
    }).pipe(sql.withTransaction);

  const recordChange = (
    runId: string,
    status: PersonalMemoryTidyChangeStatus,
    decision: TidyDecision,
    resultId: string | null,
    nowIso: string,
  ) => sql`
    INSERT INTO personal_memory_tidy_changes (
      run_id, status, action, scope, scope_id, memory_ids_json, result_memory_id, content,
      reason, created_at
    )
    VALUES (
      ${runId}, ${status}, ${decision.action}, 'shared', NULL,
      ${encodeIds(decision.memoryIds)}, ${resultId},
      ${decision.action === "merge" ? decision.content.trim() : null}, ${decision.reason}, ${nowIso}
    )
  `;

  /**
   * A proposal already waiting for the owner, or one they turned down: the
   * same change is not asked for again every night.
   */
  const alreadyAsked = (decision: TidyDecision) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM personal_memory_tidy_changes
      WHERE status IN ('pending', 'rejected') AND action = ${decision.action}
        AND memory_ids_json = ${encodeIds(decision.memoryIds)}
    `.pipe(Effect.map((rows) => (rows[0]?.count ?? 0) > 0));

  const readRuns = (limit: number, runId?: string) =>
    Effect.gen(function* () {
      const runs = yield* sql<RunRow>`
        SELECT run_id AS "runId", started_at AS "startedAt", finished_at AS "finishedAt", status,
          dry_run AS "dryRun", model, merged, superseded, pending, left_alone AS "leftAlone", error
        FROM personal_memory_tidy_runs
        WHERE ${runId === undefined ? sql`1 = 1` : sql`run_id = ${runId}`}
        ORDER BY started_at DESC
        LIMIT ${limit}
      `;
      if (runs.length === 0) return [];
      const changes = yield* sql<ChangeRow>`
        SELECT change_id AS "changeId", run_id AS "runId", status, action, scope,
          scope_id AS "scopeId", memory_ids_json AS "memoryIdsJson",
          result_memory_id AS "resultMemoryId", content, reason
        FROM personal_memory_tidy_changes
        WHERE ${sql.in(
          "run_id",
          runs.map((run) => run.runId),
        )}
        ORDER BY change_id
      `;
      return yield* Effect.forEach(runs, (run) =>
        decodeRun({
          ...run,
          dryRun: run.dryRun === 1,
          changes: changes
            .filter((change) => change.runId === run.runId)
            .map((change): Record<keyof PersonalMemoryTidyChange, unknown> => ({
              changeId: change.changeId,
              status: change.status,
              action: change.action,
              scope: change.scope,
              scopeId: change.scopeId,
              memoryIds: decodeIds(change.memoryIdsJson).map((id) => PersonalMemoryId.make(id)),
              resultMemoryId: change.resultMemoryId,
              content: change.content,
              reason: change.reason,
            })),
        }),
      );
    });

  const runOnce = (dryRun: boolean, nightly: boolean) =>
    Effect.gen(function* () {
      const runId = `tidy-${NodeCrypto.randomUUID()}`;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const nowMs = DateTime.toEpochMillis(now);
      yield* sql`
        INSERT INTO personal_memory_tidy_runs (run_id, started_at, status, dry_run, nightly, model)
        VALUES (${runId}, ${nowIso}, 'running', ${dryRun ? 1 : 0}, ${nightly ? 1 : 0}, ${judge.model})
      `;
      const outcome = yield* Effect.gen(function* () {
        const appVersion = yield* readAppVersion;
        const entries = yield* readEntries;
        const versions = new Map(entries.map((entry) => [entry.memoryId, entry.version]));
        const proposal = yield* plan(entries, nowMs, appVersion);
        let merged = 0;
        let superseded = 0;
        let pending = 0;
        let leftAlone = 0;
        for (const decision of proposal.auto) {
          const applied = dryRun
            ? { resultId: decision.action === "supersede" ? decision.by : null }
            : yield* applyDecision(decision, versions, `tidy:${runId}`, nowIso);
          if (applied === null) {
            yield* recordChange(
              runId,
              "left",
              {
                action: "leave",
                memoryIds: decision.memoryIds,
                reason: `Changed while the tidy-up ran; left as it is (${decision.reason})`,
              },
              null,
              nowIso,
            );
            leftAlone += 1;
            continue;
          }
          yield* recordChange(
            runId,
            dryRun ? "preview" : "applied",
            decision,
            applied.resultId,
            nowIso,
          );
          superseded += decision.memoryIds.length;
        }
        for (const decision of proposal.pending) {
          if (yield* alreadyAsked(decision)) continue;
          const resultId = decision.action === "supersede" ? decision.by : null;
          yield* recordChange(runId, "pending", decision, resultId, nowIso);
          pending += 1;
        }
        for (const decision of proposal.left) {
          yield* recordChange(runId, "left", decision, null, nowIso);
          leftAlone += 1;
        }
        return { merged, superseded, pending, leftAlone, error: proposal.error };
      }).pipe(Effect.result);
      const finishedIso = DateTime.formatIso(yield* DateTime.now);
      if (outcome._tag === "Failure") {
        yield* sql`
          UPDATE personal_memory_tidy_runs
          SET status = 'failed', finished_at = ${finishedIso},
              error = ${String(outcome.failure).slice(0, 1_000)}
          WHERE run_id = ${runId}
        `;
      } else {
        const { merged, superseded, pending, leftAlone, error } = outcome.success;
        yield* sql`
          UPDATE personal_memory_tidy_runs
          SET status = ${error === null ? "done" : "failed"}, finished_at = ${finishedIso},
              merged = ${merged}, superseded = ${superseded}, pending = ${pending},
              left_alone = ${leftAlone}, error = ${error === null ? null : error.slice(0, 1_000)}
          WHERE run_id = ${runId}
        `;
      }
      yield* Effect.logInfo("personal memory tidy-up finished", {
        runId,
        dryRun,
        nightly,
        model: judge.model,
        ...(outcome._tag === "Success"
          ? {
              superseded: outcome.success.superseded,
              pending: outcome.success.pending,
              leftAlone: outcome.success.leftAlone,
              judgeError: outcome.success.error !== null,
            }
          : { failed: true }),
      });
      const [run] = yield* readRuns(1, runId);
      return run!;
    }).pipe(lock.withPermits(1), storageFailure("run"));

  const decide: PersonalMemoryTidy["Service"]["decide"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<ChangeRow>`
        SELECT change_id AS "changeId", run_id AS "runId", status, action, scope,
          scope_id AS "scopeId", memory_ids_json AS "memoryIdsJson",
          result_memory_id AS "resultMemoryId", content, reason
        FROM personal_memory_tidy_changes WHERE change_id = ${input.changeId}
      `;
      const change = rows[0];
      if (change === undefined) return yield* fail("That tidy-up change was not found.");
      if (change.status !== "pending") {
        return yield* fail("That tidy-up change is not waiting for an answer.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      if (!input.approve) {
        yield* sql`
          UPDATE personal_memory_tidy_changes SET status = 'rejected', decided_at = ${nowIso}
          WHERE change_id = ${input.changeId}
        `;
        return yield* log({});
      }
      const memoryIds = decodeIds(change.memoryIdsJson);
      const decision: TidyDecision =
        change.action === "merge"
          ? { action: "merge", memoryIds, content: change.content ?? "", reason: change.reason }
          : { action: "supersede", memoryIds, by: change.resultMemoryId, reason: change.reason };
      if (decision.action === "merge" && looksLikeSecret(decision.content)) {
        return yield* fail("The merged text looks like it carries a secret; not applied.");
      }
      const applied = yield* applyDecision(decision, null, `tidy-approved:${change.runId}`, nowIso);
      if (applied === null) {
        return yield* fail(
          "One of these entries changed, was archived or was deleted since the tidy-up proposed this; nothing was changed.",
        );
      }
      yield* sql`
        UPDATE personal_memory_tidy_changes
        SET status = 'approved', decided_at = ${nowIso}, result_memory_id = ${applied.resultId}
        WHERE change_id = ${input.changeId}
      `;
      return yield* log({});
    }).pipe(lock.withPermits(1), storageFailure("decide"));

  const run: PersonalMemoryTidy["Service"]["run"] = (input) => runOnce(input.dryRun, false);

  const log: PersonalMemoryTidy["Service"]["log"] = (input) =>
    Effect.gen(function* () {
      return { mode: yield* readMode, runs: yield* readRuns(input.limit ?? 10) };
    }).pipe(storageFailure("log"));

  const setMode: PersonalMemoryTidy["Service"]["setMode"] = (mode) =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_memory_tidy_settings (settings_id, mode, updated_at)
        VALUES (1, ${mode}, ${nowIso})
        ON CONFLICT (settings_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
      `;
      return yield* log({});
    }).pipe(storageFailure("setMode"));

  /** The nightly check: due, and not switched off. */
  const nightly = Effect.gen(function* () {
    const mode = yield* readMode;
    if (mode === "off") return;
    // Once a day, whatever the outcome: a failed run waits for tomorrow.
    const last = yield* sql<{ readonly startedAt: string }>`
      SELECT started_at AS "startedAt" FROM personal_memory_tidy_runs
      WHERE nightly = 1 ORDER BY started_at DESC LIMIT 1
    `;
    const lastMs = last[0] === undefined ? null : Date.parse(last[0].startedAt);
    if (!nightlyRunDue(DateTime.toEpochMillis(yield* DateTime.now), lastMs)) return;
    yield* runOnce(mode !== "on", true);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("personal memory tidy-up check failed", { cause: Cause.pretty(cause) }),
    ),
  );

  // A run cut short by a restart would otherwise say "running" for ever.
  const closeInterrupted = sql`
    UPDATE personal_memory_tidy_runs
    SET status = 'failed', error = 'Interrupted by a server restart.'
    WHERE status = 'running'
  `.pipe(Effect.ignore);

  const start: PersonalMemoryTidy["Service"]["start"] = () =>
    process.env.PERSONAL_MEMORY_TIDY === "off"
      ? Effect.void
      : forkParked(
          closeInterrupted.pipe(
            Effect.andThen(nightly.pipe(Effect.repeat(Schedule.spaced(TIDY_CHECK_MS)))),
          ),
        ).pipe(Effect.asVoid);

  return { run, decide, log, setMode, start } satisfies PersonalMemoryTidy["Service"];
});

export const layer = Layer.effect(PersonalMemoryTidy, make);
