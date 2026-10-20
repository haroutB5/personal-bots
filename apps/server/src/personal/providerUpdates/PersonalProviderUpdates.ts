/**
 * PersonalProviderUpdates - keeps personal bots on a working provider version.
 *
 * - Records the provider version each personal-bot session started on. When
 *   the installed version changes (a one-click update, or a self-update the
 *   next provider refresh notices), sessions still on the old binary are
 *   stopped once they are idle: never during a turn, an approval or a pending
 *   question. The binding keeps its resume cursor, so the next turn resumes
 *   the same conversation on the new binary through the reactor's normal
 *   start, with the bot's instructions and isolation.
 * - Runs one isolated test message per new installed version per provider
 *   (`ProviderInstance.smokeTest`), persists the verdict, projects it onto the
 *   provider snapshot (`ServerProvider.smokeCheck`) and sends one push when it
 *   fails. A later pass clears it. A failure is not retried automatically;
 *   "Check again" (`recheck`) re-runs it on request.
 * - Except a usage limit: when no model passed and every failure was a usage
 *   limit or an empty balance (`smokeLimit.ts`), the update is not blamed. The
 *   verdict is `waiting_for_limit` with a `retryAt` (the error's "try again at"
 *   time, else the provider's usage reset, else 30 minutes out), no push, and
 *   the same single worker runs the test again a minute after it. `retryAt` is
 *   persisted, so a restart re-arms the timer (or runs the test at once when the
 *   time has passed); a retry that meets the limit again waits again with the
 *   new time. A stored "failed" verdict whose message is a usage limit (written
 *   before this existed) reads back as waiting.
 *
 * @module personal/providerUpdates/PersonalProviderUpdates
 */
import {
  PersonalBotsError,
  type OrchestrationThreadShell,
  type PersonalBot,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
  type ServerProviderSmokeCheck,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalPushService from "../push/PersonalPushService.ts";
import { withStallJob } from "../../observability/stallJobs.ts";
import {
  isUsageLimitFailure,
  smokeLimitDueAtMs,
  smokeLimitResetMs,
  smokeLimitRetryAtMs,
  type SmokeLimitFailure,
} from "./smokeLimit.ts";

/** Catches restarts the turn-end event raced (the projection lags the provider). */
const RESTART_SWEEP_INTERVAL = Duration.seconds(30);
const MESSAGE_MAX_LENGTH = 500;

const PersistedSmokeCheck = Schema.Struct({
  version: Schema.String,
  // "baseline": the version seen the first time; nobody updated to it, so it is not tested.
  status: Schema.Literals(["baseline", "passed", "failed", "waiting_for_limit"]),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  // Only on waiting_for_limit: when the limit is expected to be over.
  retryAt: Schema.optional(Schema.String),
  // The model that answered (passed) or that the last attempt used (failed).
  model: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Int),
  // The version that worked before this one ("Go back"); set on a failure after an update.
  previousVersion: Schema.optional(Schema.String),
  // Bot models the provider no longer lists; the default model answered instead.
  missingModels: Schema.optional(Schema.Array(Schema.String)),
  // The owner pressed Test: not about an update, so no alert and no "Update broke".
  manual: Schema.optional(Schema.Boolean),
});
export type PersistedSmokeCheck = typeof PersistedSmokeCheck.Type;
const decodePersisted = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedSmokeCheck));
const encodePersisted = Schema.encodeSync(Schema.fromJsonString(PersistedSmokeCheck));

export const smokeCheckMetaKey = (instanceId: ProviderInstanceId) =>
  `provider-smoke-check:${instanceId}`;

/** The name bots use for a provider: Anthropic's runtime is "Claude Code". */
export function providerProductName(
  provider: Pick<ServerProvider, "driver" | "displayName" | "instanceId">,
): string {
  if (provider.driver === "claudeAgent") return "Claude Code";
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "opencode") return "OpenCode";
  return provider.displayName ?? provider.instanceId;
}

/**
 * A session may be restarted only between turns: the provider reports no
 * active turn, and the thread has no running turn, approval or pending input.
 */
export function isIdleForRestart(
  session: ProviderSession,
  shell: OrchestrationThreadShell | undefined,
): boolean {
  if (session.status !== "ready" || session.activeTurnId !== undefined) return false;
  if (shell === undefined) return true;
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.latestTurn?.state === "running") return false;
  return shell.session?.status !== "running" && shell.session?.status !== "starting";
}

export type SmokeTest = (model: string) => Effect.Effect<void, { readonly detail: string }>;

/** Any tagged service error; the service logs and moves on rather than branching on them. */
interface DepFailure {
  readonly _tag: string;
}

/** What the service reads and drives; `layer` wires the real services. */
export interface PersonalProviderUpdatesDeps {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly providerChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly setSmokeCheck: (
    instanceId: ProviderInstanceId,
    state: ServerProviderSmokeCheck | null,
  ) => Effect.Effect<void>;
  readonly runtimeEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly listSessions: Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, DepFailure>;
  readonly threadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, DepFailure>;
  readonly isPersonalThread: (threadId: ThreadId) => Effect.Effect<boolean, DepFailure>;
  readonly listBots: Effect.Effect<ReadonlyArray<PersonalBot>, DepFailure>;
  readonly getMeta: (key: string) => Effect.Effect<Option.Option<string>, DepFailure>;
  readonly setMeta: (key: string, value: string) => Effect.Effect<void, DepFailure>;
  readonly smokeTestFor: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<Option.Option<SmokeTest>>;
  readonly notifyBroken: (input: {
    readonly instanceId: string;
    readonly label: string;
    readonly version: string;
  }) => Effect.Effect<void>;
}

export interface PersonalProviderUpdatesShape {
  /** Subscribes to provider snapshots and runtime events; parks until server activation. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * "Test" on the provider page: one message on the given (else the default)
   * model, with or without bots on it. The verdict arrives on `smokeCheck`.
   */
  readonly testRun: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly model?: string;
  }) => Effect.Effect<void, PersonalBotsError>;
  /** "Check again": refreshes the instance, then re-runs the test message for its version. */
  readonly recheck: (input: {
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, PersonalBotsError>;
  readonly handleProviders: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  readonly handleRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly restartStaleSessions: Effect.Effect<void>;
  /** Resolves when every queued test message has finished. */
  readonly drainChecks: Effect.Effect<void>;
}

export class PersonalProviderUpdates extends Context.Service<
  PersonalProviderUpdates,
  PersonalProviderUpdatesShape
>()("t3/personal/providerUpdates/PersonalProviderUpdates") {}

interface SessionVersion {
  readonly instanceId: ProviderInstanceId;
  /** Null when the provider did not report a version when the session started. */
  readonly version: string | null;
}

interface CheckRequest {
  readonly provider: ServerProvider;
  readonly version: string;
  readonly models: ReadonlyArray<string>;
  readonly test: SmokeTest;
  readonly previous: PersistedSmokeCheck | null;
  /** The owner asked for this test: no alert, and it is not blamed on an update. */
  readonly manual?: boolean;
}

const versionOf = (providers: ReadonlyArray<ServerProvider>, instanceId: ProviderInstanceId) =>
  providers.find((provider) => provider.instanceId === instanceId)?.version ?? null;

/**
 * Every distinct model the instance's bots use, in sort order.
 *
 * The check used to try only the first bot's model, so a single bot pinned to
 * a withdrawn model reported the whole provider as broken while every other
 * bot on it worked. The question this check answers is "did the update break
 * this provider", and one model cannot answer it alone.
 */
const botModelsFor = (
  bots: ReadonlyArray<PersonalBot>,
  instanceId: ProviderInstanceId,
): ReadonlyArray<string> => [
  ...new Set(
    bots
      .filter((bot) => bot.modelSelection.instanceId === instanceId)
      .toSorted((left, right) => left.sortOrder - right.sortOrder)
      .map((bot) => bot.modelSelection.model),
  ),
];

const projectionOf = (persisted: PersistedSmokeCheck): ServerProviderSmokeCheck | null =>
  persisted.status === "baseline"
    ? null
    : {
        status: persisted.status,
        version: persisted.version,
        checkedAt: persisted.checkedAt,
        message: persisted.message,
        ...(persisted.status === "waiting_for_limit" && persisted.retryAt !== undefined
          ? { retryAt: persisted.retryAt }
          : {}),
        ...(persisted.model !== undefined ? { model: persisted.model } : {}),
        ...(persisted.durationMs !== undefined ? { durationMs: persisted.durationMs } : {}),
        ...(persisted.previousVersion !== undefined
          ? { previousVersion: persisted.previousVersion }
          : {}),
        ...(persisted.missingModels !== undefined && persisted.missingModels.length > 0
          ? { missingModels: persisted.missingModels }
          : {}),
        ...(persisted.manual === true ? { manual: true } : {}),
      };

const sameProjection = (
  current: ServerProviderSmokeCheck | undefined,
  wanted: ServerProviderSmokeCheck | null,
) =>
  current === undefined
    ? wanted === null
    : wanted !== null &&
      current.status === wanted.status &&
      current.version === wanted.version &&
      current.checkedAt === wanted.checkedAt &&
      current.message === wanted.message &&
      current.retryAt === wanted.retryAt &&
      current.model === wanted.model &&
      current.durationMs === wanted.durationMs &&
      current.previousVersion === wanted.previousVersion &&
      current.manual === wanted.manual &&
      (current.missingModels ?? []).join("|") === (wanted.missingModels ?? []).join("|");

const failureDetail = (cause: Cause.Cause<{ readonly detail: string }>): string => {
  const failure = Cause.squash(cause);
  const raw =
    typeof failure === "object" &&
    failure !== null &&
    "detail" in failure &&
    typeof failure.detail === "string"
      ? failure.detail
      : failure instanceof Error
        ? failure.message
        : "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "The test message failed.";
  return trimmed.length <= MESSAGE_MAX_LENGTH ? trimmed : trimmed.slice(0, MESSAGE_MAX_LENGTH);
};

/**
 * The version that last worked before `version`: the previous record's version
 * when that one passed (or was the first sight of it), else what that record
 * already knew. Null when nobody knows.
 */
const previousWorkingVersion = (
  previous: PersistedSmokeCheck | null,
  version: string,
): string | undefined => {
  if (previous === null) return undefined;
  if (previous.version === version) return previous.previousVersion;
  return previous.status === "passed" || previous.status === "baseline"
    ? previous.version
    : previous.previousVersion;
};

export const makeWith = (
  deps: PersonalProviderUpdatesDeps,
): Effect.Effect<PersonalProviderUpdatesShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    // In memory on purpose: provider sessions do not survive a server restart.
    const sessionVersions = new Map<ThreadId, SessionVersion>();
    const checking = new Set<ProviderInstanceId>();
    // One retry timer per provider waiting on a usage limit. In memory on
    // purpose: the persisted `retryAt` re-arms it after a server restart.
    const retryTimers = new Map<
      ProviderInstanceId,
      { readonly dueAtMs: number; readonly fiber: Fiber.Fiber<void> }
    >();
    const scope = yield* Effect.scope;
    const restartLock = yield* Semaphore.make(1);

    const logFailure =
      (message: string, fields: Record<string, unknown> = {}) =>
      (cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

    const restartPass = Effect.gen(function* () {
      if (sessionVersions.size === 0) return;
      const providers = yield* deps.getProviders;
      const stale = Array.from(sessionVersions).filter(([, record]) => {
        const current = versionOf(providers, record.instanceId);
        return current !== null && current !== record.version;
      });
      if (stale.length === 0) return;
      const sessions = yield* deps.listSessions;
      for (const [threadId, record] of stale) {
        const live = sessions.find((session) => session.threadId === threadId);
        if (live === undefined) {
          // Already gone: its next start picks up the new binary.
          sessionVersions.delete(threadId);
          continue;
        }
        const shell = yield* Effect.exit(deps.threadShell(threadId));
        if (Exit.isFailure(shell)) continue;
        if (!isIdleForRestart(live, Option.getOrUndefined(shell.value))) continue;
        const stopped = yield* Effect.exit(deps.stopSession(threadId));
        if (Exit.isFailure(stopped)) {
          yield* Effect.logWarning("personal bot session restart failed", {
            threadId,
            cause: Cause.pretty(stopped.cause),
          });
          continue;
        }
        sessionVersions.delete(threadId);
        yield* Effect.logInfo(
          "personal bot session stopped at idle for a new provider version; its next turn resumes on it",
          {
            threadId,
            instanceId: record.instanceId,
            from: record.version ?? "not reported",
            to: versionOf(providers, record.instanceId),
          },
        );
      }
    });
    const restartStaleSessions = restartLock
      .withPermits(1)(restartPass)
      .pipe(Effect.catchCause(logFailure("personal provider restart pass failed")));

    const handleRuntimeEvent = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "session.exited":
            sessionVersions.delete(event.threadId);
            return;
          case "turn.completed":
          case "turn.aborted":
            yield* restartStaleSessions;
            return;
          case "session.started":
            break;
          default:
            return;
        }
        if (!(yield* deps.isPersonalThread(event.threadId))) return;
        const instanceId =
          event.providerInstanceId ??
          (yield* deps.listSessions).find((session) => session.threadId === event.threadId)
            ?.providerInstanceId;
        if (instanceId === undefined) return;
        const version = versionOf(yield* deps.getProviders, instanceId);
        sessionVersions.set(event.threadId, { instanceId, version });
      }).pipe(
        Effect.catchCause(
          logFailure("personal provider runtime event failed", { type: event.type }),
        ),
      );

    const readPersisted = (instanceId: ProviderInstanceId) =>
      deps.getMeta(smokeCheckMetaKey(instanceId)).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(null),
            onSome: (raw) => decodePersisted(raw).pipe(Effect.orElseSucceed(() => null)),
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    const writePersisted = (instanceId: ProviderInstanceId, value: PersistedSmokeCheck) =>
      deps
        .setMeta(smokeCheckMetaKey(instanceId), encodePersisted(value))
        .pipe(
          Effect.catchCause(
            logFailure("personal provider check could not be saved", { instanceId }),
          ),
        );

    const runCheck = (request: CheckRequest) =>
      Effect.gen(function* () {
        const { provider, version } = request;
        const instanceId = provider.instanceId;
        yield* deps.setSmokeCheck(instanceId, {
          status: "checking",
          version,
          checkedAt: null,
          message: null,
        });
        yield* Effect.logInfo("personal provider test message started", { instanceId, version });
        // Stops at the first model that answers: one working model proves the
        // provider survived the update. Every model is tried only when things
        // are already failing, which is when the extra turns are worth it.
        const failures: Array<SmokeLimitFailure> = [];
        let passed = false;
        let answeredBy: string | undefined;
        let answeredInMs: number | undefined;
        const attempt = (model: string) =>
          Effect.gen(function* () {
            const startedMs = yield* Clock.currentTimeMillis;
            const outcome = yield* Effect.exit(request.test(model));
            const endedMs = yield* Clock.currentTimeMillis;
            if (Exit.isSuccess(outcome)) {
              passed = true;
              answeredBy = model;
              answeredInMs = Math.max(0, Math.round(endedMs - startedMs));
              return;
            }
            failures.push({ model, detail: failureDetail(outcome.cause) });
          });
        for (const model of request.models) {
          yield* attempt(model);
          if (passed) break;
        }
        // A model the provider no longer lists: a failure on it says nothing
        // about the provider. Try the provider's own default model; when that
        // answers the provider is fine and only the bots need a new model.
        const listed = (model: string) =>
          provider.models.length === 0 ||
          provider.models.some(
            (candidate) => candidate.slug === model || (candidate.aliases ?? []).includes(model),
          );
        const unlisted = failures.filter((failure) => !listed(failure.model));
        const missingModels = [...new Set(unlisted.map((failure) => failure.model))];
        if (!passed && failures.length > 0 && unlisted.length === failures.length) {
          const fallback =
            provider.models.find((candidate) => candidate.isDefault === true) ?? provider.models[0];
          if (fallback !== undefined && !failures.some((f) => f.model === fallback.slug)) {
            yield* attempt(fallback.slug);
          }
        }
        const lastFailure = failures.at(-1) ?? null;
        const nowMs = yield* Clock.currentTimeMillis;
        const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        // Named, because "it failed" alone sends someone hunting an outage when
        // one bot simply points at a model that is gone.
        const message =
          lastFailure === null
            ? "No model could be tested."
            : `${lastFailure.model}: ${lastFailure.detail}`;
        // Out of usage is not a broken update: wait for the reset instead.
        const limited =
          !passed &&
          failures.length > 0 &&
          failures.every((failure) => isUsageLimitFailure(failure.detail));
        const retryAtMs = limited
          ? smokeLimitRetryAtMs(
              smokeLimitResetMs({
                instanceId,
                provider,
                failures,
                nowMs,
                failedAtMs: nowMs,
                allowPast: false,
              }),
              nowMs,
            )
          : null;
        const previousVersion = previousWorkingVersion(request.previous, version);
        const common = {
          ...(request.manual === true ? { manual: true } : {}),
          ...(previousVersion !== undefined && request.manual !== true ? { previousVersion } : {}),
        };
        const next: PersistedSmokeCheck = passed
          ? {
              version,
              status: "passed",
              checkedAt,
              message: null,
              ...(answeredBy !== undefined ? { model: answeredBy } : {}),
              ...(answeredInMs !== undefined ? { durationMs: answeredInMs } : {}),
              ...(missingModels.length > 0 ? { missingModels } : {}),
              ...(request.manual === true ? { manual: true } : {}),
            }
          : retryAtMs !== null
            ? {
                version,
                status: "waiting_for_limit",
                checkedAt,
                message,
                retryAt: DateTime.formatIso(DateTime.makeUnsafe(retryAtMs)),
                ...(lastFailure !== null ? { model: lastFailure.model } : {}),
                ...common,
              }
            : {
                version,
                status: "failed",
                checkedAt,
                message,
                ...(lastFailure !== null ? { model: lastFailure.model } : {}),
                ...common,
              };
        yield* cancelRetry(instanceId);
        yield* writePersisted(instanceId, next);
        yield* deps.setSmokeCheck(instanceId, projectionOf(next));
        if (next.status === "passed") {
          yield* Effect.logInfo("personal provider test message passed", { instanceId, version });
          return;
        }
        if (retryAtMs !== null) {
          // No alert and no "broke": the test runs again after the reset.
          yield* Effect.logInfo("personal provider test message waits for the usage limit", {
            instanceId,
            version,
            retryAt: next.retryAt,
            message: next.message,
          });
          yield* armRetry(instanceId, smokeLimitDueAtMs(retryAtMs), nowMs);
          return;
        }
        yield* Effect.logWarning("personal provider test message failed", {
          instanceId,
          version,
          message: next.message,
        });
        // One alert per version: a re-check that fails again stays quiet.
        const alreadyAlerted =
          request.previous?.status === "failed" && request.previous.version === version;
        if (!alreadyAlerted && request.manual !== true) {
          yield* deps.notifyBroken({ instanceId, label: providerProductName(provider), version });
        }
      }).pipe(
        Effect.ensuring(Effect.sync(() => checking.delete(request.provider.instanceId))),
        Effect.catchCause(
          logFailure("personal provider test message crashed", {
            instanceId: request.provider.instanceId,
          }),
        ),
      );
    // One check at a time, across providers: each spawns a CLI and a model turn.
    const worker = yield* makeDrainableWorker(runCheck);

    const cancelRetry = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const existing = retryTimers.get(instanceId);
        if (existing === undefined) return;
        retryTimers.delete(instanceId);
        yield* Fiber.interrupt(existing.fiber);
      });

    /** Looks at one provider again, as if its snapshot had just changed. */
    const reconsider = (instanceId: ProviderInstanceId) =>
      Effect.gen(function* () {
        const provider = (yield* deps.getProviders).find(
          (candidate) => candidate.instanceId === instanceId,
        );
        if (provider === undefined) return;
        yield* considerSmoke(provider, yield* deps.listBots, false);
      });

    /** Runs the test again at `dueAtMs`; a timer for the same time is left alone. */
    const armRetry = (instanceId: ProviderInstanceId, dueAtMs: number, nowMs: number) =>
      Effect.gen(function* () {
        if (retryTimers.get(instanceId)?.dueAtMs === dueAtMs) return;
        yield* cancelRetry(instanceId);
        // The fiber waits for the registration below, so a delay of zero cannot
        // fire (and delete its entry) before the entry exists.
        const armed = yield* Deferred.make<void>();
        const fiber = yield* Deferred.await(armed).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(Math.max(0, dueAtMs - nowMs)))),
          Effect.andThen(Effect.sync(() => void retryTimers.delete(instanceId))),
          Effect.andThen(reconsider(instanceId)),
          Effect.catchCause(
            logFailure("personal provider usage-limit retry failed", { instanceId }),
          ),
          Effect.forkIn(scope),
        );
        retryTimers.set(instanceId, { dueAtMs, fiber });
        yield* Deferred.succeed(armed, undefined);
      });

    /**
     * The stored verdict, with a "failed" one whose message is a usage limit read
     * as waiting (it was written before waiting existed; Harout's "Update broke
     * Codex" with "try again at Oct 16th, 2026 12:47 AM" was one). The change is
     * saved, so the retry time stays put instead of moving on every read.
     */
    const readVerdict = (provider: ServerProvider, nowMs: number) =>
      Effect.gen(function* () {
        const stored = yield* readPersisted(provider.instanceId);
        if (
          stored === null ||
          stored.status !== "failed" ||
          stored.message === null ||
          !isUsageLimitFailure(stored.message)
        ) {
          return stored;
        }
        const separator = stored.message.indexOf(": ");
        const checkedMs = stored.checkedAt === null ? Number.NaN : Date.parse(stored.checkedAt);
        const resetMs = smokeLimitResetMs({
          instanceId: provider.instanceId,
          provider,
          failures: [
            {
              model: separator > 0 ? stored.message.slice(0, separator) : "",
              detail: stored.message,
            },
          ],
          nowMs,
          failedAtMs: Number.isFinite(checkedMs) ? checkedMs : nowMs,
          allowPast: true,
        });
        const converted: PersistedSmokeCheck = {
          ...stored,
          status: "waiting_for_limit",
          retryAt: DateTime.formatIso(DateTime.makeUnsafe(smokeLimitRetryAtMs(resetMs, nowMs))),
        };
        yield* writePersisted(provider.instanceId, converted);
        yield* Effect.logInfo("personal provider test message failure was a usage limit", {
          instanceId: provider.instanceId,
          version: converted.version,
          retryAt: converted.retryAt,
        });
        return converted;
      });

    const considerSmoke = (
      provider: ServerProvider,
      bots: ReadonlyArray<PersonalBot>,
      force: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const instanceId = provider.instanceId;
        if (checking.has(instanceId)) return;
        const version = provider.version;
        if (version === null || !provider.installed || !provider.enabled) {
          // Nothing testable; a verdict about another version must not linger.
          yield* cancelRetry(instanceId);
          if (provider.smokeCheck !== undefined) yield* deps.setSmokeCheck(instanceId, null);
          return;
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const persisted = yield* readVerdict(provider, nowMs);
        if (!force) {
          if (persisted === null) {
            yield* writePersisted(instanceId, {
              version,
              status: "baseline",
              checkedAt: null,
              message: null,
            });
            return;
          }
          if (persisted.version === version) {
            const wanted = projectionOf(persisted);
            if (!sameProjection(provider.smokeCheck, wanted)) {
              yield* deps.setSmokeCheck(instanceId, wanted);
            }
            if (persisted.status !== "waiting_for_limit") return;
            // Waiting for a usage limit: the test runs once its time has come,
            // here or from the timer armed for it.
            const retryMs = Date.parse(persisted.retryAt ?? "");
            const dueAtMs = Number.isFinite(retryMs) ? smokeLimitDueAtMs(retryMs) : nowMs;
            if (dueAtMs > nowMs) {
              yield* armRetry(instanceId, dueAtMs, nowMs);
              return;
            }
          }
          // Signed out is not a broken update; the check runs once the account is back.
          if (provider.auth.status === "unauthenticated") return;
        }
        const models = botModelsFor(bots, instanceId);
        if (models.length === 0) return;
        const test = yield* deps.smokeTestFor(instanceId);
        if (Option.isNone(test)) return;
        checking.add(instanceId);
        yield* worker.enqueue({ provider, version, models, test: test.value, previous: persisted });
      });

    const handleProviders = (providers: ReadonlyArray<ServerProvider>) =>
      Effect.gen(function* () {
        yield* restartStaleSessions;
        const bots = yield* deps.listBots;
        const used = new Set<string>(bots.map((bot) => bot.modelSelection.instanceId));
        for (const provider of providers) {
          if (used.has(provider.instanceId)) yield* considerSmoke(provider, bots, false);
        }
      }).pipe(Effect.catchCause(logFailure("personal provider snapshot handling failed")));

    const recheck: PersonalProviderUpdatesShape["recheck"] = (input) =>
      Effect.gen(function* () {
        const providers = yield* deps.refreshInstance(input.instanceId);
        const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
        if (provider === undefined) {
          return yield* new PersonalBotsError({
            message: "That provider is not set up on this computer.",
          });
        }
        const bots = yield* deps.listBots.pipe(
          Effect.mapError(
            (cause) => new PersonalBotsError({ message: "Couldn't read your bots.", cause }),
          ),
        );
        yield* restartStaleSessions;
        yield* considerSmoke(provider, bots, true);
      });

    const testRun: PersonalProviderUpdatesShape["testRun"] = (input) =>
      Effect.gen(function* () {
        const provider = (yield* deps.getProviders).find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        const refuse = (message: string) => new PersonalBotsError({ message });
        if (provider === undefined) {
          return yield* refuse("That provider is not set up on this computer.");
        }
        if (!provider.installed || provider.version === null) {
          return yield* refuse("Install it before testing it.");
        }
        if (!provider.enabled) return yield* refuse("Turn it on before testing it.");
        if (checking.has(provider.instanceId)) return;
        const test = yield* deps.smokeTestFor(provider.instanceId);
        if (Option.isNone(test)) return yield* refuse("This provider has no test message.");
        const model =
          input.model ??
          (provider.models.find((candidate) => candidate.isDefault === true) ?? provider.models[0])
            ?.slug;
        if (model === undefined) return yield* refuse("There is no model to test with.");
        if (
          model.trimStart().startsWith("-") ||
          !provider.models.some(
            (candidate) => candidate.slug === model || candidate.aliases?.includes(model),
          )
        )
          return yield* refuse("Choose a model listed by this provider.");
        const nowMs = yield* Clock.currentTimeMillis;
        const previous = yield* readVerdict(provider, nowMs);
        yield* cancelRetry(provider.instanceId);
        checking.add(provider.instanceId);
        yield* worker.enqueue({
          provider,
          version: provider.version,
          models: [model],
          test: test.value,
          previous,
          manual: true,
        });
      });

    const start: PersonalProviderUpdatesShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(Stream.runForEach(deps.runtimeEvents, handleRuntimeEvent));
        yield* forkParked(
          Effect.gen(function* () {
            yield* handleProviders(yield* deps.getProviders);
            yield* Stream.runForEach(deps.providerChanges, handleProviders);
          }),
        );
        yield* forkParked(
          restartStaleSessions.pipe(
            withStallJob("job:provider-update-restart-sweep"),
            Effect.repeat(Schedule.spaced(RESTART_SWEEP_INTERVAL)),
            Effect.asVoid,
          ),
        );
      });

    return {
      start,
      recheck,
      testRun,
      handleProviders,
      handleRuntimeEvent,
      restartStaleSessions,
      drainChecks: worker.drain,
    } satisfies PersonalProviderUpdatesShape;
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry;
  const providerService = yield* ProviderService;
  const instances = yield* ProviderInstanceRegistry;
  const projection = yield* ProjectionSnapshotQuery;
  const bots = yield* PersonalBotRepository.PersonalBotRepository;
  const push = yield* PersonalPushService.PersonalPushService;
  return yield* makeWith({
    getProviders: providers.getProviders,
    providerChanges: providers.streamChanges,
    refreshInstance: providers.refreshInstance,
    setSmokeCheck: (instanceId, state) =>
      providers
        .setProviderMaintenanceActionState({ instanceId, action: "smokeCheck", state })
        .pipe(Effect.asVoid),
    runtimeEvents: providerService.streamEvents,
    listSessions: providerService.listSessions(),
    stopSession: (threadId) => providerService.stopSession({ threadId }),
    threadShell: (threadId) => projection.getThreadShellById(threadId),
    isPersonalThread: (threadId) =>
      bots.getThreadLink({ threadId }).pipe(Effect.map(Option.isSome)),
    listBots: bots.listBots(),
    getMeta: (key) => bots.getMeta({ key }),
    setMeta: (key, value) => bots.setMeta({ key, value }),
    smokeTestFor: (instanceId) =>
      instances.getInstance(instanceId).pipe(
        Effect.map((instance) =>
          Option.fromNullishOr(instance?.smokeTest).pipe(
            Option.map(
              (smokeTest): SmokeTest =>
                (model) =>
                  smokeTest({ model }),
            ),
          ),
        ),
      ),
    notifyBroken: push.notifyProviderBroken,
  });
});

export const layer = Layer.effect(PersonalProviderUpdates, make);
