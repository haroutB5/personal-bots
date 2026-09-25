import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalTurnRetry from "./PersonalTurnRetryService.ts";
import { PERSONAL_TURN_RETRY_DELAYS_MS } from "./personalTurnRetryPolicy.ts";
import * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

const THREAD = ThreadId.make("thread-1");
const INSTANCE = ProviderInstanceId.make("opencode");
const OWNER_MESSAGE = MessageId.make("msg-from-owner");

/** Verbatim from the incident that motivated this: the reply died, not the send. */
const UPSTREAM_FAILURE =
  "Error from provider (Console): Upstream request failed: Endpoint is unavailable.";
const USAGE_LIMIT_FAILURE = "You've hit your session limit · resets 10:10pm (Europe/London)";

const [FIRST_DELAY_MS, SECOND_DELAY_MS] = PERSONAL_TURN_RETRY_DELAYS_MS;

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly sends: Array<ProviderSendTurnInput>;
  session: OrchestrationSession | null;
  /** The thread is linked to a live personal bot. */
  isBotThread: boolean;
  /** The next sendTurn call throws instead of starting a turn. */
  failSend: boolean;
  /** A task attempt drives (or just drove) the thread's turn. */
  taskOwnsTurn: boolean;
  /** The bot's model selection as it is now (edits land here). */
  botModelSelection: ModelSelection;
  sequence: number;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  sends: [],
  session: null,
  isBotThread: true,
  failSend: false,
  taskOwnsTurn: false,
  botModelSelection: { instanceId: INSTANCE, model: "big-pickle" },
  sequence: 0,
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

const makeLayer = (harness: Harness) =>
  PersonalTurnRetry.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            // The projection is the reactor's own read-back, so a session the
            // reactor writes must be what it reads next.
            if (command.type === "thread.session.set") harness.session = command.session;
            return { sequence: harness.dispatched.length };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() =>
            threadId === THREAD && harness.session !== null
              ? Option.some({
                  id: THREAD,
                  session: harness.session,
                  archivedAt: null,
                  modelSelection: { instanceId: INSTANCE, model: "big-pickle" },
                })
              : Option.none(),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        getCapabilities: () => Effect.succeed({ promptlessTurnContinuation: true }),
        sendTurn: (input: ProviderSendTurnInput) =>
          Effect.suspend(() => {
            if (harness.failSend) {
              return Effect.die(new Error("provider is still down"));
            }
            harness.sends.push(input);
            return Effect.succeed({ threadId: THREAD, turnId: TurnId.make("turn-retry") });
          }),
      } as unknown as ProviderService["Service"]),
    ),
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

const baseEvent = (harness: Harness) => {
  harness.sequence += 1;
  const id = `evt-${harness.sequence}`;
  return {
    sequence: harness.sequence,
    eventId: EventId.make(id),
    aggregateKind: "thread" as const,
    aggregateId: THREAD,
    occurredAt: "2026-09-17T10:00:00.000Z",
    commandId: CommandId.make(`cmd-${id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${id}`),
    metadata: {},
  };
};

const turnStartEvent = (harness: Harness, messageId: MessageId): OrchestrationEvent =>
  ({
    ...baseEvent(harness),
    type: "thread.turn-start-requested",
    payload: {
      threadId: THREAD,
      messageId,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-09-17T10:00:00.000Z",
    },
  }) as OrchestrationEvent;

const interruptEvent = (harness: Harness): OrchestrationEvent =>
  ({
    ...baseEvent(harness),
    type: "thread.turn-interrupt-requested",
    payload: { threadId: THREAD, createdAt: "2026-09-17T10:00:00.000Z" },
  }) as OrchestrationEvent;

const sessionEvent = (harness: Harness, session: OrchestrationSession): OrchestrationEvent => {
  harness.session = session;
  return {
    ...baseEvent(harness),
    type: "thread.session-set",
    payload: { threadId: THREAD, session },
  } as OrchestrationEvent;
};

/** Every command that would put a second copy of the message on the thread. */
const messageCreatingCommands = (harness: Harness) =>
  harness.dispatched.filter(
    (command) =>
      command.type === "thread.turn.start" || command.type === "thread.message.user.append",
  );

const autoMarker = (harness: Harness) => harness.session?.providerRetry;

/** Feeds the owner's turn, then the transient failure that ended it. */
const failOwnerTurn = (
  retry: PersonalTurnRetry.PersonalTurnRetryShape,
  harness: Harness,
  lastError: string = UPSTREAM_FAILURE,
) =>
  Effect.gen(function* () {
    yield* retry.ingestDomainEvent(turnStartEvent(harness, OWNER_MESSAGE));
    yield* retry.drain;
    yield* retry.ingestDomainEvent(
      sessionEvent(harness, makeSession({ status: "error", lastError })),
    );
    yield* retry.drain;
  });

/** The provider accepted the continuation and then failed the turn again. */
const failRetriedTurn = (retry: PersonalTurnRetry.PersonalTurnRetryShape, harness: Harness) =>
  Effect.gen(function* () {
    // turn.started clears the marker, exactly as the runtime ingestion does.
    yield* retry.ingestDomainEvent(
      sessionEvent(
        harness,
        makeSession({ status: "running", activeTurnId: TurnId.make("turn-retry") }),
      ),
    );
    yield* retry.drain;
    yield* retry.ingestDomainEvent(
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
        expect(harness.sends).toHaveLength(0);

        yield* TestClock.adjust(FIRST_DELAY_MS!);
        expect(harness.sends).toHaveLength(1);
        // Continuation of the turn already on the thread: no message, no id.
        expect(harness.sends[0]).toMatchObject({ threadId: THREAD, continuation: true });
        expect(harness.sends[0]).not.toHaveProperty("input");
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
        expect(harness.sends).toHaveLength(1);
        expect(harness.sends[0]!.modelSelection).toEqual(harness.botModelSelection);
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
        expect(harness.sends).toHaveLength(0);
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
        expect(harness.sends).toHaveLength(1);
        yield* failRetriedTurn(retry, harness);
        expect(autoMarker(harness)).toMatchObject({ auto: "pending", attempt: 2 });

        yield* TestClock.adjust(SECOND_DELAY_MS!);
        expect(harness.sends).toHaveLength(2);
        yield* failRetriedTurn(retry, harness);

        // Third failure: the attempts are spent and the chat must say so
        // rather than leave a hopeful "trying again" up forever.
        expect(autoMarker(harness)).toMatchObject({ auto: "exhausted", maxAttempts: 2 });
        // The provider's own reason survives for the "Details" toggle.
        expect(harness.session?.lastError).toBe(UPSTREAM_FAILURE);

        yield* TestClock.adjust(SECOND_DELAY_MS! * 10);
        expect(harness.sends).toHaveLength(2);
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

        yield* retry.ingestDomainEvent(interruptEvent(harness));
        yield* retry.drain;

        expect(autoMarker(harness)).toBeUndefined();
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(harness.sends).toHaveLength(0);
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
        expect(harness.sends).toHaveLength(0);
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
        expect(harness.sends).toHaveLength(0);
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
        expect(harness.sends).toHaveLength(0);
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
        yield* retry.ingestDomainEvent(interruptEvent(harness));
        yield* retry.drain;
        // The engine echoes the marker-less error session back as an event.
        const cleared = harness.session;
        expect(cleared?.providerRetry?.auto).toBeUndefined();
        yield* retry.ingestDomainEvent(sessionEvent(harness, cleared!));
        yield* retry.drain;
        yield* TestClock.adjust(SECOND_DELAY_MS! * 4);
        expect(harness.sends).toHaveLength(0);
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
        expect(harness.sends).toHaveLength(0);
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
        expect(harness.sends).toHaveLength(0);
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
    yield* retry.ingestDomainEvent(turnStartEvent(harness, messageId));
    yield* retry.drain;
    yield* retry.ingestDomainEvent(
      sessionEvent(harness, makeSession({ status: "error", lastError: UPSTREAM_FAILURE })),
    );
    yield* retry.drain;
  });
}
