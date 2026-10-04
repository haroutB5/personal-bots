import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PERSONAL_MEMORY_MAX_LENGTH,
  PersonalMemoryError,
  PersonalMemoryId,
  PersonalMemorySplitPart,
  PersonalMemoryTidyMode,
  PersonalMemoryTidyRun,
  PersonalMemoryCardsResult,
  ProviderInstanceId,
  type PersonalMemoryTidyChangeStatus,
  type PersonalMemoryTidyChange,
  type PersonalMemoryTidyLogResult,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { isExpensiveSeedModel } from "../seedModel.ts";
import { SHIPPED_MEMORY_PROPOSALS } from "./shippedProposals.ts";
import { memoryAutoApplyEnabled } from "./memoryAutoApply.ts";
import { appsToJson, normaliseApps, parseAppsJson, unknownApps } from "./memoryApps.ts";
import {
  buildTidyPrompt,
  decisionsFromJudge,
  exactDuplicateDecisions,
  localDay,
  localMinuteOfDay,
  entrySnapshotsJson,
  matchesSnapshot,
  readEntrySnapshots,
  type EntrySnapshot,
  TIDY_MAX_ENTRIES_PER_CALL,
  TidyJudgeOutput,
  validateDecisions,
  type TidyDecision,
  type TidyEntry,
} from "./memoryTidy.ts";
import { looksLikeSecret, redactSecrets } from "./PersonalMemoryService.ts";
import { withStallJob } from "../../observability/stallJobs.ts";

/**
 * The nightly memory tidy-up. At 03:30 local time (or the first check after,
 * if the laptop slept) it reads every current shared and team note and
 * preference (bot and project entries are left alone), reach by reach, folds exact duplicates itself, asks a cheap model which entries are
 * the same subject or out of date, checks each answer (`memoryTidy.ts`) and,
 * in mode "on", supersedes or merges. It never deletes: superseded entries
 * keep their text and can be restored from the Memory screen. Every run and
 * change is written to the changelog, including what it left alone.
 *
 * Mode "on" (the default since 1.60.42) makes every change it checked itself,
 * its merges and retirements too, each with an Undo in the changelog (see
 * memoryAutoApply.ts). Mode "preview" does all of that but changes nothing, so
 * the owner can read what it would do first. Mode "off" skips the nightly run.
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
      /** The hash the owner's card or list showed; refused when it is not this change's. */
      readonly changeHash: string;
    }) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    /**
     * Takes back a change that was made (on its own, or approved): the entries
     * it archived are restored, what it made is archived, a rescope or
     * reclassify is put back. The tidy-up does not propose that change again.
     */
    readonly undo: (input: {
      readonly changeId: number;
      /** The hash the log showed; refused when it is not this change's. */
      readonly changeHash: string;
    }) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    /**
     * Startup: with the automatic mode on, the nightly mode nobody chose moves
     * to "on", and every change still waiting for the owner's OK is made now (one
     * whose entries moved since is left as it is; a bot's change with no chat of
     * the owner's behind it is taken off the list). A no-op with the switch off.
     */
    readonly applyWaiting: Effect.Effect<
      { readonly applied: number; readonly left: number; readonly withdrawn: number },
      PersonalMemoryError
    >;
    /** Bots' save/forget cards shown in one chat: pending, and decided in the last 7 days. */
    readonly cardsForThread: (
      threadId: string,
    ) => Effect.Effect<PersonalMemoryCardsResult, PersonalMemoryError>;
    readonly log: (input: {
      readonly limit?: number | undefined;
    }) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    readonly setMode: (
      mode: PersonalMemoryTidyMode,
    ) => Effect.Effect<PersonalMemoryTidyLogResult, PersonalMemoryError>;
    /** Puts one-off proposals on the approval list (see {@link ProposalFile}). */
    readonly importProposals: (input: {
      readonly source: string;
      readonly items: ReadonlyArray<ProposalItem>;
      readonly withdraw?: ReadonlyArray<ProposalWithdraw> | undefined;
    }) => Effect.Effect<PersonalMemoryTidyRun, PersonalMemoryError>;
    /**
     * Writes the proposals files shipped in this release into the inbox (once:
     * not when already there, imported or rejected), then imports every inbox
     * file this version is ready for; a file whose minVersion is newer waits.
     * Runs at startup; never fails.
     */
    readonly importInbox: (input: {
      readonly appVersion: string | null;
      readonly shipped?: ReadonlyArray<ShippedProposalFile> | undefined;
    }) => Effect.Effect<void>;
    /**
     * Startup: pending changes from before 1.60.21 whose entries are still as
     * proposed get their shown text recorded, so approval checks text. Returns
     * how many were upgraded.
     */
    readonly snapshotPendingTexts: Effect.Effect<number, PersonalMemoryError>;
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

const decodeCards = Schema.decodeUnknownEffect(PersonalMemoryCardsResult);

/**
 * What an approval is bound to: the change, the version of every entry it
 * names, and (from 1.60.21) each entry's text, kind and reach as the owner was
 * shown them.
 */
export const changeHashOf = (change: {
  readonly changeId: number;
  readonly action: string;
  readonly memoryIdsJson: string;
  readonly resultMemoryId: string | null;
  readonly content: string | null;
  readonly toKind?: string | null;
  readonly toScope?: string | null;
  readonly toScopeId?: string | null;
  readonly versionsJson?: string | null;
  readonly entrySnapshotsJson?: string | null;
  /** A rescope's or a bot save's apps; only rows that have them add it to the hash. */
  readonly toAppsJson?: string | null;
}) =>
  NodeCrypto.createHash("sha256")
    .update(
      [
        change.changeId,
        change.action,
        change.memoryIdsJson,
        change.resultMemoryId ?? "",
        change.content ?? "",
        change.toKind ?? "",
        change.toScope ?? "",
        change.toScopeId ?? "",
        change.versionsJson ?? "",
        // Only rows that have snapshots: older rows keep the hash they had.
        ...(change.entrySnapshotsJson == null ? [] : [change.entrySnapshotsJson]),
        ...(change.toAppsJson == null ? [] : [`apps:${change.toAppsJson}`]),
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 32);

/** Reasons, errors and names stored or shown beside memory never carry a secret. */
const safeText = (text: string) => redactSecrets(text);

const encodeVersionMap = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);
const decodeVersionMap = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
);

/** The version of every named entry, as stored with a proposal. */
const versionsJson = (ids: ReadonlyArray<string>, versions: ReadonlyMap<string, number>) =>
  encodeVersionMap(
    Object.fromEntries(
      ids.flatMap((id) => (versions.has(id) ? [[id, versions.get(id)!] as const] : [])),
    ),
  );

/** At most this many proposal files are read at one start, each at most this size. */
export const MEMORY_PROPOSALS_MAX_FILES = 5;
export const MEMORY_PROPOSALS_MAX_BYTES = 256 * 1024;

/** The inbox for one-off proposal files, under `<baseDir>/personal/`. */
export const MEMORY_PROPOSALS_DIR = "memory-proposals";

const ProposalItemSchema = Schema.Struct({
  action: Schema.Literals(["reclassify", "supersede", "split", "rescope"]),
  memoryIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  by: Schema.optional(Schema.NullOr(Schema.String)),
  /** A split's single facts, each with its own kind and reach. */
  parts: Schema.optional(Schema.Array(PersonalMemorySplitPart).check(Schema.isMaxLength(20))),
  toKind: Schema.optional(Schema.NullOr(Schema.Literals(["note", "preference"]))),
  toScope: Schema.optional(Schema.NullOr(Schema.Literals(["shared", "team"]))),
  toScopeId: Schema.optional(Schema.NullOr(Schema.String)),
  /** A rescope's apps (slugs); null or empty is global. */
  toApps: Schema.optional(Schema.NullOr(Schema.Array(Schema.String).check(Schema.isMaxLength(8)))),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(600)),
});
export type ProposalItem = typeof ProposalItemSchema.Type;

/**
 * A split as stored: the long entry's text as the owner was shown it (its
 * approval holds the entry to that text, so a reach change in between does
 * not make it stale) and the parts.
 */
const StoredSplit = Schema.Struct({
  from: Schema.String,
  parts: Schema.Array(PersonalMemorySplitPart),
});
const encodeSplit = Schema.encodeSync(Schema.fromJsonString(StoredSplit));
const decodeSplit = Schema.decodeUnknownOption(Schema.fromJsonString(StoredSplit));

/**
 * What a change needs to be taken back: the entries a rescope, reclassify or
 * split touched, as they were, and the entries a split made.
 */
const StoredUndo = Schema.Struct({
  before: Schema.Array(
    Schema.Struct({
      memoryId: Schema.String,
      kind: Schema.String,
      scope: Schema.String,
      scopeId: Schema.NullOr(Schema.String),
      appsJson: Schema.NullOr(Schema.String),
    }),
  ),
  created: Schema.optional(Schema.Array(Schema.String)),
});
const encodeUndo = Schema.encodeSync(Schema.fromJsonString(StoredUndo));
const decodeUndo = Schema.decodeUnknownOption(Schema.fromJsonString(StoredUndo));

/** Why an entry was archived by a tidy-up change; an Undo brings back only these. */
const RETIRED_PREFIX = "Retired by the tidy-up";
const BOT_FORGET_REASON = "Forgotten with your approval.";
const UNDONE_FROM_LOG = "Undone from the log.";

/**
 * A pending item an earlier proposals file put on the list, taken back. The
 * entries it names must match, so an id from another data root cannot take
 * back an unrelated item.
 */
const ProposalWithdrawSchema = Schema.Struct({
  changeId: Schema.Number,
  memoryIds: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
export type ProposalWithdraw = typeof ProposalWithdrawSchema.Type;

/**
 * A proposals file: `{ "minVersion"?, "withdraw"?: [...], "items": [...] }`,
 * at most 200 items. A file waits in the inbox until the running app version
 * reaches minVersion.
 */
export const ProposalFile = Schema.Struct({
  minVersion: Schema.optional(Schema.String),
  withdraw: Schema.optional(Schema.Array(ProposalWithdrawSchema).check(Schema.isMaxLength(200))),
  items: Schema.Array(ProposalItemSchema).check(Schema.isMaxLength(200)),
});

/** A proposals file that ships inside the release (see shippedProposals.ts). */
export interface ShippedProposalFile {
  readonly name: string;
  readonly file: unknown;
}

const versionParts = (version: string) =>
  version
    .trim()
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/** Whether this app version may import a file asking for `minVersion`. */
export function proposalFileReady(
  file: { readonly minVersion?: string | undefined },
  appVersion: string | null,
): boolean {
  if (file.minVersion === undefined) return true;
  if (appVersion === null) return false;
  const want = versionParts(file.minVersion);
  const have = versionParts(appVersion);
  for (let index = 0; index < Math.max(want.length, have.length); index++) {
    const difference = (have[index] ?? 0) - (want[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
const decodeProposalFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ProposalFile));
const decodeShippedFile = Schema.decodeUnknownEffect(ProposalFile);
const encodeProposalFile = Schema.encodeEffect(Schema.fromJsonString(ProposalFile));

/** Why a proposal cannot go on the approval list, or null when it can. */
export function proposalProblem(
  item: ProposalItem,
  current: ReadonlyMap<string, Pick<TidyEntry, "kind" | "scope" | "apps">>,
): string | null {
  if (item.memoryIds.some((id) => !current.has(id))) {
    return "Names an entry that is not a current shared or team entry";
  }
  if (item.action === "rescope") {
    if (item.memoryIds.length !== 1) return "A rescope names exactly one entry";
    const entry = current.get(item.memoryIds[0]!)!;
    if (entry.kind !== "preference") return "Only a rule (a preference) has an app scope";
    if (unknownApps(item.toApps ?? []).length > 0) return "Names an app that is not registered";
    if (appsToJson(item.toApps) === appsToJson(parseAppsJson(entry.apps))) return "Changes nothing";
    return null;
  }
  if (item.action === "reclassify") {
    if (item.memoryIds.length !== 1) return "A reclassify names exactly one entry";
    const entry = current.get(item.memoryIds[0]!)!;
    if (entry.scope !== "shared") return "Only a shared entry is reclassified";
    const toScope = item.toScope ?? "shared";
    if (toScope === "team" && (item.toScopeId ?? "").trim().length === 0) {
      return "A team reach needs the team's name";
    }
    if ((item.toKind ?? entry.kind) === entry.kind && toScope === "shared") {
      return "Changes nothing";
    }
    return null;
  }
  if (item.action === "split") {
    if (item.memoryIds.length !== 1) return "A split names exactly one entry";
    const parts = item.parts ?? [];
    if (parts.length === 0) return "A split needs its parts";
    for (const part of parts) {
      const content = part.content.trim();
      if (content.length === 0 || content.length > PERSONAL_MEMORY_MAX_LENGTH) {
        return "A part is empty or too long";
      }
      if (looksLikeSecret(content)) return "A part looks like it carries a secret";
      if (part.scope === "team" && (part.scopeId ?? "").trim().length === 0) {
        return "A team reach needs the team's name";
      }
    }
    return null;
  }
  if (item.by === undefined || item.by === null || !current.has(item.by)) {
    return "Names a newer entry that is not a current shared or team entry";
  }
  if (item.memoryIds.includes(item.by)) return "An entry cannot replace itself";
  return null;
}

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
  appsJson: Schema.NullOr(Schema.String),
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
  /** What an Undo needs (see StoredUndo); null on changes made before it existed. */
  readonly undoJson?: string | null;
  /** 1 when undoJson is set (the log's select does not carry the text itself). */
  readonly hasUndo?: number;
  readonly toAppsJson?: string | null;
  readonly threadId?: string | null;
  /** Per-entry text, kind and reach as shown (null on rows from before 1.60.21). */
  readonly entrySnapshotsJson?: string | null;
  readonly createdAt?: string;
  readonly decidedAt?: string | null;
  readonly versionsJson?: string | null;
  readonly proposedBy?: string | null;
  readonly toKind?: string | null;
  readonly toScope?: string | null;
  readonly toScopeId?: string | null;
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
  const baseDir = config._tag === "Some" ? config.value.baseDir : undefined;
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
  `.pipe(
    Effect.map((rows) =>
      isTidyMode(rows[0]?.mode)
        ? rows[0]!.mode
        : memoryAutoApplyEnabled()
          ? ("on" as const)
          : ("preview" as const),
    ),
  );

  // Shared and team entries; bot-only entries are left to the bot that owns them.
  const readEntries = sql`
    SELECT memory_id AS "memoryId", scope, scope_id AS "scopeId", kind, content, source,
      created_at AS "createdAt", updated_at AS "updatedAt", version, apps_json AS "appsJson"
    FROM personal_memory
    WHERE deleted_at IS NULL AND superseded_at IS NULL AND scope IN ('shared', 'team')
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
        apps: row.appsJson,
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
        if (output._tag === "Success") {
          judged = decisionsFromJudge(output.success, refs).map((decision) => ({
            ...decision,
            reason: safeText(decision.reason),
          }));
        } else error = output.failure;
      }
      return {
        ...validateDecisions(entries, [...exact, ...judged], nowMs, looksLikeSecret, {
          autoAll: memoryAutoApplyEnabled(),
        }),
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
    versions: ReadonlyMap<string, number>,
    source: string,
    nowIso: string,
    /**
     * A supersede's newer entry as the owner was shown it. Given, that entry
     * only has to still read exactly so (a reach or kind change in between is
     * fine); otherwise it is held to its recorded version like the rest.
     */
    byText?: string | null,
    /** Per-entry snapshots as shown; an entry named here is held to them, not its version. */
    snapshots: ReadonlyMap<string, EntrySnapshot> = new Map(),
  ) =>
    Effect.gen(function* () {
      if (decision.action === "leave") return null;
      const ids = decision.memoryIds;
      const by = decision.action === "supersede" ? decision.by : null;
      const touched =
        decision.action === "supersede" && decision.by !== null ? [...ids, decision.by] : ids;
      const current = yield* sql<{
        readonly memoryId: string;
        readonly version: number;
        readonly kind: string;
        readonly scope: string;
        readonly scopeId: string | null;
        readonly createdAt: string;
        readonly content: string;
        readonly appsJson: string | null;
      }>`
        SELECT memory_id AS "memoryId", version, kind, scope, scope_id AS "scopeId",
          created_at AS "createdAt", content, apps_json AS "appsJson"
        FROM personal_memory
        WHERE deleted_at IS NULL AND superseded_at IS NULL AND scope IN ('shared', 'team')
          AND ${sql.in("memory_id", touched)}
      `;
      const byId = new Map(current.map((row) => [row.memoryId, row]));
      const intact = touched.every((id) => {
        const row = byId.get(id);
        if (row === undefined) return false;
        if (id === by && byText != null) return row.content === byText;
        // The archived and merged entries must still read, and reach, as shown;
        // the entry a supersede keeps only has to keep its text.
        const snapshot = snapshots.get(id);
        if (snapshot !== undefined) return matchesSnapshot(row, snapshot);
        // Every entry must be exactly as it was when the change was planned.
        return versions.get(id) === row.version;
      });
      if (!intact) return null;
      // The entries archived or merged share one reach: a merge never moves a
      // fact to bots that did not have it.
      const reaches = new Set(
        ids.map(
          (id) =>
            `${byId.get(id)!.scope}:${byId.get(id)!.scopeId ?? ""}:${byId.get(id)!.appsJson ?? ""}`,
        ),
      );
      if (reaches.size > 1) return null;
      let resultId: string | null = decision.action === "supersede" ? decision.by : null;
      if (decision.action === "merge") {
        const members = ids.map((id) => byId.get(id)!);
        // The kind and reach the owner was shown, not whatever they are now.
        const shown = snapshots.get(ids[0]!);
        const first = shown === undefined ? members[0]! : { ...members[0]!, ...shown };
        resultId = NodeCrypto.randomUUID();
        // Dated by its newest member, so it keeps its place among the others.
        const newest = members
          .map((row) => row.createdAt)
          .toSorted()
          .at(-1)!;
        yield* sql`
          INSERT INTO personal_memory (
            memory_id, scope, scope_id, kind, content, source, sensitivity,
            created_at, updated_at, deleted_at, version, apps_json
          )
          VALUES (
            ${resultId}, ${first.scope}, ${first.scopeId}, ${first.kind},
            ${decision.content.trim()}, ${source}, 'normal', ${newest}, ${nowIso}, NULL, 1,
            ${first.kind === "preference" ? (members[0]!.appsJson ?? null) : null}
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
    versions: ReadonlyMap<string, number>,
    reach: { readonly scope: string; readonly scopeId: string | null },
    entries: ReadonlyMap<string, TidyEntry>,
    /** A supersede's newer entry text, as listed for the owner. */
    byText: string | null = null,
  ) => {
    const named = resultId === null ? decision.memoryIds : [...decision.memoryIds, resultId];
    return sql`
      INSERT INTO personal_memory_tidy_changes (
        run_id, status, action, scope, scope_id, memory_ids_json, result_memory_id, content,
        versions_json, proposed_by, reason, created_at, entry_snapshots_json
      )
      VALUES (
        ${runId}, ${status}, ${decision.action}, ${reach.scope}, ${reach.scopeId},
        ${encodeIds(decision.memoryIds)}, ${resultId},
        ${decision.action === "merge" ? decision.content.trim() : byText},
        ${versionsJson(named, versions)}, 'tidy-up', ${safeText(decision.reason)}, ${nowIso},
        ${entrySnapshotsJson(
          named.flatMap((id) => (entries.has(id) ? [entries.get(id)!] : [])),
          new Set(decision.action === "supersede" && resultId !== null ? [resultId] : []),
        )}
      )
    `;
  };

  /**
   * A proposal already waiting for the owner, or one they turned down: the
   * same change is not asked for again every night.
   */
  const alreadyAsked = (decision: TidyDecision) =>
    askedBefore({
      action: decision.action,
      memoryIds: decision.memoryIds,
      resultId: decision.action === "supersede" ? decision.by : null,
      content: decision.action === "merge" ? decision.content.trim() : undefined,
      toKind: null,
      toScope: null,
      toScopeId: null,
    });

  /** The same change (every field) is already waiting or was turned down. */
  const askedBefore = (change: {
    readonly action: string;
    readonly memoryIds: ReadonlyArray<string>;
    readonly resultId: string | null;
    /** Undefined: not compared (a supersede's copy of the newer text). */
    readonly content: string | null | undefined;
    readonly toKind: string | null;
    readonly toScope: string | null;
    readonly toScopeId: string | null;
    /** A rescope's apps as stored (null: global, or not a rescope). */
    readonly toAppsJson?: string | null;
  }) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM personal_memory_tidy_changes
      WHERE (
        status IN ('pending', 'rejected') AND action = ${change.action}
        AND memory_ids_json = ${encodeIds(change.memoryIds)}
        AND result_memory_id IS ${change.resultId}
        AND ${change.content === undefined ? sql`1 = 1` : sql`content IS ${change.content}`}
        AND to_kind IS ${change.toKind}
        AND to_scope IS ${change.toScope}
        AND to_scope_id IS ${change.toScopeId}
        AND to_apps_json IS ${change.toAppsJson ?? null}
      ) OR (
        -- Taken back by the owner: the same action on the same entries is not made again,
        -- whatever its new wording or result.
        status = 'undone' AND action = ${change.action}
        AND memory_ids_json = ${encodeIds(change.memoryIds)}
      )
    `.pipe(Effect.map((rows) => (rows[0]?.count ?? 0) > 0));

  /**
   * The newest runs, plus every older one that still has a change waiting
   * for the owner's OK: the Waiting list must never lose a group because
   * nightly previews pushed it past the limit.
   */
  const readRuns = (limit: number, runId?: string) =>
    Effect.gen(function* () {
      const runs = yield* sql<RunRow>`
        SELECT run_id AS "runId", started_at AS "startedAt", finished_at AS "finishedAt", status,
          dry_run AS "dryRun", model, merged, superseded, pending, left_alone AS "leftAlone", error
        FROM personal_memory_tidy_runs r
        WHERE ${
          runId !== undefined
            ? sql`r.run_id = ${runId}`
            : sql`(
                r.run_id IN (
                  SELECT run_id FROM personal_memory_tidy_runs ORDER BY started_at DESC LIMIT ${limit}
                )
                OR EXISTS (
                  SELECT 1 FROM personal_memory_tidy_changes c
                  WHERE c.run_id = r.run_id AND c.status = 'pending'
                )
              )`
        }
        ORDER BY started_at DESC
        LIMIT ${runId === undefined ? -1 : limit}
      `;
      if (runs.length === 0) return [];
      const changes = yield* sql<ChangeRow>`
        SELECT change_id AS "changeId", run_id AS "runId", status, action, scope,
          scope_id AS "scopeId", memory_ids_json AS "memoryIdsJson",
          result_memory_id AS "resultMemoryId", content, reason,
          to_kind AS "toKind", to_scope AS "toScope", to_scope_id AS "toScopeId",
          proposed_by AS "proposedBy", versions_json AS "versionsJson",
          entry_snapshots_json AS "entrySnapshotsJson", to_apps_json AS "toAppsJson",
          undo_json IS NOT NULL AS "hasUndo"
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
              bound: [...readEntrySnapshots(change.entrySnapshotsJson)].map(
                ([memoryId, snapshot]) => ({
                  memoryId,
                  kind: snapshot.kind,
                  scope: snapshot.scope,
                  scopeId: snapshot.scopeId,
                  textOnly: snapshot.textOnly,
                }),
              ),
              parts:
                change.action === "split"
                  ? Option.match(decodeSplit(change.content ?? ""), {
                      onNone: () => [],
                      onSome: (split) => split.parts,
                    })
                  : undefined,
              toKind: change.toKind ?? null,
              toScope: change.toScope ?? null,
              toScopeId: change.toScopeId ?? null,
              toApps:
                change.action === "rescope" || change.action === "save"
                  ? parseAppsJson(change.toAppsJson)
                  : null,
              proposedBy: change.proposedBy ?? null,
              changeHash: changeHashOf(change),
              // A rescope, reclassify or split made before 1.60.42 kept nothing to put back.
              undoable:
                (change.status === "applied" || change.status === "approved") &&
                (change.hasUndo === 1 ||
                  !(
                    change.action === "rescope" ||
                    change.action === "reclassify" ||
                    change.action === "split"
                  )),
              content: change.action === "split" ? null : change.content,
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
        const byMemoryId = new Map(entries.map((entry) => [entry.memoryId, entry]));
        // Each reach on its own: shared entries, then each team's. A rule is
        // never merged into, or archived for, an entry other bots see.
        const reaches = new Map<string, Array<TidyEntry>>();
        for (const entry of entries) {
          const key = `${entry.scope}:${entry.scopeId ?? ""}:${entry.apps ?? ""}`;
          reaches.set(key, [...(reaches.get(key) ?? []), entry]);
        }
        const plans = yield* Effect.forEach([...reaches.values()], (group) =>
          plan(group, nowMs, appVersion),
        );
        const proposal = {
          auto: plans.flatMap((planned) => planned.auto),
          pending: plans.flatMap((planned) => planned.pending),
          left: plans.flatMap((planned) => planned.left),
          error: plans.find((planned) => planned.error !== null)?.error ?? null,
        };
        const reachOf = (decision: TidyDecision) => {
          const entry = byMemoryId.get(decision.memoryIds[0] ?? "");
          return { scope: entry?.scope ?? "shared", scopeId: entry?.scopeId ?? null };
        };
        const byTextOf = (decision: TidyDecision) =>
          decision.action === "supersede" && decision.by !== null
            ? (byMemoryId.get(decision.by)?.content ?? null)
            : null;
        // With the automatic mode on, merges and retirements are made like the rest (each
        // with an Undo); with it off, a merge's new wording waits for the owner's OK.
        let mergesProposed = 0;
        let merged = 0;
        let superseded = 0;
        let pending = 0;
        let leftAlone = 0;
        for (const decision of proposal.auto) {
          // Taken back, turned down or already waiting: not made again.
          if (yield* alreadyAsked(decision)) continue;
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
              versions,
              reachOf(decision),
              byMemoryId,
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
            versions,
            reachOf(decision),
            byMemoryId,
            byTextOf(decision),
          );
          if (decision.action === "merge") merged += 1;
          else superseded += decision.memoryIds.length;
        }
        for (const decision of proposal.pending) {
          if (yield* alreadyAsked(decision)) continue;
          const resultId = decision.action === "supersede" ? decision.by : null;
          yield* recordChange(
            runId,
            "pending",
            decision,
            resultId,
            nowIso,
            versions,
            reachOf(decision),
            byMemoryId,
            byTextOf(decision),
          );
          pending += 1;
          if (decision.action === "merge") mergesProposed += 1;
        }
        for (const decision of proposal.left) {
          yield* recordChange(
            runId,
            "left",
            decision,
            null,
            nowIso,
            versions,
            reachOf(decision),
            byMemoryId,
          );
          leftAlone += 1;
        }
        return { mergesProposed, merged, superseded, pending, leftAlone, error: proposal.error };
      }).pipe(Effect.result);
      const finishedIso = DateTime.formatIso(yield* DateTime.now);
      if (outcome._tag === "Failure") {
        yield* sql`
          UPDATE personal_memory_tidy_runs
          SET status = 'failed', finished_at = ${finishedIso},
              error = ${safeText(String(outcome.failure)).slice(0, 1_000)}
          WHERE run_id = ${runId}
        `;
      } else {
        const { merged, superseded, pending, leftAlone, error } = outcome.success;
        // `merged` is the merges this run made itself (none while the automatic mode is off).
        yield* sql`
          UPDATE personal_memory_tidy_runs
          SET status = ${error === null ? "done" : "failed"}, finished_at = ${finishedIso},
              merged = ${merged}, superseded = ${superseded}, pending = ${pending},
              left_alone = ${leftAlone}, error = ${error === null ? null : safeText(error).slice(0, 1_000)}
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
              merged: outcome.success.merged,
              superseded: outcome.success.superseded,
              pending: outcome.success.pending,
              mergesProposed: outcome.success.mergesProposed,
              leftAlone: outcome.success.leftAlone,
              judgeError: outcome.success.error !== null,
            }
          : { failed: true }),
      });
      const [run] = yield* readRuns(1, runId);
      return run!;
    }).pipe(lock.withPermits(1), storageFailure("run"));

  /**
   * Changes one current shared entry's kind and reach, never its text. False
   * when it is no longer current, or no longer shared.
   */
  const applyReclassify = (
    memoryId: string,
    change: Pick<ChangeRow, "toKind" | "toScope" | "toScopeId">,
    versions: ReadonlyMap<string, number>,
    nowIso: string,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly kind: string;
        readonly scope: string;
        readonly version: number;
      }>`
        SELECT kind, scope, version FROM personal_memory
        WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      const entry = rows[0];
      if (
        entry === undefined ||
        entry.scope !== "shared" ||
        entry.kind === "task_summary" ||
        versions.get(memoryId) !== entry.version
      ) {
        return false;
      }
      const kind = change.toKind ?? entry.kind;
      const scope = change.toScope ?? "shared";
      const scopeId = scope === "team" ? (change.toScopeId ?? null) : null;
      if (scope === "team" && (scopeId === null || scopeId.trim().length === 0)) return false;
      yield* sql`
        UPDATE personal_memory
        SET kind = ${kind}, scope = ${scope}, scope_id = ${scopeId},
            updated_at = ${nowIso}, version = version + 1
        WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      return true;
    }).pipe(sql.withTransaction);

  /**
   * A one-off list of proposals (reclassify an entry, archive older entries
   * for a newer one) put on the owner's approval list: nothing is changed
   * until they approve each item. Items naming an entry that is not a current
   * shared one, or already asked, are recorded as left with the reason.
   */
  const importProposals: PersonalMemoryTidy["Service"]["importProposals"] = (input) =>
    Effect.gen(function* () {
      const runId = `proposals-${NodeCrypto.randomUUID()}`;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO personal_memory_tidy_runs (run_id, started_at, status, dry_run, nightly, model)
        VALUES (${runId}, ${nowIso}, 'running', 1, 0,
          ${`proposals: ${safeText(input.source)}`.slice(0, 200)})
      `;
      // Taken back first: only items still waiting that a proposals file
      // made, naming the same entries. Memory itself is never touched.
      const withdrawn: Array<number> = [];
      const notWithdrawn: Array<number> = [];
      for (const take of input.withdraw ?? []) {
        const rows = yield* sql<{ readonly id: number }>`
          UPDATE personal_memory_tidy_changes
          SET status = 'withdrawn', decided_at = ${nowIso}
          WHERE change_id = ${take.changeId} AND status = 'pending'
            AND proposed_by LIKE 'file:%' AND memory_ids_json = ${encodeIds(take.memoryIds)}
          RETURNING change_id AS "id"
        `;
        (rows.length > 0 ? withdrawn : notWithdrawn).push(take.changeId);
      }
      if (withdrawn.length + notWithdrawn.length > 0) {
        yield* sql`
          UPDATE personal_memory_tidy_runs SET pending = (
            SELECT COUNT(*) FROM personal_memory_tidy_changes c
            WHERE c.run_id = personal_memory_tidy_runs.run_id AND c.status = 'pending'
          )
          WHERE run_id IN (
            SELECT run_id FROM personal_memory_tidy_changes WHERE status = 'withdrawn'
          )
        `;
        yield* Effect.logInfo("personal memory proposals withdrawn", {
          source: safeText(input.source),
          withdrawn,
          notWithdrawn,
        });
      }
      const entries = yield* readEntries;
      const current = new Map(entries.map((entry) => [entry.memoryId, entry] as const));
      const versions = new Map(entries.map((entry) => [entry.memoryId, entry.version]));
      let pending = 0;
      let leftAlone = 0;
      // What the owner is shown beside the entries: a supersede's newer
      // text (its approval holds that entry to it), a split's parts.
      const contentOf = (item: ProposalItem) =>
        item.action === "supersede"
          ? (current.get(item.by ?? "")?.content ?? null)
          : item.action === "split"
            ? encodeSplit({
                from: current.get(item.memoryIds[0] ?? "")?.content ?? "",
                parts: (item.parts ?? []).map((part) => ({
                  content: part.content.trim(),
                  kind: part.kind,
                  scope: part.scope,
                  scopeId: part.scope === "team" ? (part.scopeId?.trim() ?? null) : null,
                })),
              })
            : null;
      const insert = (
        status: PersonalMemoryTidyChangeStatus,
        item: ProposalItem,
        reason: string,
      ) => sql`
        INSERT INTO personal_memory_tidy_changes (
          run_id, status, action, scope, scope_id, memory_ids_json, result_memory_id, content,
          to_kind, to_scope, to_scope_id, versions_json, proposed_by, reason, created_at,
          entry_snapshots_json, to_apps_json
        )
        VALUES (
          ${runId}, ${status}, ${status === "left" ? "leave" : item.action},
          ${current.get(item.memoryIds[0] ?? "")?.scope ?? "shared"},
          ${current.get(item.memoryIds[0] ?? "")?.scopeId ?? null},
          ${encodeIds(item.memoryIds)}, ${item.action === "supersede" ? (item.by ?? null) : null},
          ${status === "left" ? null : contentOf(item)}, ${item.toKind ?? null}, ${item.toScope ?? null},
          ${item.toScope === "team" ? (item.toScopeId ?? null) : null},
          ${versionsJson(
            item.action === "supersede" && item.by != null
              ? [...item.memoryIds, item.by]
              : item.memoryIds,
            versions,
          )},
          ${`file:${safeText(input.source)}`.slice(0, 200)}, ${safeText(reason).slice(0, 700)}, ${nowIso},
          ${entrySnapshotsJson(
            (item.action === "supersede" && item.by != null
              ? [...item.memoryIds, item.by]
              : item.memoryIds
            ).flatMap((id) => (current.has(id) ? [current.get(id)!] : [])),
            new Set(item.action === "supersede" && item.by != null ? [item.by] : []),
          )},
          ${item.action === "rescope" && status !== "left" ? appsToJson(item.toApps) : null}
        )
      `;
      for (const item of input.items) {
        const problem = proposalProblem(item, current);
        if (problem !== null) {
          yield* insert("left", item, `${problem} (${item.reason})`);
          leftAlone += 1;
          continue;
        }
        const asked = yield* askedBefore({
          action: item.action,
          memoryIds: item.memoryIds,
          resultId: item.action === "supersede" ? (item.by ?? null) : null,
          content: item.action === "supersede" ? undefined : contentOf(item),
          toKind: item.toKind ?? null,
          toScope: item.toScope ?? null,
          toScopeId: item.toScope === "team" ? (item.toScopeId ?? null) : null,
          toAppsJson: item.action === "rescope" ? appsToJson(item.toApps) : null,
        });
        if (asked) continue;
        yield* insert("pending", item, item.reason);
        pending += 1;
      }
      yield* sql`
        UPDATE personal_memory_tidy_runs
        SET status = 'done', finished_at = ${nowIso}, pending = ${pending}, left_alone = ${leftAlone}
        WHERE run_id = ${runId}
      `;
      // The owner's OK is not waited for: the items are made now, each with an Undo in the log.
      const settled = memoryAutoApplyEnabled()
        ? yield* settlePending(yield* readPending(runId))
        : { applied: 0, left: 0, withdrawn: 0 };
      yield* Effect.logInfo("personal memory proposals imported", {
        source: safeText(input.source),
        pending,
        leftAlone,
        ...(settled.applied + settled.left > 0
          ? { applied: settled.applied, leftStale: settled.left }
          : {}),
      });
      const [run] = yield* readRuns(1, runId);
      return run!;
    }).pipe(lock.withPermits(1), storageFailure("import"));

  /** `<baseDir>/personal/memory-proposals/*.json`, each imported once, then moved aside. */
  const importInbox: PersonalMemoryTidy["Service"]["importInbox"] = (input) =>
    baseDir === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const inbox = path.join(baseDir, "personal", MEMORY_PROPOSALS_DIR);
          // The release's own files go in once; a file already handled stays handled.
          for (const shipped of input.shipped ?? []) {
            const seen = yield* Effect.forEach(
              [
                path.join(inbox, shipped.name),
                path.join(inbox, "imported", shipped.name),
                path.join(inbox, "rejected", shipped.name),
              ],
              (file) => fileSystem.exists(file),
            );
            if (seen.some(Boolean)) continue;
            const text = yield* decodeShippedFile(shipped.file).pipe(
              Effect.flatMap(encodeProposalFile),
            );
            yield* fileSystem.makeDirectory(inbox, { recursive: true });
            yield* fileSystem.writeFileString(path.join(inbox, shipped.name), `${text}\n`);
          }
          if (!(yield* fileSystem.exists(inbox))) return;
          const names = (yield* fileSystem.readDirectory(inbox)).filter((name) =>
            name.endsWith(".json"),
          );
          for (const name of names.toSorted().slice(0, MEMORY_PROPOSALS_MAX_FILES)) {
            const file = path.join(inbox, name);
            const info = yield* fileSystem.stat(file);
            const tooBig = Number(info.size) > MEMORY_PROPOSALS_MAX_BYTES;
            const parsed = tooBig
              ? undefined
              : yield* fileSystem
                  .readFileString(file)
                  .pipe(Effect.flatMap(decodeProposalFile), Effect.result);
            const ok = parsed !== undefined && parsed._tag === "Success";
            if (ok && !proposalFileReady(parsed.success, input.appVersion)) {
              // Made for a newer app: it waits here, untouched, for that version.
              yield* Effect.logInfo("personal memory proposals file waits for a newer version", {
                file: safeText(name),
                minVersion: parsed.success.minVersion,
                appVersion: input.appVersion,
              });
              continue;
            }
            const target = ok ? "imported" : "rejected";
            if (ok) {
              yield* importProposals({
                source: name,
                items: parsed.success.items,
                withdraw: parsed.success.withdraw,
              });
            } else {
              // The reason only: a parse error can quote the file's text.
              yield* Effect.logWarning("personal memory proposals file rejected", {
                file: safeText(name),
                reason: tooBig ? "too large" : "not a valid proposals file",
              });
            }
            yield* fileSystem.makeDirectory(path.join(inbox, target), { recursive: true });
            yield* fileSystem.rename(file, path.join(inbox, target, name));
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("personal memory proposals import failed", {
                  cause: safeText(Cause.pretty(cause)).slice(0, 2_000),
                }),
          ),
        );

  const cardsForThread: PersonalMemoryTidy["Service"]["cardsForThread"] = (threadId) =>
    Effect.gen(function* () {
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 }));
      const rows = yield* sql<ChangeRow>`
        SELECT change_id AS "changeId", run_id AS "runId", status, action, scope,
          scope_id AS "scopeId", memory_ids_json AS "memoryIdsJson",
          result_memory_id AS "resultMemoryId", content, reason,
          to_kind AS "toKind", to_scope AS "toScope", to_scope_id AS "toScopeId",
          versions_json AS "versionsJson", proposed_by AS "proposedBy",
          thread_id AS "threadId", created_at AS "createdAt", decided_at AS "decidedAt",
          entry_snapshots_json AS "entrySnapshotsJson", to_apps_json AS "toAppsJson"
        FROM personal_memory_tidy_changes
        WHERE thread_id = ${threadId} AND action IN ('save', 'forget')
          AND (status = 'pending' OR created_at >= ${since})
        ORDER BY created_at, change_id
        LIMIT 100
      `;
      const ids = [...new Set(rows.flatMap((row) => decodeIds(row.memoryIdsJson)))];
      const targets =
        ids.length === 0
          ? []
          : yield* sql<{
              readonly memoryId: string;
              readonly kind: string;
              readonly scope: string;
              readonly scopeId: string | null;
              readonly content: string;
            }>`
              SELECT memory_id AS "memoryId", kind, scope, scope_id AS "scopeId", content
              FROM personal_memory WHERE ${sql.in("memory_id", ids)}
            `;
      const byId = new Map(targets.map((row) => [row.memoryId, row]));
      return yield* decodeCards({
        cards: rows.map((row) => ({
          changeId: row.changeId,
          changeHash: changeHashOf(row),
          threadId,
          action: row.action,
          proposedBy: row.proposedBy ?? null,
          content: row.content,
          kind: row.toKind ?? null,
          scope: row.toScope ?? null,
          scopeId: row.toScopeId ?? null,
          apps: parseAppsJson(row.toAppsJson),
          // Each target as the card is bound to it: its kind and reach as proposed.
          targets: decodeIds(row.memoryIdsJson).flatMap((id) => {
            const target = byId.get(id);
            if (target === undefined) return [];
            const shown = readEntrySnapshots(row.entrySnapshotsJson).get(id);
            return [
              shown === undefined
                ? target
                : { ...target, kind: shown.kind, scope: shown.scope, scopeId: shown.scopeId },
            ];
          }),
          status: row.status,
          createdAt: row.createdAt,
          decidedAt: row.decidedAt ?? null,
        })),
      });
    }).pipe(storageFailure("cards"));

  /** One change by id, with what an answer or an Undo needs. */
  const readChange = (changeId: number) =>
    sql<ChangeRow>`
      SELECT change_id AS "changeId", run_id AS "runId", status, action, scope,
        scope_id AS "scopeId", memory_ids_json AS "memoryIdsJson",
        result_memory_id AS "resultMemoryId", content, reason,
        to_kind AS "toKind", to_scope AS "toScope", to_scope_id AS "toScopeId",
        versions_json AS "versionsJson", proposed_by AS "proposedBy",
        thread_id AS "threadId", entry_snapshots_json AS "entrySnapshotsJson",
        to_apps_json AS "toAppsJson", undo_json AS "undoJson", decided_at AS "decidedAt"
      FROM personal_memory_tidy_changes WHERE change_id = ${changeId}
    `.pipe(Effect.map((rows) => rows[0]));

  /** The changes waiting for an answer, oldest first: one run's, or all of them. */
  const readPending = (runId?: string) =>
    sql<ChangeRow>`
      SELECT change_id AS "changeId", run_id AS "runId", status, action, scope,
        scope_id AS "scopeId", memory_ids_json AS "memoryIdsJson",
        result_memory_id AS "resultMemoryId", content, reason,
        to_kind AS "toKind", to_scope AS "toScope", to_scope_id AS "toScopeId",
        versions_json AS "versionsJson", proposed_by AS "proposedBy",
        thread_id AS "threadId", entry_snapshots_json AS "entrySnapshotsJson",
        to_apps_json AS "toAppsJson"
      FROM personal_memory_tidy_changes
      WHERE status = 'pending' AND ${runId === undefined ? sql`1 = 1` : sql`run_id = ${runId}`}
      ORDER BY change_id
    `;

  /** The kind, reach and apps of entries as they are now, kept for an Undo. */
  const readBefore = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed([])
      : sql<{
          readonly memoryId: string;
          readonly kind: string;
          readonly scope: string;
          readonly scopeId: string | null;
          readonly appsJson: string | null;
        }>`
          SELECT memory_id AS "memoryId", kind, scope, scope_id AS "scopeId", apps_json AS "appsJson"
          FROM personal_memory WHERE ${sql.in("memory_id", ids)}
        `;

  /**
   * Makes one pending change and records it. `status` is "approved" when the
   * owner said yes and "applied" when the automatic mode made it. Fails (and
   * rolls back) when an entry it names changed since it was proposed. What an
   * Undo needs is kept with the change.
   */
  const applyChange = (change: ChangeRow, status: "approved" | "applied", nowIso: string) =>
    Effect.gen(function* () {
      const stale = fail(
        "One of these entries changed, was archived or was deleted since this was proposed; nothing was changed.",
      );
      // The versions the owner saw when it was proposed: any later edit wins.
      const recorded = Option.getOrUndefined(decodeVersionMap(change.versionsJson ?? ""));
      if (recorded === undefined) return yield* stale;
      const versions = new Map(Object.entries(recorded));
      const snapshots = readEntrySnapshots(change.entrySnapshotsJson);
      const memoryIds = decodeIds(change.memoryIdsJson);
      let resultId: string | null = change.resultMemoryId;
      let undoJson: string | null = null;
      const touchesInPlace =
        change.action === "rescope" || change.action === "reclassify" || change.action === "split";
      const before = touchesInPlace ? yield* readBefore(memoryIds) : [];
      switch (change.action) {
        case "reclassify": {
          if (!(yield* applyReclassify(memoryIds[0] ?? "", change, versions, nowIso))) {
            return yield* stale;
          }
          undoJson = encodeUndo({ before });
          break;
        }
        case "rescope": {
          if (!(yield* applyRescope(memoryIds, change, versions, nowIso, snapshots))) {
            return yield* stale;
          }
          undoJson = encodeUndo({ before });
          break;
        }
        case "save": {
          const saved = yield* applyBotSave(change, memoryIds, versions, nowIso, snapshots);
          if (saved === null) return yield* stale;
          resultId = saved;
          break;
        }
        case "forget": {
          if (!(yield* applyBotForget(memoryIds, versions, nowIso, snapshots))) {
            return yield* stale;
          }
          break;
        }
        case "split": {
          const split = yield* applySplit(change, memoryIds, nowIso, snapshots);
          if (split === null) return yield* stale;
          resultId = split.first;
          undoJson = encodeUndo({ before, created: split.created });
          break;
        }
        case "merge":
        case "supersede": {
          const decision: TidyDecision =
            change.action === "merge"
              ? {
                  action: "merge",
                  memoryIds,
                  content: change.content ?? "",
                  reason: change.reason,
                }
              : {
                  action: "supersede",
                  memoryIds,
                  by: change.resultMemoryId,
                  reason: change.reason,
                };
          if (decision.action === "merge" && looksLikeSecret(decision.content)) {
            return yield* fail("The merged text looks like it carries a secret; not applied.");
          }
          const applied = yield* applyDecision(
            decision,
            versions,
            `tidy-approved:${change.runId}`,
            nowIso,
            change.action === "supersede" ? change.content : null,
            snapshots,
          );
          if (applied === null) return yield* stale;
          resultId = applied.resultId;
          break;
        }
        default:
          return yield* fail("That tidy-up change cannot be approved.");
      }
      yield* sql`
        UPDATE personal_memory_tidy_changes
        SET status = ${status}, decided_at = ${nowIso}, result_memory_id = ${resultId},
            undo_json = ${undoJson}
        WHERE change_id = ${change.changeId} AND status = 'pending'
      `;
    }).pipe(sql.withTransaction);

  const decide: PersonalMemoryTidy["Service"]["decide"] = (input) =>
    Effect.gen(function* () {
      const change = yield* readChange(input.changeId);
      if (change === undefined) return yield* fail("That tidy-up change was not found.");
      // Every answer, Save or Don't save, is bound to the change the owner was shown.
      if (input.changeHash !== changeHashOf(change)) {
        return yield* fail(
          "That card is out of date; reload it before answering. Nothing was changed.",
        );
      }
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
      // Applying and marking approved happen together, or not at all.
      yield* applyChange(change, "approved", nowIso);
      return yield* log({});
    }).pipe(lock.withPermits(1), storageFailure("decide"));

  /**
   * Makes the changes the automatic mode owns: each is applied and marked
   * "applied". A change whose entries moved since it was proposed is left as it
   * is (with the reason); a bot's change with no chat of the owner's behind it
   * has no proof its wording is the owner's, so it is taken off the list.
   */
  const settlePending = (rows: ReadonlyArray<ChangeRow>) =>
    Effect.gen(function* () {
      let applied = 0;
      let left = 0;
      let withdrawn = 0;
      for (const change of rows) {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        if ((change.proposedBy ?? "").startsWith("bot:") && (change.threadId ?? null) === null) {
          yield* sql`
            UPDATE personal_memory_tidy_changes SET status = 'withdrawn', decided_at = ${nowIso}
            WHERE change_id = ${change.changeId} AND status = 'pending'
          `;
          withdrawn += 1;
          continue;
        }
        const result = yield* applyChange(change, "applied", nowIso).pipe(Effect.result);
        if (result._tag === "Success") {
          applied += 1;
          continue;
        }
        // Only "an entry changed" leaves a change; a storage failure stays one.
        if (!isMemoryError(result.failure)) return yield* Effect.fail(result.failure);
        yield* sql`
          UPDATE personal_memory_tidy_changes
          SET status = 'left', decided_at = ${nowIso},
              reason = ${safeText(`${change.reason} (changed since it was proposed; left as it is)`).slice(0, 700)}
          WHERE change_id = ${change.changeId} AND status = 'pending'
        `;
        left += 1;
      }
      if (rows.length > 0) {
        yield* sql`
          UPDATE personal_memory_tidy_runs SET pending = (
            SELECT COUNT(*) FROM personal_memory_tidy_changes c
            WHERE c.run_id = personal_memory_tidy_runs.run_id AND c.status = 'pending'
          )
          WHERE ${sql.in("run_id", [...new Set(rows.map((change) => change.runId))])}
        `;
      }
      return { applied, left, withdrawn };
    });

  const applyWaiting: PersonalMemoryTidy["Service"]["applyWaiting"] = Effect.gen(function* () {
    if (!memoryAutoApplyEnabled()) return { applied: 0, left: 0, withdrawn: 0 };
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    // The seeded default (a mode nobody chose) moves to "on"; a mode the owner set stays.
    yield* sql`
      UPDATE personal_memory_tidy_settings SET mode = 'on', updated_at = ${nowIso}
      WHERE settings_id = 1 AND mode = 'preview' AND updated_at IS NULL
    `;
    const result = yield* settlePending(yield* readPending());
    if (result.applied + result.left + result.withdrawn > 0) {
      yield* Effect.logInfo("personal memory changes that were waiting were settled", result);
    }
    return result;
  }).pipe(lock.withPermits(1), storageFailure("applyWaiting"));

  /** Entries an Undo brings back: archived by this change and not since by anything else. */
  const restoreArchived = (
    ids: ReadonlyArray<string>,
    archivedBy: { readonly supersededBy: string | null; readonly reasonLike: string },
    nowIso: string,
  ) =>
    Effect.forEach(
      ids,
      (id) => sql`
        UPDATE personal_memory
        SET superseded_at = NULL, superseded_by = NULL, superseded_reason = NULL,
            updated_at = ${nowIso}, version = version + 1
        WHERE memory_id = ${id} AND deleted_at IS NULL AND superseded_at IS NOT NULL
          AND superseded_by IS ${archivedBy.supersededBy}
          AND superseded_reason LIKE ${archivedBy.reasonLike}
      `,
    );

  /** Archives what a change made (a merge, a save, a split's parts), restorable like any entry. */
  const archiveMade = (ids: ReadonlyArray<string>, nowIso: string) =>
    Effect.forEach(
      ids,
      (id) => sql`
        UPDATE personal_memory
        SET superseded_at = ${nowIso}, superseded_by = NULL, superseded_reason = ${UNDONE_FROM_LOG},
            version = version + 1
        WHERE memory_id = ${id} AND deleted_at IS NULL AND superseded_at IS NULL
      `,
    );

  const undo: PersonalMemoryTidy["Service"]["undo"] = (input) =>
    Effect.gen(function* () {
      const change = yield* readChange(input.changeId);
      if (change === undefined) return yield* fail("That tidy-up change was not found.");
      if (input.changeHash !== changeHashOf(change)) {
        return yield* fail("That change is out of date; reload it before undoing it.");
      }
      if (change.status !== "applied" && change.status !== "approved") {
        return yield* fail("That change was not made, or is already undone.");
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const ids = decodeIds(change.memoryIdsJson);
      const stored = Option.getOrUndefined(decodeUndo(change.undoJson ?? ""));
      yield* Effect.gen(function* () {
        switch (change.action) {
          case "supersede":
            // Archived for a newer entry (which stays), or retired with none.
            yield* restoreArchived(
              ids,
              change.resultMemoryId === null
                ? { supersededBy: null, reasonLike: `${RETIRED_PREFIX}%` }
                : { supersededBy: change.resultMemoryId, reasonLike: "%" },
              nowIso,
            );
            break;
          case "merge":
            yield* restoreArchived(
              ids,
              { supersededBy: change.resultMemoryId, reasonLike: "%" },
              nowIso,
            );
            if (change.resultMemoryId !== null) yield* archiveMade([change.resultMemoryId], nowIso);
            break;
          case "forget":
            yield* restoreArchived(
              ids,
              { supersededBy: null, reasonLike: BOT_FORGET_REASON },
              nowIso,
            );
            break;
          case "save":
            // The entry the save made goes, and what it replaced comes back.
            if (change.resultMemoryId !== null) {
              yield* restoreArchived(
                ids,
                { supersededBy: change.resultMemoryId, reasonLike: "%" },
                nowIso,
              );
              yield* archiveMade([change.resultMemoryId], nowIso);
            }
            break;
          case "split":
            if (stored === undefined) return yield* fail("This split cannot be undone.");
            yield* restoreArchived(
              ids,
              { supersededBy: change.resultMemoryId, reasonLike: "Split into%" },
              nowIso,
            );
            yield* archiveMade(stored.created ?? [], nowIso);
            break;
          case "rescope": {
            if (stored === undefined) return yield* fail("This change cannot be undone.");
            // Only while the rule still has the scope this change gave it.
            const appliedApps = appsToJson(parseAppsJson(change.toAppsJson));
            for (const entry of stored.before) {
              yield* sql`
                UPDATE personal_memory
                SET apps_json = ${entry.appsJson}, updated_at = ${nowIso}, version = version + 1
                WHERE memory_id = ${entry.memoryId} AND deleted_at IS NULL
                  AND superseded_at IS NULL AND apps_json IS ${appliedApps}
              `;
            }
            break;
          }
          case "reclassify": {
            if (stored === undefined) return yield* fail("This change cannot be undone.");
            for (const entry of stored.before) {
              // Only while the entry still has the kind and reach this change gave it.
              const kind = change.toKind ?? entry.kind;
              const scope = change.toScope ?? "shared";
              const scopeId = scope === "team" ? (change.toScopeId ?? null) : null;
              yield* sql`
                UPDATE personal_memory
                SET kind = ${entry.kind}, scope = ${entry.scope}, scope_id = ${entry.scopeId},
                    updated_at = ${nowIso}, version = version + 1
                WHERE memory_id = ${entry.memoryId} AND deleted_at IS NULL
                  AND superseded_at IS NULL AND kind = ${kind} AND scope = ${scope}
                  AND scope_id IS ${scopeId}
              `;
            }
            break;
          }
          default:
            return yield* fail("That tidy-up change cannot be undone.");
        }
        yield* sql`
          UPDATE personal_memory_tidy_changes SET status = 'undone', decided_at = ${nowIso}
          WHERE change_id = ${change.changeId} AND status IN ('applied', 'approved')
        `;
      }).pipe(sql.withTransaction);
      return yield* log({});
    }).pipe(lock.withPermits(1), storageFailure("undo"));

  /**
   * Every named entry still current and as shown: held to its snapshot (text,
   * kind and reach) when the change recorded one, else to the recorded version.
   */
  const unchanged = (
    ids: ReadonlyArray<string>,
    versions: ReadonlyMap<string, number>,
    snapshots: ReadonlyMap<string, EntrySnapshot> = new Map(),
  ) =>
    ids.length === 0
      ? Effect.succeed(true)
      : sql<{
          readonly memoryId: string;
          readonly version: number;
          readonly content: string;
          readonly kind: string;
          readonly scope: string;
          readonly scopeId: string | null;
        }>`
          SELECT memory_id AS "memoryId", version, content, kind, scope, scope_id AS "scopeId"
          FROM personal_memory
          WHERE deleted_at IS NULL AND superseded_at IS NULL AND ${sql.in("memory_id", ids)}
        `.pipe(
          Effect.map(
            (rows) =>
              rows.length === ids.length &&
              rows.every((row) => {
                const snapshot = snapshots.get(row.memoryId);
                return snapshot === undefined
                  ? versions.get(row.memoryId) === row.version
                  : matchesSnapshot(row, snapshot);
              }),
          ),
        );

  /**
   * A rescope the owner approved: one current rule's app scope changes, never
   * its text, kind or reach. It must still read, and reach, exactly as shown.
   */
  const applyRescope = (
    ids: ReadonlyArray<string>,
    change: Pick<ChangeRow, "toAppsJson">,
    versions: ReadonlyMap<string, number>,
    nowIso: string,
    snapshots: ReadonlyMap<string, EntrySnapshot>,
  ) =>
    Effect.gen(function* () {
      if (ids.length !== 1 || !(yield* unchanged(ids, versions, snapshots))) return false;
      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM personal_memory
        WHERE memory_id = ${ids[0]!} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      if (rows[0]?.kind !== "preference") return false;
      yield* sql`
        UPDATE personal_memory
        SET apps_json = ${appsToJson(parseAppsJson(change.toAppsJson))},
            updated_at = ${nowIso}, version = version + 1
        WHERE memory_id = ${ids[0]!} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      return true;
    });

  /** A bot's save the owner approved: the new entry, and its replaced ones archived. */
  const applyBotSave = (
    change: ChangeRow,
    replaces: ReadonlyArray<string>,
    versions: ReadonlyMap<string, number>,
    nowIso: string,
    snapshots: ReadonlyMap<string, EntrySnapshot>,
  ) =>
    Effect.gen(function* () {
      const content = (change.content ?? "").trim();
      const kind = change.toKind === "preference" ? "preference" : "note";
      const scope =
        change.toScope === "team" ? "team" : change.toScope === "bot" ? "bot" : "shared";
      if (content.length === 0 || looksLikeSecret(content)) return null;
      if (scope === "team" && (change.toScopeId ?? "").trim().length === 0) return null;
      // A bot-only entry is only ever the proposing bot's own.
      if (
        scope === "bot" &&
        (change.toScopeId == null || change.proposedBy !== `bot:${change.toScopeId}`)
      ) {
        return null;
      }
      if (!(yield* unchanged(replaces, versions, snapshots))) return null;
      const memoryId = NodeCrypto.randomUUID();
      yield* sql`
        INSERT INTO personal_memory (
          memory_id, scope, scope_id, kind, content, source, sensitivity,
          created_at, updated_at, deleted_at, version, apps_json
        )
        VALUES (
          ${memoryId}, ${scope}, ${scope === "shared" ? null : change.toScopeId}, ${kind},
          ${content}, ${change.proposedBy ?? "approved"}, 'normal', ${nowIso}, ${nowIso}, NULL, 1,
          ${kind === "preference" ? appsToJson(parseAppsJson(change.toAppsJson)) : null}
        )
      `;
      for (const id of replaces) {
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = ${nowIso}, superseded_by = ${memoryId},
              superseded_reason = 'Replaced by a newer save you approved.', version = version + 1
          WHERE memory_id = ${id} AND deleted_at IS NULL AND superseded_at IS NULL
        `;
      }
      return memoryId;
    });

  /** A bot's forget the owner approved: archived, still restorable. */
  const applyBotForget = (
    ids: ReadonlyArray<string>,
    versions: ReadonlyMap<string, number>,
    nowIso: string,
    snapshots: ReadonlyMap<string, EntrySnapshot>,
  ) =>
    Effect.gen(function* () {
      if (ids.length === 0 || !(yield* unchanged(ids, versions, snapshots))) return false;
      for (const id of ids) {
        yield* sql`
          UPDATE personal_memory
          SET superseded_at = ${nowIso}, superseded_by = NULL,
              superseded_reason = 'Forgotten with your approval.', version = version + 1
          WHERE memory_id = ${id} AND deleted_at IS NULL AND superseded_at IS NULL
        `;
      }
      return true;
    });

  /**
   * A split the owner approved: each part becomes its own entry with its own
   * kind and reach, dated like the long entry it came from (so it keeps its
   * place among newer rules), and the long entry is archived. A part whose
   * exact text is already current in its reach, as the same kind, is not
   * added twice; a note never stands in for a rule, or a rule for a note.
   */
  const applySplit = (
    change: ChangeRow,
    ids: ReadonlyArray<string>,
    nowIso: string,
    snapshots: ReadonlyMap<string, EntrySnapshot>,
  ) =>
    Effect.gen(function* () {
      const split = Option.getOrUndefined(decodeSplit(change.content ?? ""));
      const parts = split?.parts ?? [];
      if (split === undefined || parts.length === 0 || ids.length !== 1) return null;
      const invalid = parts.some(
        (part) =>
          part.content.trim().length === 0 ||
          looksLikeSecret(part.content) ||
          (part.scope === "team" && (part.scopeId ?? "").trim().length === 0),
      );
      if (invalid) return null;
      // Still current, reading exactly as shown, and of the kind and reach
      // shown: the entry it archives is bound like any other.
      const original = yield* sql<{
        readonly createdAt: string;
        readonly content: string;
        readonly kind: string;
        readonly scope: string;
        readonly scopeId: string | null;
        readonly appsJson: string | null;
      }>`
        SELECT created_at AS "createdAt", content, kind, scope, scope_id AS "scopeId",
          apps_json AS "appsJson"
        FROM personal_memory
        WHERE memory_id = ${ids[0]!} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      if (original[0] === undefined || original[0].content !== split.from) return null;
      const shown = snapshots.get(ids[0]!);
      if (shown === undefined || !matchesSnapshot(original[0], shown)) return null;
      const createdAt = original[0].createdAt;
      const made: Array<string> = [];
      const created: Array<string> = [];
      for (const part of parts) {
        const content = part.content.trim();
        const scopeId = part.scope === "team" ? part.scopeId!.trim() : null;
        const existing = yield* sql<{ readonly memoryId: string }>`
          SELECT memory_id AS "memoryId" FROM personal_memory
          WHERE deleted_at IS NULL AND superseded_at IS NULL AND scope = ${part.scope}
            AND scope_id IS ${scopeId} AND kind = ${part.kind} AND content = ${content}
            AND memory_id <> ${ids[0]!}
          LIMIT 1
        `;
        if (existing[0] !== undefined) {
          made.push(existing[0].memoryId);
          continue;
        }
        const memoryId = NodeCrypto.randomUUID();
        yield* sql`
          INSERT INTO personal_memory (
            memory_id, scope, scope_id, kind, content, source, sensitivity,
            created_at, updated_at, deleted_at, version, apps_json
          )
          VALUES (
            ${memoryId}, ${part.scope}, ${scopeId}, ${part.kind}, ${content},
            ${`tidy-approved:${change.runId}`}, 'normal', ${createdAt}, ${nowIso}, NULL, 1,
            ${part.kind === "preference" ? original[0].appsJson : null}
          )
        `;
        made.push(memoryId);
        created.push(memoryId);
      }
      yield* sql`
        UPDATE personal_memory
        SET superseded_at = ${nowIso}, superseded_by = ${made[0]!},
            superseded_reason = ${`Split into ${parts.length} single facts you approved.`},
            version = version + 1
        WHERE memory_id = ${ids[0]!} AND deleted_at IS NULL AND superseded_at IS NULL
      `;
      return { first: made[0]!, created };
    });

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
        : Effect.logWarning("personal memory tidy-up check failed", {
            cause: safeText(Cause.pretty(cause)).slice(0, 2_000),
          }),
    ),
  );

  // A run cut short by a restart would otherwise say "running" for ever.
  const closeInterrupted = sql`
    UPDATE personal_memory_tidy_runs
    SET status = 'failed', error = 'Interrupted by a server restart.'
    WHERE status = 'running'
  `.pipe(Effect.ignore);

  /**
   * Pending changes from before 1.60.21 hold every entry to its exact
   * version, so approving a reach change first made them stale. Where every
   * entry a change names is still at the version it was proposed against, its
   * current text is the text the owner is shown: record it, and approval then
   * checks text. Changes whose entries already moved keep the strict check.
   */
  const snapshotPendingTexts: PersonalMemoryTidy["Service"]["snapshotPendingTexts"] = Effect.gen(
    function* () {
      const rows = yield* sql<{
        readonly changeId: number;
        readonly memoryIdsJson: string;
        readonly resultMemoryId: string | null;
        readonly action: string;
        readonly versionsJson: string | null;
      }>`
        SELECT change_id AS "changeId", memory_ids_json AS "memoryIdsJson",
          result_memory_id AS "resultMemoryId", action, versions_json AS "versionsJson"
        FROM personal_memory_tidy_changes
        WHERE status = 'pending' AND entry_snapshots_json IS NULL
      `;
      let upgraded = 0;
      for (const row of rows) {
        const recorded = Option.getOrUndefined(decodeVersionMap(row.versionsJson ?? ""));
        if (recorded === undefined) continue;
        const ids = [
          ...decodeIds(row.memoryIdsJson),
          ...(row.action === "supersede" && row.resultMemoryId !== null
            ? [row.resultMemoryId]
            : []),
        ];
        if (ids.length === 0) continue;
        const current = yield* sql<{
          readonly memoryId: string;
          readonly version: number;
          readonly content: string;
          readonly kind: string;
          readonly scope: string;
          readonly scopeId: string | null;
        }>`
          SELECT memory_id AS "memoryId", version, content, kind, scope, scope_id AS "scopeId"
          FROM personal_memory
          WHERE deleted_at IS NULL AND superseded_at IS NULL AND ${sql.in("memory_id", ids)}
        `;
        const asProposed =
          current.length === new Set(ids).size &&
          current.every((entry) => recorded[entry.memoryId] === entry.version);
        if (!asProposed) continue;
        yield* sql`
          UPDATE personal_memory_tidy_changes
          SET entry_snapshots_json = ${entrySnapshotsJson(
            ids.flatMap((id) => current.filter((entry) => entry.memoryId === id)),
            new Set(
              row.action === "supersede" && row.resultMemoryId !== null ? [row.resultMemoryId] : [],
            ),
          )}
          WHERE change_id = ${row.changeId} AND status = 'pending' AND entry_snapshots_json IS NULL
        `;
        upgraded += 1;
      }
      if (rows.length > 0) {
        yield* Effect.logInfo("personal memory pending changes now bound to what was shown", {
          upgraded,
          keptStrict: rows.length - upgraded,
        });
      }
      return upgraded;
    },
  ).pipe(lock.withPermits(1), storageFailure("snapshot"));

  const start: PersonalMemoryTidy["Service"]["start"] = () =>
    process.env.PERSONAL_MEMORY_TIDY === "off"
      ? forkParked(snapshotPendingTexts.pipe(Effect.ignore)).pipe(Effect.asVoid)
      : forkParked(
          closeInterrupted.pipe(
            Effect.andThen(snapshotPendingTexts.pipe(Effect.ignore)),
            Effect.andThen(applyWaiting.pipe(Effect.ignore)),
            Effect.andThen(
              readAppVersion.pipe(
                Effect.flatMap((appVersion) =>
                  importInbox({ appVersion, shipped: SHIPPED_MEMORY_PROPOSALS }),
                ),
              ),
            ),
            Effect.andThen(
              nightly.pipe(
                withStallJob("job:memory-tidy-check"),
                Effect.repeat(Schedule.spaced(TIDY_CHECK_MS)),
              ),
            ),
          ),
        ).pipe(Effect.asVoid);

  return {
    run,
    decide,
    undo,
    applyWaiting,
    cardsForThread,
    importProposals,
    importInbox,
    snapshotPendingTexts,
    log,
    setMode,
    start,
  } satisfies PersonalMemoryTidy["Service"];
});

export const layer = Layer.effect(PersonalMemoryTidy, make);
