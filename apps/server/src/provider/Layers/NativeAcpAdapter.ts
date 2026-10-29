import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ThreadId,
  TurnId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as AcpErrors from "effect-acp/errors";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { providerLimitRetryInfo } from "../providerLimitRetry.ts";
import { buildRuntimeInstructions, withBotInstructions } from "../RuntimeInstructions.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpToolCallEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpThreadTokenUsageEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { appendAcpStderrTail } from "../acp/AcpStderr.ts";
import { terminateDescendants } from "../processTree.ts";
import {
  isAuthRequiredError,
  signInTurnMessage,
  toAuthMethods,
  type RegistryAuthMemory,
} from "../catalog/registryAuth.ts";
import { isRegistryTurnSilent, promptUnlessSilent } from "../catalog/registryProbe.ts";
import {
  registryCurrentModel,
  registryModelEntries,
  registryModelSwitch,
} from "../catalog/registryModels.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

/**
 * An ACP agent refuses a second `session/prompt` on a session whose turn is
 * still running with "Session already has an active ACP prompt: <id>".
 *
 * The match is case-insensitive and does not depend on the suffix, so a
 * wording change on the agent side cannot turn the wait below back into a
 * failed turn.
 */
const ACP_PROMPT_BUSY_PATTERN = /already has an active acp/i;
/** 40 attempts, 250 ms apart: a bounded 10 s wait for the flag to clear. */
const ACP_PROMPT_BUSY_ATTEMPTS = 40;
const ACP_PROMPT_BUSY_INTERVAL_MS = 250;

/** True when an ACP error is the agent still holding an active prompt. */
export const isAcpPromptBusyError = (message: string): boolean =>
  ACP_PROMPT_BUSY_PATTERN.test(message);

/** Readable text from an unknown thrown value, following its cause chain. */
const describeUnknownError = (value: unknown): string => {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? "" : describeUnknownError(value.cause);
    return [value.message, cause].filter((part) => part.length > 0).join("\n");
  }
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as {
      readonly message?: unknown;
      readonly detail?: unknown;
      readonly cause?: unknown;
    };
    return [
      typeof record.message === "string" ? record.message : "",
      typeof record.detail === "string" ? record.detail : "",
      record.cause === undefined ? "" : describeUnknownError(record.cause),
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return "";
};

/**
 * All readable text in a cause, typed failures and defects alike.
 *
 * The OpenCode 2 agent reports the busy refusal through a defect-shaped
 * JSON-RPC error (Effect's `decodeDefect` path), so matching only typed
 * `AcpRequestError`s left the retry below and the failed-turn cleanup
 * unreachable exactly when the agent was busy.
 */
export const acpCauseText = (cause: Cause.Cause<unknown>): string => {
  const reasons = cause.reasons.map((reason) =>
    Cause.isFailReason(reason)
      ? describeUnknownError(reason.error)
      : Cause.isDieReason(reason)
        ? describeUnknownError(reason.defect)
        : "",
  );
  const text = reasons.filter((part) => part.length > 0).join("\n");
  return text.length > 0 ? text : Cause.pretty(cause);
};

/** True when any form of failure in the cause is the agent still holding a prompt. */
export const isAcpPromptBusyCause = (cause: Cause.Cause<unknown>): boolean =>
  isAcpPromptBusyError(acpCauseText(cause));

interface PendingApproval {
  readonly deferred: Deferred.Deferred<EffectAcpSchema.RequestPermissionResponse>;
  readonly request: EffectAcpSchema.RequestPermissionRequest;
}

/**
 * Full-access threads approve tools without asking, as the OpenCode v1 driver
 * and the Cursor/Grok ACP adapters do. Prefer a one-call grant so switching
 * back to supervised mode does not inherit remembered permissions.
 */
export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }
  return undefined;
}

interface RegistryAcpSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Scope;
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  session: ProviderSession;
  activeTurnId?: TurnId;
  pendingSteers: number;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  /** What the agent offered when the session opened; models and how to switch them. */
  readonly setup: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];
  /** The model the agent is on now. */
  appliedModel: string | undefined;
  /** Whether the agent has produced any output for the active turn. */
  turnHeard: boolean;
  notificationFiber?: Fiber.Fiber<void, unknown>;
  stopped: boolean;
  readonly needsFreshContext: boolean;
  /** The start input, so a same-thread restart keeps the persona and runtime mode. */
  readonly startInput: ProviderSessionStartInput;
  /** What the running process was started with (auth file, binary path, XDG
   * homes). ACP agents read that environment once, at session start. */
  readonly environmentFingerprint: string | undefined;
  /** The model a fresh-session retry was already spent on, so a truly missing
   * model fails at once instead of restarting the agent on every turn. */
  modelRefreshAttempted?: string;
}

export interface NativeAcpAdapterOptions {
  readonly needsFreshContext?: (input: ProviderSessionStartInput) => boolean;
  /**
   * Identifies the environment the agent captured when the session started.
   * A resume cursor carrying another value starts a fresh session, and a live
   * session whose value changed is replaced before its next turn. Drivers whose
   * agent re-reads its environment per turn leave this unset.
   */
  readonly sessionFingerprint?: (input: ProviderSessionStartInput) => Effect.Effect<string>;
  readonly provider: ProviderDriverKind;
  readonly runtimeOptions: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<AcpSessionRuntime.AcpSessionRuntimeOptions, ProviderAdapterError, Scope.Scope>;
  readonly configureTurn?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    input: ProviderSendTurnInput,
  ) => Effect.Effect<void, ProviderAdapterError>;
  readonly promptAttachments?: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ReadonlyArray<EffectAcpSchema.ContentBlock>, ProviderAdapterError>;
  readonly instanceId?: ProviderInstanceId;
  /** The provider's name as the user sees it, for sign-in messages. */
  readonly displayName?: string;
  /** What is known about the agent's sign-in; the driver shows it on the snapshot. */
  readonly auth?: RegistryAuthMemory;
  /** Silence allowed before a turn counts as "needs sign-in". Default: 45 s. */
  readonly firstOutputTimeout?: Duration.Input;
  /**
   * The agent already has the persona and runtime notes in its session context
   * (opencode2 writes them to an instructions file it reads at session start),
   * so a turn's prompt carries only the owner's message and turn context.
   * Without this the adapter repeats the instructions in every prompt.
   */
  readonly instructionsInSession?: boolean;
  /**
   * One short line appended to every turn asking the model to narrate progress
   * between tool calls. OpenCode 2's DeepSeek stays silent until the end
   * without it; Claude models already talk while they work.
   */
  readonly turnNarration?: string;
}

export function makeNativeAcpAdapter(options: NativeAcpAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("registry");
    const DRIVER = options.provider;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const sessions = new Map<ThreadId, RegistryAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const ownerScope = yield* Effect.scope;

    const providerName = options.displayName?.trim() || "This agent";
    const currentMethods = options.auth
      ? SubscriptionRef.get(options.auth.state).pipe(Effect.map((state) => state.methods))
      : Effect.succeed([]);
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: DRIVER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    /**
     * One turn in flight per thread. ACP has a single prompt per session, so a
     * message the owner sends while a turn is running waits here and starts
     * right after it, instead of failing their send with "Wait for the current
     * registry-agent turn to finish." Keyed by thread, not held on the session
     * context, so a replaced session cannot slip past a queued turn's permit.
     */
    const turnQueuesRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const getTurnQueue = (threadId: string) =>
      SynchronizedRef.modifyEffect(turnQueuesRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const settlePendingApprovalsAsCancelled = (
      approvals: Map<ApprovalRequestId, PendingApproval>,
    ) =>
      Effect.forEach(
        Array.from(approvals.values()),
        (pending) =>
          Deferred.succeed(pending.deferred, {
            outcome: { outcome: "cancelled" },
          } as EffectAcpSchema.RequestPermissionResponse).pipe(Effect.asVoid),
        { discard: true },
      );

    const stopSessionInternal = (ctx: RegistryAcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: DRIVER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<RegistryAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: DRIVER, threadId }));
      }
      return Effect.succeed(ctx);
    };

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (
      input: ProviderSessionStartInput,
    ) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = path.resolve(input.cwd);

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;

          const startEffect = Effect.gen(function* () {
            const environmentFingerprint = options.sessionFingerprint
              ? yield* options.sessionFingerprint(input)
              : undefined;
            // A resumed agent keeps the environment it read at its own session
            // start: a changed auth file, binary or XDG home must not resume it.
            // An old cursor without the fingerprint is treated the same way, so
            // the first turn after this upgrade starts a clean session.
            const resumeCursor = input.resumeCursor;
            const resumedAcpSession =
              typeof resumeCursor === "object" &&
              resumeCursor !== null &&
              "engine" in resumeCursor &&
              resumeCursor.engine === "acp" &&
              "sessionId" in resumeCursor &&
              typeof resumeCursor.sessionId === "string";
            const resumedFingerprint =
              resumedAcpSession && "fingerprint" in resumeCursor
                ? resumeCursor.fingerprint
                : undefined;
            const staleResume =
              options.sessionFingerprint !== undefined &&
              resumedAcpSession &&
              resumedFingerprint !== environmentFingerprint;
            const effectiveInput = staleResume
              ? { ...input, resumeCursor: undefined, freshSession: true }
              : input;
            const runtimeOptions = yield* options.runtimeOptions(effectiveInput);

            let launcherPid: number | undefined;
            let stderrTail = "";
            const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
            let context: RegistryAcpSessionContext | undefined;

            const runtime = yield* AcpSessionRuntime.make({
              ...runtimeOptions,
              onProcessStarted: (pid) =>
                Effect.sync(() => {
                  launcherPid = pid;
                }),
              onStderr: (text) =>
                Effect.sync(() => {
                  stderrTail = appendAcpStderrTail(stderrTail, text);
                }),
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: DRIVER,
                    threadId: input.threadId,
                    detail: (cause as { detail?: string }).detail ?? cause.message,
                    cause,
                  }),
              ),
            );

            // Add tree-kill finalizer for launcher pid on teardown
            yield* Effect.addFinalizer(() =>
              launcherPid !== undefined
                ? terminateDescendants(launcherPid).pipe(Effect.ignore)
                : Effect.void,
            );

            yield* runtime.handleRequestPermission((request) =>
              Effect.gen(function* () {
                if (!context || context.stopped)
                  return { outcome: { outcome: "cancelled" as const } };
                if (context.session.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(request);
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: { outcome: "selected" as const, optionId: autoApprovedOptionId },
                    };
                  }
                }
                const requestId = ApprovalRequestId.make(yield* crypto.randomUUIDv4);
                const deferred = yield* Deferred.make<EffectAcpSchema.RequestPermissionResponse>();
                pendingApprovals.set(requestId, { request, deferred });
                const permissionRequest = parsePermissionRequest(request);
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: DRIVER,
                    threadId: input.threadId,
                    turnId: context.activeTurnId,
                    requestId: RuntimeRequestId.make(requestId),
                    permissionRequest,
                    detail: permissionRequest.detail ?? "Registry agent requests permission.",
                    args: request,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: request,
                  }),
                );
                return yield* Deferred.await(deferred).pipe(
                  Effect.ensuring(Effect.sync(() => pendingApprovals.delete(requestId))),
                );
              }).pipe(
                Effect.mapError((cause) =>
                  AcpErrors.AcpRequestError.internalError(
                    "Could not process registry permission request.",
                    undefined,
                    { cause },
                  ),
                ),
              ),
            );

            const started = yield* runtime.start().pipe(
              Effect.catch((cause) =>
                isAuthRequiredError(cause)
                  ? Effect.gen(function* () {
                      yield* options.auth?.markNeeded ?? Effect.void;
                      return yield* new ProviderAdapterProcessError({
                        provider: DRIVER,
                        threadId: input.threadId,
                        detail: signInTurnMessage(providerName, yield* currentMethods),
                        cause,
                      });
                    })
                  : Effect.fail(
                      mapAcpToAdapterError(DRIVER, input.threadId, "session/initialize", cause),
                    ),
              ),
            );
            yield* (
              options.auth?.setMethods(toAuthMethods(started.initializeResult.authMethods ?? [])) ??
                Effect.void
            );

            const createdAt = yield* nowIso;
            const sessionRecord: ProviderSession = {
              provider: DRIVER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              cwd,
              status: "ready",
              runtimeMode: input.runtimeMode,
              ...(runtimeOptions.resumeSessionId !== undefined || DRIVER === "opencode"
                ? {
                    resumeCursor: {
                      sessionId: started.sessionId,
                      engine: "acp",
                      ...(environmentFingerprint !== undefined
                        ? { fingerprint: environmentFingerprint }
                        : {}),
                    },
                  }
                : {}),
              createdAt,
              updatedAt: createdAt,
            };

            const ctx: RegistryAcpSessionContext = {
              threadId: input.threadId,
              scope: sessionScope,
              runtime,
              session: sessionRecord,
              pendingApprovals,
              setup: started.sessionSetupResult,
              appliedModel: registryCurrentModel(started.sessionSetupResult),
              turnHeard: false,
              pendingSteers: 0,
              stopped: false,
              needsFreshContext: options.needsFreshContext?.(input) ?? false,
              startInput: input,
              environmentFingerprint,
            };
            context = ctx;

            // Consume ACP events and dispatch to pubsub
            const eventFiber = yield* Stream.runForEach(runtime.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  return yield* Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
                }
                if (ctx.stopped) return;
                // A steer waits for the cancelled prompt to answer. Its closing
                // text ("Request cancelled.") must not join the steered reply.
                if (
                  event._tag === "ContentDelta" &&
                  ctx.activeTurnId === undefined &&
                  ctx.pendingSteers > 0
                ) {
                  return;
                }
                if (
                  !ctx.turnHeard &&
                  ctx.activeTurnId !== undefined &&
                  (event._tag === "ContentDelta" ||
                    event._tag === "ThoughtDelta" ||
                    event._tag === "AssistantItemStarted" ||
                    event._tag === "ToolCallUpdated" ||
                    event._tag === "PlanUpdated" ||
                    event._tag === "UsageUpdated")
                ) {
                  ctx.turnHeard = true;
                  // Output proves the agent works, whatever it listed for sign-in.
                  yield* options.auth?.markSignedIn ?? Effect.void;
                }
                const common = {
                  stamp: yield* makeEventStamp(),
                  provider: DRIVER,
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId ?? ctx.session.activeTurnId,
                };
                switch (event._tag) {
                  case "ContentDelta":
                  case "ThoughtDelta":
                    return yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        ...common,
                        text: event.text,
                        rawPayload: event.rawPayload,
                        ...(event._tag === "ThoughtDelta"
                          ? { streamKind: "reasoning_text" as const }
                          : event.itemId
                            ? { itemId: event.itemId }
                            : {}),
                      }),
                    );
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    return yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        ...common,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                  case "ToolCallUpdated":
                    return yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        ...common,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                  case "PlanUpdated":
                    return yield* offerRuntimeEvent(
                      makeAcpPlanUpdatedEvent({
                        ...common,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                  case "UsageUpdated":
                    return yield* offerRuntimeEvent(
                      makeAcpThreadTokenUsageEvent({
                        ...common,
                        usedTokens: event.usedTokens,
                        ...(event.maxTokens === undefined ? {} : { maxTokens: event.maxTokens }),
                        rawPayload: event.rawPayload,
                      }),
                    );
                  case "ConnectionTerminated":
                    return yield* stopSessionInternal(ctx).pipe(
                      Effect.forkIn(ownerScope),
                      Effect.asVoid,
                    );
                }
              }),
            ).pipe(Effect.ignore, Effect.forkIn(ctx.scope));

            ctx.notificationFiber = eventFiber;
            sessions.set(input.threadId, ctx);
            sessionScopeTransferred = true;

            yield* offerRuntimeEvent({
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: DRIVER,
              threadId: input.threadId,
              payload: { resume: sessionRecord.resumeCursor ?? started.initializeResult },
            });

            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: DRIVER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Registry ACP session ready" },
            });

            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: DRIVER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });

            return ctx.session;
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.onError(() =>
              sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
            ),
          );

          return yield* startEffect;
        }),
      );

    const runTurn = (
      input: ProviderSendTurnInput,
      continuation?: { readonly context: RegistryAcpSessionContext; readonly turnId: TurnId },
    ) =>
      Effect.gen(function* () {
        let supersededLaunchFailure = false;
        const launch = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const continuing = continuation !== undefined && continuation.context === ctx;
            if (continuing) ctx.pendingSteers -= 1;
            if (continuing && ctx.session.activeTurnId !== continuation.turnId) {
              return yield* Effect.interrupt;
            }
            if (ctx.needsFreshContext)
              return yield* new ProviderAdapterRequestError({
                provider: DRIVER,
                method: "session/prompt",
                detail:
                  "No conversation found with session ID: the previous OpenCode generation. Restore the stored chat in the new session.",
              });
            if (ctx.activeTurnId)
              return yield* new ProviderAdapterValidationError({
                provider: DRIVER,
                operation: "sendTurn",
                issue: "Wait for the current registry-agent turn to finish.",
              });
            // Switch the agent's model before the turn exists, so a refusal leaves no half-started turn.
            const wanted = input.modelSelection?.model;
            if (wanted && wanted !== "default" && wanted !== ctx.appliedModel) {
              const offered = registryModelEntries(ctx.setup);
              if (offered.length > 0 && !offered.some((entry) => entry.value === wanted)) {
                return yield* new ProviderAdapterValidationError({
                  provider: DRIVER,
                  operation: "sendTurn",
                  issue: `${providerName} does not offer the model '${wanted}'. Pick another model.`,
                });
              }
              const via = registryModelSwitch(ctx.setup);
              const switchModel =
                via === "config"
                  ? ctx.runtime.setModel(wanted)
                  : via === "session"
                    ? ctx.runtime.setSessionModel(wanted).pipe(Effect.asVoid)
                    : Effect.void;
              yield* switchModel.pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(DRIVER, input.threadId, "session/set_config_option", cause),
                ),
              );
              ctx.appliedModel = wanted;
            }
            if (options.configureTurn) yield* options.configureTurn(ctx.runtime, input);

            const attachments = options.promptAttachments
              ? yield* options.promptAttachments(input)
              : [];
            // ACP needs a new prompt after cancellation, but a steer is still
            // the same logical turn. Its old prompt must not finish the task.
            const turnId = continuing ? continuation.turnId : TurnId.make(yield* randomUUIDv4);
            ctx.activeTurnId = turnId;
            ctx.turnHeard = false;
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };
            if (!continuing)
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: DRIVER,
                threadId: input.threadId,
                turnId,
                payload: {},
              });
            const promptPayload = {
              prompt: [
                {
                  type: "text" as const,
                  text: [
                    input.turnContext,
                    input.input,
                    options.instructionsInSession === true
                      ? undefined
                      : withBotInstructions(
                          buildRuntimeInstructions({
                            harness: `${providerName} ACP`,
                            model: input.modelSelection?.model,
                          }),
                          input.systemInstructions,
                        ),
                    options.turnNarration,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                },
                ...attachments,
              ],
            };
            // A steer cancels the running prompt and sends this one right
            // after it. The agent clears its own "active prompt" flag a moment
            // after its cancelled response, and noticeably later when the
            // machine is busy, so retry that one refusal for a bounded window
            // instead of failing the owner's message. Any other error fails at
            // once. The refusal arrives as a defect from the OpenCode 2 agent,
            // so this matches the whole cause, not only typed failures.
            const promptWithBusyRetry = (attempt: number): ReturnType<typeof ctx.runtime.prompt> =>
              Effect.suspend(() => {
                // Stop can arrive while the busy retry sleeps, when the runtime
                // has no in-flight prompt for session/cancel to interrupt.
                if (ctx.stopped || ctx.activeTurnId !== turnId) {
                  return Effect.succeed({ stopReason: "cancelled" as const });
                }
                return ctx.runtime
                  .prompt(promptPayload)
                  .pipe(
                    Effect.catchCause((cause) =>
                      attempt < ACP_PROMPT_BUSY_ATTEMPTS && isAcpPromptBusyCause(cause)
                        ? Effect.sleep(`${ACP_PROMPT_BUSY_INTERVAL_MS} millis`).pipe(
                            Effect.flatMap(() => promptWithBusyRetry(attempt + 1)),
                          )
                        : Effect.failCause(cause),
                    ),
                  );
              });
            const fiber = yield* promptWithBusyRetry(0).pipe(Effect.forkIn(ctx.scope));
            return { ctx, turnId, fiber };
          }),
        ).pipe(
          Effect.tapCause((cause) => {
            if (!continuation || Cause.hasInterruptsOnly(cause)) return Effect.void;
            const ctx = continuation.context;
            // A replacement prompt can fail during model/persona setup too.
            // That is a real failure, never a silent wait on a cancelled prompt.
            return withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                if (
                  ctx.stopped ||
                  ctx.pendingSteers > 0 ||
                  ctx.session.activeTurnId !== continuation.turnId
                ) {
                  supersededLaunchFailure = true;
                  return;
                }
                ctx.session = {
                  ...ctx.session,
                  status: "ready",
                  activeTurnId: undefined,
                  updatedAt: yield* nowIso,
                };
                const errorMessage = acpCauseText(cause);
                const retry = providerLimitRetryInfo(errorMessage);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: DRIVER,
                  threadId: input.threadId,
                  turnId: continuation.turnId,
                  payload: {
                    state: "failed",
                    errorMessage,
                    ...(retry !== undefined ? { retry } : {}),
                  },
                });
              }),
            );
          }),
          Effect.catchCause((cause) =>
            supersededLaunchFailure ? Effect.succeed(undefined) : Effect.failCause(cause),
          ),
        );
        if (!launch)
          return {
            threadId: input.threadId,
            turnId: continuation!.turnId,
          } satisfies ProviderTurnStartResult;
        const { ctx, turnId, fiber } = launch;
        // An agent that lists sign-in options and has not produced output yet may
        // be waiting for a sign-in it never announces; give it a deadline.
        const authState = options.auth ? yield* SubscriptionRef.get(options.auth.state) : undefined;
        const watched =
          authState !== undefined &&
          authState.methods.length > 0 &&
          authState.verdict !== "signedIn";
        let silentText: string | undefined;
        let supersededPromptFailure = false;
        const answered = Fiber.await(fiber).pipe(Effect.flatMap((exit) => exit));
        const response = yield* (
          watched
            ? promptUnlessSilent({
                prompt: answered,
                sawOutput: Effect.sync(() => ctx.turnHeard),
                ...(options.firstOutputTimeout !== undefined
                  ? { timeout: options.firstOutputTimeout }
                  : {}),
              })
            : answered
        ).pipe(
          Effect.catchCause((cause) =>
            !Cause.hasInterruptsOnly(cause) &&
            (ctx.activeTurnId !== turnId || ctx.pendingSteers > 0)
              ? // Do not let the reactor turn a cancelled prompt's rejection
                // into a session error after the steer took ownership.
                Effect.succeed({ stopReason: "cancelled" as const })
              : Effect.failCause(cause),
          ),
          Effect.catch((cause) =>
            isRegistryTurnSilent(cause)
              ? Effect.gen(function* () {
                  silentText = signInTurnMessage(providerName, authState?.methods ?? []);
                  yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
                  yield* ctx.runtime.cancel.pipe(Effect.ignore);
                  yield* options.auth?.markNeeded ?? Effect.void;
                  return yield* new ProviderAdapterRequestError({
                    provider: DRIVER,
                    method: "session/prompt",
                    detail: silentText,
                  });
                })
              : isAuthRequiredError(cause)
                ? Effect.gen(function* () {
                    silentText = signInTurnMessage(providerName, authState?.methods ?? []);
                    yield* options.auth?.markNeeded ?? Effect.void;
                    return yield* new ProviderAdapterRequestError({
                      provider: DRIVER,
                      method: "session/prompt",
                      detail: silentText,
                    });
                  })
                : Effect.fail(
                    mapAcpToAdapterError(DRIVER, input.threadId, "session/prompt", cause),
                  ),
          ),
          // Any failure must end this turn's lifecycle, including a defect:
          // without the turn.completed event the chat stayed "running" on a
          // turn the agent never started, and every later queued message
          // waited behind it.
          Effect.tapCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const detailText = silentText ?? acpCauseText(cause);
            return withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                // Cancellation can reject the old prompt instead of returning
                // a stop reason. Its error cannot settle an admitted steer.
                if (ctx.stopped || ctx.activeTurnId !== turnId || ctx.pendingSteers > 0) {
                  supersededPromptFailure = true;
                  return;
                }
                delete ctx.activeTurnId;
                ctx.session = {
                  ...ctx.session,
                  status: "ready",
                  activeTurnId: undefined,
                  updatedAt: yield* nowIso,
                };
                const retry = providerLimitRetryInfo(detailText);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: DRIVER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    errorMessage: detailText,
                    ...(retry !== undefined ? { retry } : {}),
                  },
                });
                // The agent never answered, so its process may be stuck on the prompt.
                // Ending the session frees its files; the next turn starts a fresh one.
                // A busy refusal does not end the session: its own prompt was
                // rejected, and an older prompt that is genuinely still running
                // must not be killed by the cleanup of the turn that lost.
                if (silentText !== undefined) yield* stopSessionInternal(ctx);
              }),
            );
          }),
          // The cleanup above runs for any cause, but the caller still gets a
          // typed adapter error instead of a defect it cannot describe.
          Effect.catchCause((cause) => {
            if (supersededPromptFailure)
              return Effect.succeed({ stopReason: "cancelled" as const });
            if (Cause.hasInterruptsOnly(cause) || cause.reasons.some(Cause.isFailReason)) {
              return Effect.failCause(cause as Cause.Cause<ProviderAdapterError>);
            }
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: DRIVER,
                method: "session/prompt",
                detail: acpCauseText(cause),
                cause,
              }),
            );
          }),
        );
        yield* ctx.runtime.drainEvents;
        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            // Admission and settlement share the lock: a steer cannot arrive
            // between the pending-steer check and the terminal event.
            if (!ctx.stopped && ctx.activeTurnId === turnId && ctx.pendingSteers === 0) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: DRIVER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: response.stopReason === "cancelled" ? "interrupted" : "completed",
                  stopReason: response.stopReason,
                },
              });
            }
            // Only the prompt that still owns the session may settle it.
            if (ctx.activeTurnId === turnId) {
              delete ctx.activeTurnId;
              if (ctx.pendingSteers === 0)
                ctx.session = {
                  ...ctx.session,
                  status: "ready",
                  activeTurnId: undefined,
                  updatedAt: yield* nowIso,
                };
            }
          }),
        );
        return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        // The agent captured its environment when this session started. A new
        // auth file or binary must not be used through the old process: replace
        // it before the turn. A model the old process does not list is the same
        // symptom (a newly available model after a key change), so it gets one
        // fresh-session retry too.
        if (options.sessionFingerprint) {
          const existing = sessions.get(input.threadId);
          if (
            existing &&
            !existing.stopped &&
            !existing.activeTurnId &&
            existing.session.status !== "running"
          ) {
            const currentFingerprint = yield* options.sessionFingerprint(existing.startInput);
            const wanted = input.modelSelection?.model;
            const offered = registryModelEntries(existing.setup);
            const modelMissing =
              wanted !== undefined &&
              wanted !== "default" &&
              wanted !== existing.appliedModel &&
              existing.modelRefreshAttempted !== wanted &&
              offered.length > 0 &&
              !offered.some((entry) => entry.value === wanted);
            if (currentFingerprint !== existing.environmentFingerprint || modelMissing) {
              yield* Effect.logInfo("ACP session environment changed; starting a fresh session", {
                provider: DRIVER,
                threadId: input.threadId,
                reason: modelMissing ? "model-not-offered" : "environment-changed",
              });
              yield* startSession({
                ...existing.startInput,
                ...(input.modelSelection !== undefined
                  ? { modelSelection: input.modelSelection }
                  : {}),
                resumeCursor: undefined,
                freshSession: true,
              });
              if (modelMissing) {
                const restarted = sessions.get(input.threadId);
                if (restarted) restarted.modelRefreshAttempted = wanted;
              }
            }
          }
        }
        // Cancel only the ACP prompt, retaining the logical turn and its
        // running session. Stop alone emits turn.aborted. Publishing that
        // event for a steer used to settle delegated tasks as interrupted
        // before their replacement prompt could run.
        if (input.followUp !== "queue" && process.env.PERSONAL_TASK_STEER_CONTINUITY === "off") {
          const running = sessions.get(input.threadId);
          if (running && !running.stopped && running.activeTurnId) {
            yield* interruptTurn(input.threadId, running.activeTurnId);
          }
        }
        const continuation =
          input.followUp === "queue" || process.env.PERSONAL_TASK_STEER_CONTINUITY === "off"
            ? undefined
            : yield* withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  const ctx = sessions.get(input.threadId);
                  if (
                    !ctx ||
                    ctx.stopped ||
                    ctx.session.status !== "running" ||
                    !ctx.session.activeTurnId
                  ) {
                    return undefined;
                  }
                  const turnId = ctx.session.activeTurnId;
                  ctx.pendingSteers += 1;
                  if (ctx.activeTurnId) {
                    // The cancelled prompt's tail no longer owns settlement.
                    delete ctx.activeTurnId;
                    yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
                    // Keep the RPC alive: the turn queue must wait for the
                    // agent's response, including any tool still in flight.
                    // Stop uses cancel, which also interrupts the local wait.
                    yield* ctx.runtime.requestCancel.pipe(Effect.ignore);
                  }
                  return { context: ctx, turnId };
                }),
              );
        return yield* Effect.flatMap(getTurnQueue(input.threadId), (queue) =>
          queue.withPermit(runTurn(input, continuation)),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const resolvedTurnId = turnId ?? ctx.activeTurnId ?? ctx.session.activeTurnId;
        delete ctx.activeTurnId;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* ctx.runtime.cancel.pipe(Effect.ignore);
        ctx.session = {
          ...ctx.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
        if (resolvedTurnId) {
          yield* offerRuntimeEvent({
            type: "turn.aborted",
            ...(yield* makeEventStamp()),
            provider: DRIVER,
            threadId,
            turnId: resolvedTurnId,
            payload: { reason: "interrupted" },
          });
        }
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) yield* stopSessionInternal(ctx);
        }),
      );

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => ctx.session),
      );

    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.succeed({ threadId, turns: [] });

    const rollbackThread = (_threadId: ThreadId, _numTurns: number) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: DRIVER,
          operation: "rollbackThread",
          issue: "Registry agents do not support conversation rollback.",
        }),
      );

    const streamEvents: Stream.Stream<ProviderRuntimeEvent> = Stream.fromPubSub(runtimeEventPubSub);

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: DRIVER,
            method: "session/request_permission",
            detail: "This approval request is no longer pending.",
          });
        }
        ctx.pendingApprovals.delete(requestId);
        // Only an explicit accept allows the action. Decline picks the agent's
        // reject option when it offers one; Cancel and anything else cancel.
        const wantedKind =
          decision === "accept"
            ? "allow_once"
            : decision === "acceptForSession" || decision === "acceptAlways"
              ? "allow_always"
              : decision === "decline"
                ? "reject_once"
                : undefined;
        const option =
          wantedKind === undefined
            ? undefined
            : pending.request.options?.find((o) => o.kind === wantedKind);
        const response: EffectAcpSchema.RequestPermissionResponse =
          option === undefined
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: option.optionId } };
        yield* offerRuntimeEvent(
          makeAcpRequestResolvedEvent({
            stamp: yield* makeEventStamp(),
            provider: DRIVER,
            threadId,
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            permissionRequest: parsePermissionRequest(pending.request),
            decision,
          }),
        );
        yield* Deferred.succeed(pending.deferred, response);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    return {
      provider: DRIVER,
      capabilities: {
        sessionModelSwitch: "in-session" as const,
        promptlessTurnContinuation: false,
        supportsConversationRollback: false,
      },
      validateTurn: (input: Pick<ProviderSendTurnInput, "attachments">) =>
        input.attachments?.length && !options.promptAttachments
          ? Effect.fail(
              new ProviderAdapterValidationError({
                provider: DRIVER,
                operation: "sendTurn",
                issue: "Registry ACP agents currently support text prompts only.",
              }),
            )
          : Effect.void,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      stopAll,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      streamEvents,
    };
  });
}
