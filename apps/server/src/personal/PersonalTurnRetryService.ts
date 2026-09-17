import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ProviderInteractionMode,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import { continuationSystemInstructions } from "./continuationInstructions.ts";
import { isPersonalTaskMessageId } from "./personalThreadTitles.ts";
import {
  decideTurnRetry,
  nextRetryDelayMs,
  PERSONAL_TURN_RETRY_MAX_ATTEMPTS,
  type TurnRetryDecision,
} from "./personalTurnRetryPolicy.ts";

/**
 * Re-runs a bot reply that failed for a transient reason, without re-sending
 * the owner's message.
 *
 * The message is already on the thread; only the reply died. So this never
 * dispatches `thread.turn.start` (which would post a second copy of the
 * message) and instead asks the provider to continue the turn on the session
 * that already holds it, the same call the post-restart continuation makes.
 *
 * It lives on the server on purpose: the phone sleeps and the PWA gets killed,
 * so a client-side timer would simply never fire.
 */
export class PersonalTurnRetry extends Context.Service<
  PersonalTurnRetry,
  {
    /** Subscribes to domain events. Park-aware, like the other personal reactors. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Feeds one orchestration event in (the start() stream uses this). */
    readonly ingestDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
    /** Resolves when every queued event has been handled. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/personal/PersonalTurnRetryService/PersonalTurnRetry") {}

export type PersonalTurnRetryShape = PersonalTurnRetry["Service"];

/** What we know about the turn currently on a thread, and its pending retry. */
interface TrackedThread {
  readonly taskDriven: boolean;
  readonly interactionMode: ProviderInteractionMode;
  attempts: number;
  /** The sleeping/sending retry fiber, if one is in flight. */
  pending: Fiber.Fiber<void, never> | null;
}

/** The session lost its provider binding, so there is nothing to continue on. */
export class PersonalTurnRetryNotRoutable extends Data.TaggedError("PersonalTurnRetryNotRoutable")<{
  readonly threadId: ThreadId;
}> {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The prompt for adapters that cannot continue a turn without one. */
const CONTINUATION_PROMPT = "Continue where you left off.";

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const personalBots = yield* PersonalBotRepository.PersonalBotRepository;
  const crypto = yield* Crypto.Crypto;

  const tracked = new Map<ThreadId, TrackedThread>();

  const logSkip = (threadId: ThreadId, decision: TurnRetryDecision) =>
    decision.kind === "skip"
      ? Effect.logDebug("personal turn retry skipped", { threadId, reason: decision.reason })
      : Effect.void;

  /**
   * Writes the retry marker onto the session. It rides inside the existing
   * `providerRetry` JSON, so the chat can say what is happening and the owner's
   * own error text is never overwritten.
   */
  const markSession = (
    session: OrchestrationSession,
    auto: "pending" | "exhausted",
    attempt: number,
    retryAt: string | null,
  ) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`personal-turn-retry:${yield* crypto.randomUUIDv4}`),
        threadId: session.threadId,
        session: {
          ...session,
          providerRetry: {
            kind: "retrying",
            attempt,
            maxAttempts: PERSONAL_TURN_RETRY_MAX_ATTEMPTS,
            ...(retryAt === null ? {} : { retryAt }),
            auto,
            provider: session.providerName ?? "provider",
            observedAt: now,
          },
          updatedAt: now,
        },
        createdAt: now,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("personal turn retry could not mark the session", {
              threadId: session.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.ignore,
    );

  /** Drops the marker so the chat stops claiming a retry is coming. */
  const clearMarker = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const thread = yield* projections.getThreadShellById(threadId);
      if (Option.isNone(thread)) return;
      const session = thread.value.session;
      if (session == null || session.providerRetry?.auto === undefined) return;
      const now = yield* nowIso;
      const rest: OrchestrationSession = { ...session };
      delete (rest as { providerRetry?: unknown }).providerRetry;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`personal-turn-retry-clear:${yield* crypto.randomUUIDv4}`),
        threadId,
        session: { ...rest, updatedAt: now },
        createdAt: now,
      });
    }).pipe(Effect.ignore);

  /** Stops a sleeping retry. Safe to call for a thread with nothing pending. */
  const cancelPending = (threadId: ThreadId, alsoClearMarker: boolean) =>
    Effect.gen(function* () {
      const entry = tracked.get(threadId);
      const fiber = entry?.pending ?? null;
      if (entry !== undefined) entry.pending = null;
      if (fiber !== null) yield* Fiber.interrupt(fiber);
      if (alsoClearMarker) yield* clearMarker(threadId);
    });

  /** Sends the continuation: the same turn again, with no new user message. */
  const sendContinuation = Effect.fn("PersonalTurnRetry.sendContinuation")(function* (
    threadId: ThreadId,
    session: OrchestrationSession,
    interactionMode: ProviderInteractionMode,
  ) {
    const instanceId = session.providerInstanceId;
    if (instanceId === undefined) {
      return yield* new PersonalTurnRetryNotRoutable({ threadId });
    }
    const capabilities = yield* providerService.getCapabilities(instanceId);
    // Shared with the restart-continuation path so the two cannot drift apart.
    const systemInstructions = yield* continuationSystemInstructions(personalBots, threadId);
    yield* providerService.sendTurn({
      threadId,
      ...(capabilities.promptlessTurnContinuation === true
        ? { continuation: true }
        : { input: CONTINUATION_PROMPT }),
      interactionMode,
      ...(systemInstructions !== undefined ? { systemInstructions } : {}),
    });
  });

  /**
   * One attempt: wait, re-check that the thread still wants it, then continue
   * the turn. A failure here settles the retry rather than leaving the chat
   * promising an attempt that never lands.
   */
  const runAttempt = (threadId: ThreadId, delayMs: number) =>
    Effect.gen(function* () {
      yield* Effect.sleep(delayMs);
      const entry = tracked.get(threadId);
      if (entry === undefined) return;
      const thread = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(thread)) return yield* clearMarker(threadId);
      const shell = thread.value;
      const session = shell.session;
      // Anything that moved the thread on while we slept wins: a new turn, a
      // recovered session, an archived or deleted chat.
      if (
        session == null ||
        session.status !== "error" ||
        session.activeTurnId !== null ||
        shell.archivedAt != null
      ) {
        return yield* clearMarker(threadId);
      }
      yield* sendContinuation(threadId, session, entry.interactionMode);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        // The send itself failed, so no turn will ever fail for us downstream.
        // Count this attempt and settle: schedule the next one, or give up.
        return Effect.logWarning("personal turn retry attempt failed to send", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(afterFailedSend(threadId)));
      }),
      Effect.ignore,
    );

  /** Schedules the attempt after `attempts`, or marks the retry spent. */
  const schedule = (threadId: ThreadId, session: OrchestrationSession) =>
    Effect.gen(function* () {
      const entry = tracked.get(threadId);
      if (entry === undefined) return;
      const delayMs = nextRetryDelayMs(entry.attempts);
      if (delayMs === null) {
        return yield* markSession(session, "exhausted", PERSONAL_TURN_RETRY_MAX_ATTEMPTS, null);
      }
      const attempt = entry.attempts + 1;
      entry.attempts = attempt;
      const retryAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { milliseconds: delayMs }),
      );
      yield* markSession(session, "pending", attempt, retryAt);
      const fiber = yield* Effect.forkDetach(runAttempt(threadId, delayMs));
      const current = tracked.get(threadId);
      if (current === undefined) {
        yield* Fiber.interrupt(fiber);
        return;
      }
      current.pending = fiber;
    });

  /** A send that never reached the provider still counts against the cap. */
  const afterFailedSend = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const thread = yield* projections
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(thread)) return;
      const session = thread.value.session;
      if (session == null) return;
      const entry = tracked.get(threadId);
      if (entry === undefined) return;
      entry.pending = null;
      yield* schedule(threadId, session);
    }).pipe(Effect.ignore);

  /** Whether the thread belongs to a personal bot. A failed lookup means no. */
  const isBotThread = (threadId: ThreadId) =>
    personalBots.getThreadLink({ threadId }).pipe(
      Effect.map(Option.isSome),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const onSessionSet = (threadId: ThreadId, session: OrchestrationSession) =>
    Effect.gen(function* () {
      const decision = decideTurnRetry({ session, tracked: tracked.get(threadId) ?? null });
      if (decision.kind === "skip") return yield* logSkip(threadId, decision);
      if (!(yield* isBotThread(threadId))) return;
      if (decision.kind === "exhausted") {
        return yield* markSession(session, "exhausted", PERSONAL_TURN_RETRY_MAX_ATTEMPTS, null);
      }
      yield* schedule(threadId, session);
    });

  const ingestDomainEvent: PersonalTurnRetryShape["ingestDomainEvent"] = (event) => {
    switch (event.type) {
      case "thread.turn-start-requested": {
        const threadId = event.payload.threadId;
        return cancelPending(threadId, false).pipe(
          Effect.andThen(
            Effect.sync(() => {
              // A fresh turn resets the ledger. Tasks and routines keep their
              // own attempt ledger, so their turns are tracked but never retried.
              tracked.set(threadId, {
                taskDriven: isPersonalTaskMessageId(event.payload.messageId),
                interactionMode: event.payload.interactionMode,
                attempts: 0,
                pending: null,
              });
            }),
          ),
        );
      }
      case "thread.turn-interrupt-requested":
      case "thread.session-stop-requested":
        // The owner asked it to stop. A pending retry is part of what stops.
        return cancelPending(event.payload.threadId, true);
      case "thread.session-set":
        return onSessionSet(event.payload.threadId, event.payload.session).pipe(Effect.ignore);
      default:
        return Effect.void;
    }
  };

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    ingestDomainEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal turn retry failed to handle an event", {
              eventType: event.type,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: PersonalTurnRetryShape["start"] = Effect.fn("PersonalTurnRetry.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, (event) => worker.enqueue(event)));
  });

  return {
    start,
    ingestDomainEvent: (event) => worker.enqueue(event),
    drain: worker.drain,
  } satisfies PersonalTurnRetryShape;
});

export const layer = Layer.effect(PersonalTurnRetry, make);
