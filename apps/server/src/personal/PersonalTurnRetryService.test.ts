import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationSession,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as PersonalEngine from "./engine/PersonalEngine.ts";
import { PersonalEngine as PersonalEngineTag } from "./engine/PersonalEngine.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalTurnRetry from "./PersonalTurnRetryService.ts";
import { PERSONAL_TURN_RETRY_DELAYS_MS } from "./personalTurnRetryPolicy.ts";
import * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

const THREAD = ThreadId.make("thread-1");
const INSTANCE = ProviderInstanceId.make("opencode");
const OWNER_MESSAGE = MessageId.make("msg-from-owner");
const CONTINUATION_PROMPT = "Continue where you left off.";
const CONTINUATION_PREFIX = "personal-continue:";

/** Verbatim from the incident that motivated this: the reply died, not the send. */
const UPSTREAM_FAILURE =
  "Error from provider (Console): Upstream request failed: Endpoint is unavailable.";
const USAGE_LIMIT_FAILURE = "You've hit your session limit · resets 10:10pm (Europe/London)";

const [FIRST_DELAY_MS, SECOND_DELAY_MS] = PERSONAL_TURN_RETRY_DELAYS_MS;

interface Harness {
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly continuations: Array<PersonalEngine.PersonalContinueTurnInput>;
  session: OrchestrationSession | null;
  /** The thread is linked to a live personal bot. */
  isBotThread: boolean;
  /** The next continueTurn call throws instead of starting a turn. */
  failSend: boolean;
  /** A task attempt drives (or just drove) the thread's turn. */
  taskOwnsTurn: boolean;
  /** The bot's model selection as it is now (edits land here). */
  botModelSelection: ModelSelection;
  sequence: number;
  /** The adapter can continue a turn without a prompt. Kept for the case name. */
  promptless: boolean;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  continuations: [],
  session: null,
  isBotThread: true,
  failSend: false,
  taskOwnsTurn: false,
  botModelSelection: { instanceId: INSTANCE, model: "big-pickle" },
  sequence: 0,
  promptless: true,
});

const makeSession = (input: {
  readonly status: OrchestrationSession["status"];
  readonly lastError?: string | null;
  readonly activeTurnId?: TurnId | null;
  readonly providerRetry?: OrchestrationSession["providerRetry"];
}): OrchestrationSession => ({
  threadId: THREAD,
  status: input.status,
  providerName: "opencode",
  providerInstanceId: INSTANCE,
  runtimeMode: "full-access",
  activeTurnId: input.activeTurnId ?? null,
  lastError: input.lastError ?? null,
  ...(input.providerRetry !== undefined ? { providerRetry: input.providerRetry } : {}),
  updatedAt: "2026-09-17T10:00:00.000Z",
});

const sessionView = (session: OrchestrationSession): PersonalEngine.PersonalSessionView => ({
  threadId: session.threadId,
  status:
    session.status === "ready"
      ? "waiting"
      : (session.status as PersonalEngine.PersonalThreadStatus),
  activeTurnId: session.activeTurnId,
  lastError: session.lastError,
  providerInstanceId: session.providerInstanceId ?? null,
  providerName: session.providerName,
  providerRetry:
    session.providerRetry === undefined
      ? null
      : {
          kind: session.providerRetry.kind,
          provider: session.providerRetry.provider,
          observedAt: session.providerRetry.observedAt,
          ...(session.providerRetry.retryAt === undefined
            ? {}
            : { retryAt: session.providerRetry.retryAt }),
          ...(session.providerRetry.attempt === undefined
            ? {}
            : { attempt: session.providerRetry.attempt }),
          ...(session.providerRetry.maxAttempts === undefined
            ? {}
            : { maxAttempts: session.providerRetry.maxAttempts }),
          ...(session.providerRetry.reason === undefined
            ? {}
            : { reason: session.providerRetry.reason }),
          ...(session.providerRetry.auto === undefined ? {} : { auto: session.providerRetry.auto }),
        },
  updatedAt: session.updatedAt,
});

const applyRetryMark = (
  session: OrchestrationSession,
  retry: PersonalEngine.PersonalProviderRetryMark | null,
): OrchestrationSession => {
  if (retry === null) {
    const { providerRetry: _dropped, ...rest } = session;
    return rest;
  }
  return {
    ...session,
    providerRetry: {
      kind: "retrying",
      auto: retry.auto,
      attempt: retry.attempt,
      maxAttempts: retry.maxAttempts,
      ...(retry.retryAt === null ? {} : { retryAt: retry.retryAt }),
      provider: session.providerName ?? "provider",
      observedAt: "2026-09-17T10:00:00.000Z",
    },
  };
};

/** A test-local PersonalEngine: only the calls this service makes. */
const engineDouble = (harness: Harness): PersonalEngine.PersonalEngineShape => {
  const shape = {
    getThread: (threadId: ThreadId) =>
      Effect.sync(() =>
        threadId === THREAD && harness.session !== null
          ? Option.some({
              id: THREAD,
              title: "Chat",
              projectId: "project",
              modelSelection: { instanceId: INSTANCE, model: "big-pickle" },
              runtimeMode: "full-access",
              interactionMode: "default",
              archivedAt: null,
              session: harness.session,
            } as unknown as PersonalEngine.PersonalThreadView)
          : Option.none(),
      ),
    setProviderRetry: (input: PersonalEngine.PersonalSetProviderRetryInput) =>
      Effect.sync(() => {
        if (harness.session === null) return;
        harness.session = applyRetryMark(harness.session, input.retry);
      }),
    continueTurn: (input: PersonalEngine.PersonalContinueTurnInput) =>
      Effect.suspend(() => {
        if (harness.failSend) return Effect.die(new Error("provider is still down"));
        harness.continuations.push(input);
        harness.sequence += 1;
        const messageId = MessageId.make(`${CONTINUATION_PREFIX}${harness.sequence}`);
        // The v2 engine continues the turn with a system message, never by
        // re-sending the owner's message.
        harness.dispatched.push({
          type: "message.dispatch",
          commandId: CommandId.make(`personal-engine:continue:${messageId}`),
          threadId: input.threadId,
          messageId,
          text: CONTINUATION_PROMPT,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        } as OrchestrationV2ServerCommand);
        return Effect.void;
      }),
    events: Stream.empty as Stream.Stream<PersonalEngine.PersonalThreadEvent>,
  };
  return shape as unknown as PersonalEngine.PersonalEngineShape;
};

const makeLayer = (harness: Harness) =>
  PersonalTurnRetry.layer.pipe(
    Layer.provideMerge(Layer.succeed(PersonalEngineTag, engineDouble(harness))),
    Layer.provideMerge(
      Layer.succeed(PersonalBotRepository.PersonalBotRepository, {
        getThreadLink: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.sync(() =>
            harness.isBotThread && threadId === THREAD
              ? Option.some({ threadId, botId: PersonalBotId.make("bot-assistant") })
              : Option.none(),
          ),
        getBotById: ({ botId }: { readonly botId: PersonalBotId }) =>
          Effect.sync(() => Option.some({ botId, modelSelection: harness.botModelSelection })),
        getInstructionsForThread: () =>
          Effect.succeed(
            Option.some({
              botId: PersonalBotId.make("bot-assistant"),
              name: "Assistant",
              title: "",
              instructions: "Be brief.",
            }),
          ),
      } as unknown as PersonalBotRepository.PersonalBotRepository["Service"]),
    ),
    Layer.provideMerge(
      Layer.mock(PersonalTaskService.PersonalTaskService)({
        ownsThreadTurn: () => Effect.sync(() => harness.taskOwnsTurn),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const turnStartEvent = (
  _harness: Harness,
  messageId: MessageId,
): PersonalEngine.PersonalThreadEvent => ({
  _tag: "TurnStartRequested",
  threadId: THREAD,
  messageId,
  interactionMode: "default",
});

const interruptEvent = (_harness: Harness): PersonalEngine.PersonalThreadEvent => ({
  _tag: "TurnStopRequested",
  threadId: THREAD,
});

const sessionEvent = (
  harness: Harness,
  session: OrchestrationSession,
): PersonalEngine.PersonalThreadEvent => {
  harness.session = session;
  const view = sessionView(session);
  return { _tag: "StatusChanged", threadId: THREAD, status: view.status, session: view };
};

/** Feeds one v2 personal event straight into the reactor. */
const ingestAll = (
  service: PersonalTurnRetry.PersonalTurnRetryShape,
  _harness: Harness,
  event: PersonalEngine.PersonalThreadEvent,
) => service.ingestDomainEvent(event);

/** The continuation commands the engine actually dispatched. */
const continuationCommands = (harness: Harness) =>
  harness.dispatched.filter(
    (command) =>
      command.type === "message.dispatch" && command.messageId.startsWith(CONTINUATION_PREFIX),
  );

/** Every command that would put another message on the thread. */
const messageCreatingCommands = (harness: Harness) =>
  harness.dispatched.filter(
    (command) =>
      command.type === "message.dispatch" && !command.messageId.startsWith(CONTINUATION_PREFIX),
  );

const autoMarker = (harness: Harness) => harness.session?.providerRetry;

/** Feeds the owner's turn, then the transient failure that ended it. */
const failOwnerTurn = (
  retry: PersonalTurnRetry.PersonalTurnRetryShape,
  harness: Harness,
  lastError: string = UPSTREAM_FAILURE,
) =>
  Effect.gen(function* () {
    yield* ingestAll(retry, harness, turnStartEvent(harness, OWNER_MESSAGE));
    yield* retry.drain;
    yield* ingestAll(
      retry,
      harness,
      sessionEvent(harness, makeSession({ status: "error", lastError })),
    );
    yield* retry.drain;
  });

/** The provider accepted the continuation and then failed the turn again. */
const failRetriedTurn = (retry: PersonalTurnRetry.PersonalTurnRetryShape, harness: Harness) =>
  Effect.gen(function* () {
    // The running session clears the marker, exactly as turn.started does.
    yield* ingestAll(
      retry,
      harness,
      sessionEvent(
        harness,
        makeSession({ status: "running", activeTurnId: TurnId.make("turn-retry") }),
      ),
    );
    yield* retry.drain;
    yield* ingestAll(
      retry,
      harness,
      sessionEvent(harness, makeSession({ status: "error", lastError: UPSTREAM_FAILURE })),
    );
    yield* retry.drain;
  });

it.effect("retries a transient reply failure and never re-sends the message", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);

        // The chat is told before anything is spent.
        expect(autoMarker(harness)).toMatchObject({ auto: "pending", attempt: 1, maxAttempts: 2 });
        expect(continuationCommands(harness)).toHaveLength(0);

        yield* TestClock.adjust(FIRST_DELAY_MS!);
        expect(continuationCommands(harness)).toHaveLength(1);
        // A continuation of the turn already on the thread: the engine posts
        // its own system message and the owner's message is never sent again.
        expect(harness.continuations[0]).toMatchObject({
          threadId: THREAD,
          interactionMode: "default",
        });
        expect(messageCreatingCommands(harness)).toHaveLength(0);
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("sends a short prompt to an adapter that cannot continue without one", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.promptless = false;
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);
        yield* TestClock.adjust(FIRST_DELAY_MS!);
        const [continuation] = continuationCommands(harness);
        expect(continuation).toMatchObject({
          type: "message.dispatch",
          threadId: THREAD,
          text: CONTINUATION_PROMPT,
        });
        expect(messageCreatingCommands(harness)).toHaveLength(0);
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("the retried reply carries the bot's current model selection and effort", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);
        // Edited while the retry waits: the continuation uses the new value.
        harness.botModelSelection = {
          instanceId: INSTANCE,
          model: "big-pickle",
          options: [{ id: "reasoningEffort", value: "max" }],
        };
        yield* TestClock.adjust(FIRST_DELAY_MS!);
        expect(continuationCommands(harness)).toHaveLength(1);
        const firstContinuation = continuationCommands(harness)[0]!;
        expect(
          firstContinuation.type === "message.dispatch"
            ? firstContinuation.modelSelection
            : undefined,
        ).toEqual(harness.botModelSelection);
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("does not retry a usage limit, however transient the wait looks", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness, USAGE_LIMIT_FAILURE);

        expect(autoMarker(harness)).toBeUndefined();
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        // Not one billed run: the provider has already said no.
        expect(continuationCommands(harness)).toHaveLength(0);
        expect(messageCreatingCommands(harness)).toHaveLength(0);
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("stops after the cap and says it gave up", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);

        yield* TestClock.adjust(FIRST_DELAY_MS!);
        expect(continuationCommands(harness)).toHaveLength(1);
        yield* failRetriedTurn(retry, harness);
        expect(autoMarker(harness)).toMatchObject({ auto: "pending", attempt: 2 });

        yield* TestClock.adjust(SECOND_DELAY_MS!);
        expect(continuationCommands(harness)).toHaveLength(2);
        yield* failRetriedTurn(retry, harness);

        // Third failure: the attempts are spent and the chat must say so
        // rather than leave a hopeful "trying again" up forever.
        expect(autoMarker(harness)).toMatchObject({ auto: "exhausted", maxAttempts: 2 });
        // The provider's own reason survives for the "Details" toggle.
        expect(harness.session?.lastError).toBe(UPSTREAM_FAILURE);

        yield* TestClock.adjust(SECOND_DELAY_MS! * 10);
        expect(continuationCommands(harness)).toHaveLength(2);
        expect(messageCreatingCommands(harness)).toHaveLength(0);
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("drops a pending retry when the owner presses Stop", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);
        expect(autoMarker(harness)).toMatchObject({ auto: "pending" });

        yield* ingestAll(retry, harness, interruptEvent(harness));
        yield* retry.drain;

        expect(autoMarker(harness)).toBeUndefined();
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(continuationCommands(harness)).toHaveLength(0);
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("leaves a task or routine turn to its own attempt ledger", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        // Task attempts use a deterministic `personal-task-` message id.
        yield* failOwnerTurnWithMessage(retry, harness, MessageId.make("personal-task-abc-1"));
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(continuationCommands(harness)).toHaveLength(0);
        expect(autoMarker(harness)).toBeUndefined();
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("leaves a group member's turn to its round", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        // The round skips or re-queues the member itself; a continuation from
        // here would be a second speaker the round does not know about.
        yield* failOwnerTurnWithMessage(
          retry,
          harness,
          MessageId.make("personal-group-round-1-brief-2"),
        );
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(continuationCommands(harness)).toHaveLength(0);
        expect(autoMarker(harness)).toBeUndefined();
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("leaves an owner turn a task adopted to the task's own retry", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.taskOwnsTurn = true;
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(continuationCommands(harness)).toHaveLength(0);
        expect(autoMarker(harness)).toBeUndefined();
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("does not re-arm a retry from the session its own Stop wrote back", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);
        yield* ingestAll(retry, harness, interruptEvent(harness));
        yield* retry.drain;
        // The engine echoes the marker-less error session back as an event.
        const cleared = harness.session;
        expect(cleared?.providerRetry?.auto).toBeUndefined();
        yield* ingestAll(retry, harness, sessionEvent(harness, cleared!));
        yield* retry.drain;
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(continuationCommands(harness)).toHaveLength(0);
        expect(autoMarker(harness)).toBeUndefined();
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("ignores a thread that is not a personal bot chat", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.isBotThread = false;
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(continuationCommands(harness)).toHaveLength(0);
        expect(autoMarker(harness)).toBeUndefined();
      }),
      makeLayer(harness),
    );
  }),
);

it.effect("counts a continuation that never reached the provider as a spent attempt", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.failSend = true;
    yield* Effect.provide(
      Effect.gen(function* () {
        const retry = yield* PersonalTurnRetry.PersonalTurnRetry;
        yield* failOwnerTurn(retry, harness);

        yield* TestClock.adjust(FIRST_DELAY_MS!);
        // No turn will ever fail downstream for a send that threw, so the
        // retry has to settle itself instead of promising forever.
        expect(autoMarker(harness)).toMatchObject({ auto: "pending", attempt: 2 });
        yield* TestClock.adjust(SECOND_DELAY_MS!);
        expect(autoMarker(harness)).toMatchObject({ auto: "exhausted" });
        expect(continuationCommands(harness)).toHaveLength(0);
      }),
      makeLayer(harness),
    );
  }),
);

function failOwnerTurnWithMessage(
  retry: PersonalTurnRetry.PersonalTurnRetryShape,
  harness: Harness,
  messageId: MessageId,
) {
  return Effect.gen(function* () {
    yield* ingestAll(retry, harness, turnStartEvent(harness, messageId));
    yield* retry.drain;
    yield* ingestAll(
      retry,
      harness,
      sessionEvent(harness, makeSession({ status: "error", lastError: UPSTREAM_FAILURE })),
    );
    yield* retry.drain;
  });
}
