import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
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

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { appendAcpStderrTail } from "../acp/AcpStderr.ts";
import { terminateDescendants } from "../processTree.ts";
import { CatalogInstaller } from "../catalog/installer.ts";
import { toSpawnInput } from "../catalog/launch.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const DRIVER = ProviderDriverKind.make("registry");

interface PendingApproval {
  readonly deferred: Deferred.Deferred<EffectAcpSchema.RequestPermissionResponse>;
  readonly request: EffectAcpSchema.RequestPermissionRequest;
}

interface RegistryAcpSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Scope;
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  session: ProviderSession;
  activeTurnId?: TurnId;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  notificationFiber?: Fiber.Fiber<void, unknown>;
  stopped: boolean;
}

export interface RegistryAcpAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly catalogId: string;
  readonly nodePath: string | null;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export function makeRegistryAcpAdapter(options: RegistryAcpAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("registry");
    const catalogId = options.catalogId;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const installer = yield* CatalogInstaller;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const sessions = new Map<ThreadId, RegistryAcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

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

    const settlePendingApprovalsAsCancelled = (approvals: Map<ApprovalRequestId, PendingApproval>) =>
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
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: DRIVER, threadId }),
        );
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
            // Acquire lease so Remove and prune wait for active sessions
            const installed = yield* installer.acquire(catalogId).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: DRIVER,
                    threadId: input.threadId,
                    detail: cause.detail,
                    cause,
                  }),
              ),
            );

            const spawnInput = toSpawnInput(
              installed,
              {
                nodePath: options.nodePath,
                hostEnvironment: options.hostEnvironment ?? process.env,
                ...(options.extraEnv !== undefined ? { extraEnv: options.extraEnv } : {}),
              },
              path.join,
            );

            if (!spawnInput) {
              return yield* new ProviderAdapterProcessError({
                provider: DRIVER,
                threadId: input.threadId,
                detail: "Could not resolve launch program for registry agent.",
              });
            }

            let launcherPid: number | undefined;
            let stderrTail = "";

            const runtime = yield* AcpSessionRuntime.make({
              spawn: spawnInput,
              cwd,
              authMethodId: "",
              clientInfo: { name: "hbots", version: "1.66.77" },
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
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

            const started = yield* runtime.start().pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(DRIVER, input.threadId, "session/initialize", cause),
              ),
            );

            const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
            const createdAt = yield* nowIso;
            const sessionRecord: ProviderSession = {
              provider: DRIVER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              cwd,
              status: "ready",
              runtimeMode: input.runtimeMode,
              createdAt,
              updatedAt: createdAt,
            };

            const ctx: RegistryAcpSessionContext = {
              threadId: input.threadId,
              scope: sessionScope,
              runtime,
              session: sessionRecord,
              pendingApprovals,
              stopped: false,
            };

            // Consume ACP events and dispatch to pubsub
            const eventFiber = yield* Stream.runForEach(runtime.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  return yield* Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
                }
              }),
            ).pipe(
              Effect.ignore,
              Effect.forkIn(ctx.scope),
            );

            ctx.notificationFiber = eventFiber;
            sessions.set(input.threadId, ctx);
            sessionScopeTransferred = true;

            yield* offerRuntimeEvent({
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: DRIVER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
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

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (
      input: ProviderSendTurnInput,
    ) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: DRIVER,
            threadId: input.threadId,
            turnId,
            payload: {},
          });

          yield* ctx.runtime
            .prompt({
              prompt: [
                {
                  type: "text",
                  text: input.input ?? "",
                },
              ],
            })
            .pipe(
              Effect.flatMap((response) =>
                Effect.gen(function* () {
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: DRIVER,
                    threadId: input.threadId,
                    turnId,
                    payload: { state: "completed", stopReason: response.stopReason },
                  });
                }),
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: DRIVER,
                    threadId: input.threadId,
                    turnId,
                    payload: { state: "failed", errorMessage: String(cause) },
                  });
                }),
              ),
              Effect.forkIn(ctx.scope),
            );

          return { turnId } as ProviderTurnStartResult;
        }),
      );

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
      turnId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.runtime.cancel.pipe(Effect.ignore);
        const resolvedTurnId = turnId ?? ctx.activeTurnId;
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

    const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
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
        const option =
          decision === "decline"
            ? undefined
            : pending.request.options?.find(
                (o) => o.kind.startsWith("allow"),
              ) ?? pending.request.options?.[0];
        const response: EffectAcpSchema.RequestPermissionResponse =
          option === undefined
            ? { outcome: { outcome: "cancelled" } }
            : { outcome: { outcome: "selected", optionId: option.optionId } };
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
        sessionModelSwitch: "unsupported" as const,
        promptlessTurnContinuation: false,
        supportsConversationRollback: false,
      },
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
