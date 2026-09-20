import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  OrchestrationMessageContext,
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PersonalBotId,
  PersonalGroupId,
  PersonalGroupRoundId,
  PersonalGroupVoteId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type PersonalGroupMessageMarker,
} from "@t3tools/contracts";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import * as PersonalGroupService from "./PersonalGroupService.ts";

/**
 * The orchestration side, stood in for. Commands are recorded AND applied to a
 * tiny projection, because the group service reads back what it wrote: the
 * catch-up brief is built from the text of the messages it relayed into the
 * group thread, so a harness that only records would test half the loop.
 *
 * No timers anywhere: every wait is a dispatcher drain.
 */
interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly sessions: Map<string, OrchestrationSession>;
  readonly messages: Map<string, Array<ProjectionThreadMessage>>;
  sequence: number;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  sessions: new Map(),
  messages: new Map(),
  sequence: 0,
});

type MutableMessage = {
  -readonly [K in keyof ProjectionThreadMessage]: ProjectionThreadMessage[K];
};

const listOf = (harness: Harness, threadId: string): Array<MutableMessage> => {
  const existing = harness.messages.get(threadId);
  if (existing !== undefined) {
    return existing as Array<MutableMessage>;
  }
  const created: Array<ProjectionThreadMessage> = [];
  harness.messages.set(threadId, created);
  return created as Array<MutableMessage>;
};

/** The projection rules this service depends on, and only those. */
const applyToProjection = (harness: Harness, command: OrchestrationCommand) => {
  switch (command.type) {
    case "thread.message.user.append": {
      listOf(harness, command.threadId).push({
        messageId: command.message.messageId,
        threadId: command.threadId,
        turnId: null,
        role: "user",
        text: command.message.text,
        isStreaming: false,
        ...(command.message.context === undefined ? {} : { context: command.message.context }),
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      } as ProjectionThreadMessage);
      return;
    }
    case "thread.turn.start": {
      listOf(harness, command.threadId).push({
        messageId: command.message.messageId,
        threadId: command.threadId,
        turnId: null,
        role: "user",
        text: command.message.text,
        isStreaming: false,
        ...(command.message.context === undefined ? {} : { context: command.message.context }),
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      } as ProjectionThreadMessage);
      return;
    }
    case "thread.message.assistant.delta": {
      const list = listOf(harness, command.threadId);
      const existing = list.find((message) => message.messageId === command.messageId);
      if (existing === undefined) {
        list.push({
          messageId: command.messageId,
          threadId: command.threadId,
          turnId: null,
          role: "assistant",
          text: command.delta,
          isStreaming: true,
          ...(command.context === undefined ? {} : { context: command.context }),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        } as ProjectionThreadMessage);
        return;
      }
      // Exactly the projection's rule: the context set by the first delta is
      // preserved across later deltas and the completing upsert.
      existing.text += command.delta;
      existing.updatedAt = command.createdAt;
      return;
    }
    case "thread.message.assistant.complete": {
      const existing = listOf(harness, command.threadId).find(
        (message) => message.messageId === command.messageId,
      );
      if (existing !== undefined) {
        existing.isStreaming = false;
      }
      return;
    }
    default:
      return;
  }
};

const optionOf = <A>(value: A | undefined): Option.Option<A> =>
  value === undefined ? Option.none() : Option.some(value);

const makeLayer = (harness: Harness, dbPath?: string) =>
  PersonalGroupService.layer.pipe(
    Layer.provideMerge(PersonalGroupRepository.layer),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(
      dbPath === undefined ? SqlitePersistenceMemory : makeSqlitePersistenceLive(dbPath),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            applyToProjection(harness, command);
            return { sequence: harness.dispatched.length };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const session = harness.sessions.get(threadId);
            return session === undefined ? Option.none() : Option.some({ id: threadId, session });
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: ({ threadId }: { readonly threadId: ThreadId }) =>
          Effect.sync(() => harness.messages.get(threadId) ?? []),
        getByMessageId: ({ messageId }: { readonly messageId: MessageId }) =>
          Effect.sync(() => {
            for (const list of harness.messages.values()) {
              const found = list.find((message) => message.messageId === messageId);
              if (found !== undefined) return Option.some(found);
            }
            return Option.none();
          }),
        getLatestAssistantMessageForTurn: ({
          threadId,
          turnId,
        }: {
          readonly threadId: ThreadId;
          readonly turnId: TurnId;
        }) =>
          Effect.sync(() =>
            optionOf(
              (harness.messages.get(threadId) ?? []).findLast(
                (message) => message.role === "assistant" && message.turnId === turnId,
              ),
            ),
          ),
        getLatestAssistantMessageAfter: ({
          threadId,
          afterMessageId,
        }: {
          readonly threadId: ThreadId;
          readonly afterCreatedAt: string;
          readonly afterMessageId: MessageId;
        }) =>
          Effect.sync(() => {
            const list = harness.messages.get(threadId) ?? [];
            const anchor = list.findIndex((message) => message.messageId === afterMessageId);
            return optionOf(
              list.slice(anchor + 1).findLast((message) => message.role === "assistant"),
            );
          }),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-groups-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOTS = {
  assistant: "Assistant",
  dev: "Dev",
  planner: "Planner",
  researcher: "Researcher",
  writer: "Writer",
  tester: "Tester",
  extra: "Extra",
} as const;
type BotKey = keyof typeof BOTS;

const botId = (key: BotKey) => PersonalBotId.make(`bot-${key}`);

const seedBots = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  for (const key of Object.keys(BOTS) as ReadonlyArray<BotKey>) {
    yield* bots.create({
      botId: botId(key),
      name: BOTS[key],
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
    });
  }
});

const GROUP = PersonalGroupId.make("group-1");
const GROUP_THREAD = ThreadId.make("thread-group-1");

const makeGroup = (members: ReadonlyArray<BotKey>, maxBotTurns?: number) =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    return yield* service.create({
      groupId: GROUP,
      threadId: GROUP_THREAD,
      name: "Launch crew",
      botIds: members.map(botId),
      ...(maxBotTurns === undefined ? {} : { maxBotTurns }),
    });
  });

const send = (text: string, id = `msg-${text.slice(0, 8)}`) =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    const round = yield* service.sendMessage({
      groupId: GROUP,
      messageId: MessageId.make(id),
      text,
    });
    yield* service.drain;
    return round;
  });

/** The group's newest round whatever its status, read straight from the row. */
const currentRound = Effect.gen(function* () {
  const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
  const round = yield* repository.latestRoundForGroup(GROUP);
  if (Option.isNone(round)) {
    throw new Error("the group has no round");
  }
  return round.value;
});

const makeSession = (input: {
  readonly threadId: ThreadId;
  readonly status: OrchestrationSession["status"];
  readonly activeTurnId: TurnId | null;
  readonly lastError?: string;
  readonly providerRetry?: OrchestrationSession["providerRetry"];
  readonly updatedAt: string;
}): OrchestrationSession => ({
  threadId: input.threadId,
  status: input.status,
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: input.activeTurnId,
  lastError: input.lastError ?? null,
  ...(input.providerRetry !== undefined ? { providerRetry: input.providerRetry } : {}),
  updatedAt: input.updatedAt,
});

const eventBase = (harness: Harness, aggregateId: string, occurredAt: string) => {
  harness.sequence += 1;
  const id = `evt-${String(harness.sequence)}`;
  return {
    sequence: harness.sequence,
    eventId: EventId.make(id),
    aggregateKind: "thread" as const,
    aggregateId,
    occurredAt,
    commandId: CommandId.make(`cmd-${id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${id}`),
    metadata: {},
  };
};

const setSession = (harness: Harness, session: OrchestrationSession) =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    harness.sessions.set(session.threadId, session);
    yield* service.ingestDomainEvent({
      ...eventBase(harness, session.threadId, session.updatedAt),
      type: "thread.session-set",
      payload: { threadId: session.threadId, session },
    } as OrchestrationEvent);
    yield* service.drain;
  });

const messageSentEvent = (
  harness: Harness,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly role: "assistant" | "user";
    readonly text: string;
    readonly streaming: boolean;
    readonly turnId: TurnId | null;
    readonly at: string;
  },
): OrchestrationEvent =>
  ({
    ...eventBase(harness, input.threadId, input.at),
    type: "thread.message-sent",
    payload: {
      threadId: input.threadId,
      messageId: input.messageId,
      role: input.role,
      text: input.text,
      attachments: [],
      turnId: input.turnId,
      streaming: input.streaming,
      createdAt: input.at,
      updatedAt: input.at,
    },
  }) as unknown as OrchestrationEvent;

const beginTurn = (harness: Harness, threadId: ThreadId) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const turnId = TurnId.make(`turn-${threadId}-${String(harness.sequence + 1)}`);
    yield* setSession(
      harness,
      makeSession({ threadId, status: "running", activeTurnId: turnId, updatedAt: now }),
    );
    return turnId;
  });

/** One streamed chunk of a member's reply, as the provider would send it. */
const streamChunk = (harness: Harness, threadId: ThreadId, turnId: TurnId, chunk: string) =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* service.ingestDomainEvent(
      messageSentEvent(harness, {
        threadId,
        messageId: MessageId.make(`member-${turnId}`),
        role: "assistant",
        text: chunk,
        streaming: true,
        turnId,
        at: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    yield* service.drain;
  });

const endTurn = (
  harness: Harness,
  threadId: ThreadId,
  turnId: TurnId,
  finalText: string,
  end: {
    readonly status?: OrchestrationSession["status"];
    readonly lastError?: string;
    readonly providerRetry?: OrchestrationSession["providerRetry"];
  } = {},
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    listOf(harness, threadId).push({
      messageId: MessageId.make(`member-${turnId}`),
      threadId,
      turnId,
      role: "assistant",
      text: finalText,
      isStreaming: false,
      createdAt: now,
      updatedAt: now,
    } as ProjectionThreadMessage);
    yield* setSession(
      harness,
      makeSession({
        threadId,
        status: end.status ?? "ready",
        activeTurnId: null,
        ...(end.lastError === undefined ? {} : { lastError: end.lastError }),
        ...(end.providerRetry === undefined ? {} : { providerRetry: end.providerRetry }),
        updatedAt: now,
      }),
    );
  });

/** The member currently holding the slot answers with `reply`. */
const speak = (
  harness: Harness,
  reply: string,
  options: { readonly chunks?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const round = yield* currentRound;
    const threadId = round.activeThreadId;
    if (threadId === null) {
      throw new Error(`round ${round.roundId} has nobody speaking`);
    }
    const speaker = round.activeBotId;
    const turnId = yield* beginTurn(harness, threadId);
    for (const chunk of options.chunks ?? []) {
      yield* streamChunk(harness, threadId, turnId, chunk);
    }
    yield* endTurn(harness, threadId, turnId, reply);
    return { threadId, turnId, speaker };
  });

const groupTranscript = (harness: Harness) => harness.messages.get(GROUP_THREAD) ?? [];

const markerOf = (message: ProjectionThreadMessage | undefined) => {
  const record = message?.context?.records[0];
  return record !== undefined && "payload" in record
    ? (record.payload as PersonalGroupMessageMarker)
    : undefined;
};

const turnStarts = (harness: Harness) =>
  harness.dispatched.flatMap((command) => (command.type === "thread.turn.start" ? [command] : []));

const interrupts = (harness: Harness) =>
  harness.dispatched.flatMap((command) =>
    command.type === "thread.turn.interrupt" ? [command] : [],
  );

// ---------------------------------------------------------------------------
// 1. create is idempotent, and the group thread is not a bot thread
// ---------------------------------------------------------------------------

it.effect("create is idempotent on the client-minted id and makes one shared thread", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    const first = yield* makeGroup(["assistant", "dev"]);
    const second = yield* makeGroup(["assistant", "dev"]);

    expect(second.groupId).toBe(first.groupId);
    expect(first.members.map((member) => member.botId)).toEqual([botId("assistant"), botId("dev")]);
    expect((yield* service.list()).groups.length).toBe(1);

    const creates = harness.dispatched.filter((command) => command.type === "thread.create");
    expect(creates.length).toBe(1);
    expect(creates[0]!.threadId).toBe(GROUP_THREAD);
    // The shared thread gets no personal_bot_threads row: no persona is
    // injected into it and no provider ever runs on it.
    const bots = yield* PersonalBotService.PersonalBotService;
    expect((yield* bots.list()).threads.map((link) => link.threadId)).not.toContain(GROUP_THREAD);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 2. the member cap
// ---------------------------------------------------------------------------

it.effect("a seventh member is refused, at create and at addMember", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    const tooMany = yield* Effect.flip(
      makeGroup(["assistant", "dev", "planner", "researcher", "writer", "tester", "extra"]),
    );
    expect(tooMany.message).toContain("at most 6 members");
    // Nothing was created: the refusal happens before any thread is made.
    expect((yield* service.list()).groups).toEqual([]);

    yield* makeGroup(["assistant", "dev", "planner", "researcher", "writer", "tester"]);
    const full = yield* Effect.flip(service.addMember({ groupId: GROUP, botId: botId("extra") }));
    expect(full.message).toContain("at most 6 members");
    expect((yield* service.list()).groups[0]!.members.length).toBe(6);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 3. default-speaker routing
// ---------------------------------------------------------------------------

it.effect("a broadcast gathers contributions then delivers exactly one final verdict", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"]);
    const round = yield* send("what do we do about the release?", "msg-release");
    expect(groupTranscript(harness).find((message) => message.role === "user")?.text).toBe(
      "what do we do about the release?",
    );

    const order = [botId("assistant"), botId("dev"), botId("planner")];
    expect(round.queue).toEqual(order);
    const live = yield* currentRound;
    expect(live.activeBotId).toBe(botId("assistant"));
    expect(turnStarts(harness).length).toBe(1);
    yield* speak(harness, "I suggest shipping Friday.");
    expect((yield* currentRound).activeBotId).toBe(botId("dev"));
    expect(turnStarts(harness).at(-1)!.message.text).toContain(
      "Assistant: I suggest shipping Friday.",
    );
    yield* speak(harness, "We need another day for testing.");
    yield* speak(harness, "Monday gives us time to test.");
    expect((yield* currentRound).activeBotId).toBe(botId("assistant"));
    const followUp = turnStarts(harness).at(-1)!.message.text;
    expect(followUp).toContain("Dev: We need another day for testing.");
    expect(followUp).toContain("Planner: Monday gives us time to test.");
    expect(followUp).toContain("ONE final verdict");
    expect(followUp).toContain("what do we do about the release?");
    yield* speak(harness, "Agreed, Monday is safer.");
    expect((yield* currentRound).status).toBe("completed");
    expect((yield* currentRound).spoken).toEqual([...order, order[0]]);
    expect(turnStarts(harness)).toHaveLength(4);
    const phases = groupTranscript(harness)
      .flatMap((message) => message.context?.records ?? [])
      .filter((record) => record.kind === "personal-group")
      .map((record) =>
        "payload" in record ? (record.payload as { phase?: string }).phase : undefined,
      );
    expect(phases.filter((phase) => phase === "discussion")).toHaveLength(3);
    expect(phases.filter((phase) => phase === "verdict")).toHaveLength(1);
    yield* send("What should we do next?", "msg-next");
    expect((yield* currentRound).activeBotId).toBe(botId("assistant"));
    expect((yield* currentRound).queue).toEqual(order.slice(1));
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 4. serial multi-mention
// ---------------------------------------------------------------------------

it.effect("automatic discussion stays bounded even when members mention each other", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"]);
    yield* send("Discuss the release");
    yield* speak(harness, "Friday? @Dev");
    yield* speak(harness, "Monday. @Assistant");
    yield* speak(harness, "Agreed. @Dev");
    expect((yield* currentRound).status).toBe("completed");
    expect(turnStarts(harness)).toHaveLength(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("automatic discussion preserves pending members across a budget pause", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev", "planner"], 2);
    yield* send("Discuss the release");
    yield* speak(harness, "Friday.");
    yield* speak(harness, "Monday.");
    expect((yield* currentRound).status).toBe("paused_budget");
    expect((yield* currentRound).queue).toEqual([botId("planner")]);
    yield* service.continueRound({ groupId: GROUP });
    yield* service.drain;
    expect((yield* currentRound).activeBotId).toBe(botId("planner"));
    expect(turnStarts(harness).at(-1)!.message.text).toContain("Dev: Monday.");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a failed final verdict does not restart the discussion", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"]);
    yield* send("Compare the options", "msg-options");
    yield* speak(harness, "Option A is faster.");
    yield* speak(harness, "Option B costs less.");
    const final = yield* currentRound;
    expect(final.activeMessageId).toContain("-verdict");
    const turnId = yield* beginTurn(harness, final.activeThreadId!);
    yield* endTurn(harness, final.activeThreadId!, turnId, "", {
      status: "error",
      lastError: "Rate limited",
      providerRetry: providerWait(yield* DateTime.now, 60_000),
    });
    expect((yield* currentRound).status).toBe("interrupted");
    expect(turnStarts(harness)).toHaveLength(3);
    expect(groupTranscript(harness).at(-1)?.text).toContain("final verdict could not finish");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("two mentions speak one at a time, in mention order", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"]);
    yield* send("@Planner then @Dev, thoughts?");

    const first = yield* currentRound;
    expect(first.queue).toEqual([botId("dev")]);
    expect(first.activeBotId).toBe(botId("planner"));
    // PERSONAL_GROUP_CONCURRENCY = 1: Dev has no turn yet.
    expect(turnStarts(harness).length).toBe(1);

    yield* speak(harness, "Planner says go.");
    const second = yield* currentRound;
    expect(second.activeBotId).toBe(botId("dev"));
    expect(turnStarts(harness).length).toBe(2);

    yield* speak(harness, "Dev agrees.");
    const done = yield* currentRound;
    expect(done.status).toBe("completed");
    expect(done.spoken).toEqual([botId("planner"), botId("dev")]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 5. a reply that mentions someone queues them, and the budget falls
// ---------------------------------------------------------------------------

it.effect("a reply mentioning another member queues it and spends one bot turn", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant plan the release");
    expect((yield* currentRound).budgetRemaining).toBe(5);

    yield* speak(harness, "I think @Dev should own the build.");
    const after = yield* currentRound;
    expect(after.activeBotId).toBe(botId("dev"));
    expect(after.budgetRemaining).toBe(4);
    expect(after.spoken).toEqual([botId("assistant"), botId("dev")]);

    yield* speak(harness, "On it.");
    expect((yield* currentRound).status).toBe("completed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 6. budget pause and Continue
// ---------------------------------------------------------------------------

it.effect("the budget pauses the round, and Continue gives it a fresh one", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    // Two bot turns, and each reply hands over to the other member, so the
    // conversation would run forever if the budget did not stop it.
    yield* makeGroup(["assistant", "dev"], 2);
    yield* send("@Assistant kick it off");

    yield* speak(harness, "over to @Dev");
    yield* speak(harness, "back to @Assistant");

    const paused = yield* currentRound;
    expect(paused.status).toBe("paused_budget");
    expect(paused.budgetRemaining).toBe(0);
    // The queue survives a budget pause: Continue picks up where it stopped.
    expect(paused.queue).toEqual([botId("assistant")]);
    const notice = groupTranscript(harness).at(-1);
    expect(markerOf(notice)).toMatchObject({
      speaker: { kind: "system", event: "round-paused-budget" },
    });
    expect(notice?.text).toContain("Paused after 2 replies");
    expect(turnStarts(harness).length).toBe(2);

    const continued = yield* service.continueRound({ groupId: GROUP });
    yield* service.drain;
    expect(continued.status).toBe("running");
    expect((yield* currentRound).budgetRemaining).toBe(1);
    expect(turnStarts(harness).length).toBe(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 7. per-member cap
// ---------------------------------------------------------------------------

it.effect("a member speaks at most twice in one round however often it is named", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"], 12);
    yield* send("@Assistant start");

    yield* speak(harness, "@Dev what do you think?");
    yield* speak(harness, "@Assistant I agree");
    // Assistant has now spoken twice. The next naming comes from a THIRD
    // member, so nothing but the per-member cap can refuse it: a self-mention
    // rail would not fire here, and the twelve-turn budget is barely touched.
    yield* speak(harness, "@Planner take it from here");
    yield* speak(harness, "@Assistant one more time please");

    const round = yield* currentRound;
    expect(round.spoken).toEqual([
      botId("assistant"),
      botId("dev"),
      botId("assistant"),
      botId("planner"),
    ]);
    expect(round.queue).toEqual([]);
    expect(round.status).toBe("completed");
    expect(round.budgetRemaining).toBe(8);
    expect(turnStarts(harness).length).toBe(4);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 8. two members answering only each other
// ---------------------------------------------------------------------------

it.effect("two members answering only each other run out of turns, not budget", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 12);
    yield* send("@Assistant begin");
    yield* speak(harness, "@Dev?");
    yield* speak(harness, "@Assistant?");
    yield* speak(harness, "@Dev?");
    yield* speak(harness, "@Assistant?");

    const round = yield* currentRound;
    expect(round.spoken).toEqual([
      botId("assistant"),
      botId("dev"),
      botId("assistant"),
      botId("dev"),
    ]);
    // A twelve-turn budget was nowhere near spent: the per-member cap of 2 is
    // the rail that stops an A-B-A-B exchange, and it stops it first. The
    // ping-pong detector behind it is the backstop for a v2 round-robin that
    // raises the cap; `groupRoundPolicy.test.ts` proves that rail on its own.
    expect(round.budgetRemaining).toBe(8);
    expect(round.queue).toEqual([]);
    expect(round.status).toBe("completed");
    expect(turnStarts(harness).length).toBe(4);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 9. self-mentions and code-fence mentions buy no turn
// ---------------------------------------------------------------------------

it.effect("a self-mention and a mention inside a code fence buy nobody a turn", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"], 6);
    yield* send("@Assistant have a look");

    yield* speak(
      harness,
      ["As @Assistant I would ship it.", "```sh", "notify @Planner @Dev", "```"].join("\n"),
    );

    const round = yield* currentRound;
    expect(round.spoken).toEqual([botId("assistant")]);
    expect(round.queue).toEqual([]);
    expect(round.status).toBe("completed");
    expect(turnStarts(harness).length).toBe(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 10. catch-up cursor
// ---------------------------------------------------------------------------

it.effect("catch-up hands a member only what it has not seen, and silence costs nothing", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev", "planner"], 6);
    yield* send("@Assistant first question", "msg-1");
    yield* speak(harness, "My answer is yes. @Dev over to you.");

    const devBrief = turnStarts(harness).at(-1)!;
    // Dev has seen nothing before now, so it gets the user message AND the
    // Assistant reply, each attributed.
    expect(devBrief.message.text).toContain("You: @Assistant first question");
    expect(devBrief.message.text).toContain("Assistant: My answer is yes.");
    expect(devBrief.message.text).toContain("You are Dev in this group.");
    expect(devBrief.message.text).toContain("@Assistant");
    expect(devBrief.message.text).toContain("@Planner");

    yield* speak(harness, "Dev agrees.");
    yield* send("@Assistant a second question", "msg-2");
    const assistantBrief = turnStarts(harness).at(-1)!;
    // Assistant's cursor means it is told only what happened since it spoke.
    expect(assistantBrief.message.text).toContain("Dev agrees.");
    expect(assistantBrief.message.text).toContain("You: @Assistant a second question");
    expect(assistantBrief.message.text).not.toContain("first question");
    expect(assistantBrief.message.text).not.toContain("My answer is yes.");

    // Planner never spoke, so it never got a provider thread at all.
    const groups = (yield* service.list()).groups[0]!;
    const planner = groups.members.find((member) => member.botId === botId("planner"))!;
    expect(planner.threadId).toBeNull();
    expect(planner.deliveredSeq).toBe(0);
    const bots = yield* PersonalBotService.PersonalBotService;
    expect((yield* bots.list()).threads.map((link) => link.botId).toSorted()).toEqual(
      [botId("assistant"), botId("dev")].toSorted(),
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 11. live relay, the speaker marker, the completion row and the loop guard
// ---------------------------------------------------------------------------

it.effect("deltas relay live into the group thread, marked with the speaker", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant status?", "msg-relay");

    const round = yield* currentRound;
    const memberThread = round.activeThreadId!;
    const turnId = yield* beginTurn(harness, memberThread);
    yield* streamChunk(harness, memberThread, turnId, "All ");
    const midway = groupTranscript(harness).find(
      (message) => message.messageId === round.activeMessageId,
    );
    expect(midway?.text).toBe("All ");
    expect(midway?.isStreaming).toBe(true);
    // The marker rides on the FIRST delta only; the projection preserves it.
    expect(markerOf(midway)).toMatchObject({
      groupId: GROUP,
      roundId: round.roundId,
      speaker: { kind: "bot", botId: botId("assistant"), name: "Assistant" },
    });
    expect(markerOf(midway)!.seq).toBeGreaterThan(0);

    yield* streamChunk(harness, memberThread, turnId, "good so far.");
    expect((yield* currentRound).relayedChars).toBe("All good so far.".length);

    yield* endTurn(harness, memberThread, turnId, "All good so far. Shipping.");
    const finished = groupTranscript(harness).find(
      (message) => message.messageId === round.activeMessageId,
    );
    // The tail comes from the authoritative final text, not from the deltas.
    expect(finished?.text).toBe("All good so far. Shipping.");
    expect(finished?.isStreaming).toBe(false);

    // The log row points at exactly that message, attributed to the speaker.
    const logged = yield* repository.getMessageByMessageId(round.activeMessageId!);
    expect(Option.isSome(logged)).toBe(true);
    expect(logged.pipe(Option.map((entry) => entry.speakerBotId)).pipe(Option.getOrNull)).toBe(
      botId("assistant"),
    );

    // The feedback-loop guard, second line of defence: the relay's own output
    // on the group thread must never be read back as input. (The first line is
    // the active-member-thread filter, which a group thread also fails; the
    // guard is what makes that safe to reorder or relax.)
    const before = harness.dispatched.length;
    yield* service.ingestDomainEvent(
      messageSentEvent(harness, {
        threadId: GROUP_THREAD,
        messageId: MessageId.make("echo-1"),
        role: "assistant",
        text: "an echo of our own relay",
        streaming: true,
        turnId: null,
        at: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    yield* service.drain;
    expect(harness.dispatched.length).toBe(before);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 11b. a turn started directly on the group thread
// ---------------------------------------------------------------------------

it.effect("a stray turn on the group thread is interrupted and reported", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev"], 6);

    // The developer view can start a turn on any thread. A provider running on
    // the shared thread would have no persona and would speak for nobody.
    yield* service.ingestDomainEvent({
      ...eventBase(harness, GROUP_THREAD, DateTime.formatIso(yield* DateTime.now)),
      type: "thread.turn-start-requested",
      payload: {
        threadId: GROUP_THREAD,
        messageId: MessageId.make("stray-1"),
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: DateTime.formatIso(yield* DateTime.now),
      },
    } as OrchestrationEvent);
    yield* service.drain;

    expect(interrupts(harness).map((command) => command.threadId)).toEqual([GROUP_THREAD]);
    const notice = groupTranscript(harness).at(-1);
    expect(markerOf(notice)).toMatchObject({
      speaker: { kind: "system", event: "stray-turn-stopped" },
    });
    expect(notice?.text).toContain("nobody runs on the shared thread");

    // A turn-start on an unrelated thread is none of this service's business.
    const before = harness.dispatched.length;
    yield* service.ingestDomainEvent({
      ...eventBase(harness, "thread-unrelated", DateTime.formatIso(yield* DateTime.now)),
      type: "thread.turn-start-requested",
      payload: {
        threadId: ThreadId.make("thread-unrelated"),
        messageId: MessageId.make("stray-2"),
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: DateTime.formatIso(yield* DateTime.now),
      },
    } as OrchestrationEvent);
    yield* service.drain;
    expect(harness.dispatched.length).toBe(before);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 12. stop
// ---------------------------------------------------------------------------

it.effect("stop clears the queue and interrupts the member that is speaking", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev", "planner"], 6);
    yield* send("@Assistant and @Dev and @Planner, all of you");

    const running = yield* currentRound;
    expect(running.queue.length).toBe(2);
    const memberThread = running.activeThreadId!;
    const turnId = yield* beginTurn(harness, memberThread);

    yield* service.stop({ groupId: GROUP });
    yield* service.drain;

    const stopped = yield* currentRound;
    expect(stopped.status).toBe("stopped");
    expect(stopped.queue).toEqual([]);
    expect(stopped.activeBotId).toBeNull();
    expect(interrupts(harness).map((command) => [command.threadId, command.turnId])).toEqual([
      [memberThread, turnId],
    ]);
    const notice = groupTranscript(harness).at(-1);
    expect(notice?.text).toBe("You stopped the group.");
    expect(markerOf(notice)).toMatchObject({ speaker: { kind: "system", event: "round-stopped" } });

    // Nothing starts afterwards, even on a full sweep.
    const starts = turnStarts(harness).length;
    yield* service.sweep;
    yield* service.drain;
    expect(turnStarts(harness).length).toBe(starts);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 13. throttled members
// ---------------------------------------------------------------------------

const providerWait = (now: DateTime.Utc, waitMs: number) => ({
  kind: "rate_limited" as const,
  provider: "claudeAgent",
  observedAt: DateTime.formatIso(now),
  retryAt: DateTime.formatIso(DateTime.add(now, { milliseconds: waitMs })),
  reason: "HTTP 429 rate_limit",
});

it.effect("a throttled member is skipped when others wait, and parks the round when alone", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant and @Dev");

    const first = yield* currentRound;
    const assistantThread = first.activeThreadId!;
    const turnId = yield* beginTurn(harness, assistantThread);
    const now = yield* DateTime.now;
    // A six-hour limit: far beyond the two-minute wait threshold.
    yield* setSession(
      harness,
      makeSession({
        threadId: assistantThread,
        status: "running",
        activeTurnId: turnId,
        providerRetry: providerWait(now, 6 * 60 * 60_000),
        updatedAt: DateTime.formatIso(now),
      }),
    );

    const skipped = yield* currentRound;
    // Dev was queued, so the group moves on rather than waiting six hours.
    expect(skipped.status).toBe("running");
    expect(skipped.activeBotId).toBe(botId("dev"));
    // The turn produced nothing, so its budget came back: six means six.
    expect(skipped.budgetRemaining).toBe(5);
    expect(interrupts(harness).length).toBe(1);
    expect(
      groupTranscript(harness).some((message) =>
        message.text.includes("Assistant is rate limited"),
      ),
    ).toBe(true);

    // Now Dev, the only one left, is throttled too: the round parks.
    const devThread = skipped.activeThreadId!;
    const devTurn = yield* beginTurn(harness, devThread);
    const later = yield* DateTime.now;
    const retry = providerWait(later, 3 * 60_000);
    yield* setSession(
      harness,
      makeSession({
        threadId: devThread,
        status: "running",
        activeTurnId: devTurn,
        providerRetry: retry,
        updatedAt: DateTime.formatIso(later),
      }),
    );

    const parked = yield* currentRound;
    expect(parked.status).toBe("waiting_provider");
    expect(parked.queue).toEqual([botId("dev")]);
    expect(DateTime.toEpochMillis(parked.availableAt!)).toBe(Date.parse(retry.retryAt));

    // Not claimable before the reset, claimable after it.
    yield* service.sweep;
    yield* service.drain;
    expect((yield* currentRound).status).toBe("waiting_provider");
    yield* TestClock.adjust("4 minutes");
    yield* service.sweep;
    yield* service.drain;
    const woken = yield* currentRound;
    expect(woken.status).toBe("running");
    expect(woken.activeBotId).toBe(botId("dev"));
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a member throttled twice in one round is dropped from it", () => {
  const harness = makeHarness();
  const throttle = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const turnId = yield* beginTurn(harness, threadId);
      const now = yield* DateTime.now;
      yield* setSession(
        harness,
        makeSession({
          threadId,
          status: "running",
          activeTurnId: turnId,
          providerRetry: providerWait(now, 6 * 60 * 60_000),
          updatedAt: DateTime.formatIso(now),
        }),
      );
    });
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 12);
    yield* send("@Assistant and @Dev");

    const first = yield* currentRound;
    expect(first.activeBotId).toBe(botId("assistant"));
    const assistantThread = first.activeThreadId!;
    yield* throttle(assistantThread);

    // Skipped once, and Dev hands the turn straight back.
    const second = yield* currentRound;
    expect(second.activeBotId).toBe(botId("dev"));
    yield* speak(harness, "@Assistant can you try again?");

    const retried = yield* currentRound;
    expect(retried.activeBotId).toBe(botId("assistant"));
    yield* throttle(retried.activeThreadId!);

    const dropped = yield* currentRound;
    expect(dropped.queue).not.toContain(botId("assistant"));
    expect(dropped.activeBotId).toBeNull();
    expect(
      groupTranscript(harness).some((message) =>
        message.text.includes("Assistant is still rate limited, so it is out of this round."),
      ),
    ).toBe(true);
    // Twice throttled and never heard from: both budgets came back.
    expect(dropped.spoken.filter((entry) => entry === botId("assistant")).length).toBe(2);
    expect(dropped.status).toBe("completed");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 14. restart
// ---------------------------------------------------------------------------

it.effect("an expired lease interrupts the round and nothing re-runs without Continue", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-groups-db-" });
    const dbPath = path.join(directory, "state.sqlite");

    const before = makeHarness();
    const memberThread = yield* Effect.gen(function* () {
      yield* seedBots;
      yield* makeGroup(["assistant", "dev"], 6);
      yield* send("@Assistant look into it");
      const round = yield* currentRound;
      // The turn is live and this process holds the lease when it dies.
      yield* beginTurn(before, round.activeThreadId!);
      return round.activeThreadId!;
    }).pipe(Effect.provide(makeLayer(before, dbPath)));

    // A second service over the same database: a different lease owner.
    const after = makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* PersonalGroupService.PersonalGroupService;
      // Before the old lease expires, nothing happens.
      yield* service.sweep;
      yield* service.drain;
      expect((yield* currentRound).status).toBe("running");

      yield* TestClock.adjust("3 minutes");
      yield* service.sweep;
      yield* service.drain;

      const interrupted = yield* currentRound;
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.activeBotId).toBeNull();
      // Re-queued, NOT re-run: a turn nobody watched could have had side
      // effects, so the user decides whether it happens again.
      expect(interrupted.queue).toEqual([botId("assistant")]);
      expect(turnStarts(after).length).toBe(0);
      const notice = (after.messages.get(GROUP_THREAD) ?? []).at(-1);
      expect(notice?.text).toContain("The server restarted while Assistant was replying.");
      expect(markerOf(notice)).toMatchObject({
        speaker: { kind: "system", event: "round-interrupted" },
      });

      // More sweeps change nothing; only Continue restarts the member.
      yield* service.sweep;
      yield* service.drain;
      expect(turnStarts(after).length).toBe(0);

      yield* service.continueRound({ groupId: GROUP });
      yield* service.drain;
      const resumed = yield* currentRound;
      expect(resumed.status).toBe("running");
      expect(resumed.activeBotId).toBe(botId("assistant"));
      expect(resumed.activeThreadId).toBe(memberThread);
      expect(turnStarts(after).length).toBe(1);
    }).pipe(Effect.provide(makeLayer(after, dbPath)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// ---------------------------------------------------------------------------
// 15. a purged bot leaves the group readable
// ---------------------------------------------------------------------------

it.effect("purging a bot leaves the group readable, and empties are archived", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant hello", "msg-purge");
    yield* speak(harness, "Hello back.");

    yield* service.purgeBot({ botId: botId("dev") });
    const stillThere = (yield* service.list()).groups[0]!;
    expect(stillThere.members.map((member) => member.botId)).toEqual([botId("assistant")]);
    expect(stillThere.archivedAt).toBeNull();
    expect(
      groupTranscript(harness).some((message) =>
        message.text.includes("Dev was deleted, so it left this group."),
      ),
    ).toBe(true);
    // The transcript is intact: the conversation still happened.
    expect(groupTranscript(harness).some((message) => message.text === "Hello back.")).toBe(true);

    yield* service.purgeBot({ botId: botId("assistant") });
    const emptied = (yield* service.list()).groups[0]!;
    expect(emptied.members).toEqual([]);
    // Archived, never deleted.
    expect(emptied.archivedAt).not.toBeNull();
    expect(emptied.newestMessage).not.toBeNull();
  }).pipe(Effect.provide(makeLayer(harness)));
});

// The group-delete path (`deletePersonalGroup`) purges ticked bots through
// `purgePersonalBot`, which calls this. A bot that sat in a SECOND group must
// leave it with a line in its transcript, and a second group the departure
// empties is archived - not deleted, and not left claiming a member it lost.
it.effect(
  "purging a bot leaves every other group it was in readable, and archives an emptied one",
  () => {
    const harness = makeHarness();
    const OTHER = PersonalGroupId.make("group-2");
    const OTHER_THREAD = ThreadId.make("thread-group-2");
    return Effect.gen(function* () {
      yield* seedBots;
      const service = yield* PersonalGroupService.PersonalGroupService;
      yield* makeGroup(["assistant", "dev"], 6);
      yield* service.create({
        groupId: OTHER,
        threadId: OTHER_THREAD,
        name: "Side project",
        botIds: [botId("dev")],
      });

      yield* service.purgeBot({ botId: botId("dev") });

      const groups = (yield* service.list()).groups;
      const first = groups.find((group) => group.groupId === GROUP)!;
      const other = groups.find((group) => group.groupId === OTHER)!;
      // The group being deleted keeps its other member and stays live.
      expect(first.members.map((member) => member.botId)).toEqual([botId("assistant")]);
      expect(first.archivedAt).toBeNull();
      // The other group loses its only member: archived, never deleted.
      expect(other.members).toEqual([]);
      expect(other.archivedAt).not.toBeNull();
      const otherTranscript = harness.messages.get(OTHER_THREAD) ?? [];
      expect(
        otherTranscript.some((message) =>
          message.text.includes("Dev was deleted, so it left this group."),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

// ---------------------------------------------------------------------------
// 16. a member thread is not an ordinary chat
// ---------------------------------------------------------------------------

it.effect("a member's chat is identifiable as one, so a chat delete can refuse it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant hi", "msg-member");
    const memberThread = (yield* currentRound).activeThreadId!;

    expect(yield* service.groupNameForMemberThread(memberThread)).toEqual(
      Option.some("Launch crew"),
    );
    expect(yield* service.groupNameForMemberThread(ThreadId.make("thread-unrelated"))).toEqual(
      Option.none(),
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 17. the marker never reaches a provider
// ---------------------------------------------------------------------------

it("the group marker survives persistence decoding and never reaches the provider", () => {
  const marker: PersonalGroupMessageMarker = {
    groupId: PersonalGroupId.make("group-1"),
    seq: 42,
    roundId: PersonalGroupRoundId.make("round-1"),
    speaker: { kind: "bot", botId: PersonalBotId.make("bot-dev"), name: "Dev" },
  };
  const context = PersonalGroupService.personalGroupMessageContext(marker);
  // Same codec as projection_thread_messages.context_json, i.e. a replay.
  const codec = Schema.fromJsonString(OrchestrationMessageContext);
  const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(context));
  const record = decoded.records[0]!;
  expect(record.kind).toBe(PERSONAL_GROUP_MESSAGE_CONTEXT_KIND);
  expect("payload" in record ? record.payload : null).toEqual(marker);
  // Nothing references the record from the text, so the projection for the
  // provider drops it: a bot never learns that a marker exists.
  const text = "Assistant: All good so far.";
  expect(projectComposerContextForProvider({ text, records: decoded.records })).toBe(text);
});

// ---------------------------------------------------------------------------
// Voting (addendum section V). The rails live in the service; the pure halves
// (`groupVotePolicy.ts`, `nextStep`) have their own tests.
// ---------------------------------------------------------------------------

/** The member holding the slot puts a question to the group. */
const callVote = (question: string, options: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    const round = yield* currentRound;
    if (round.activeThreadId === null) {
      throw new Error("nobody is speaking, so nobody can call a vote");
    }
    return yield* service.callVote({ threadId: round.activeThreadId, question, options });
  });

/** The member holding the slot answers the open vote. */
const castVote = (voteId: PersonalGroupVoteId, option: string, reason: string) =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    const round = yield* currentRound;
    if (round.activeThreadId === null) {
      throw new Error("nobody is speaking, so nobody can vote");
    }
    return yield* service.castVote({ threadId: round.activeThreadId, voteId, option, reason });
  });

const voteOf = (voteId: PersonalGroupVoteId) =>
  Effect.gen(function* () {
    const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
    const vote = yield* repository.getVote(voteId);
    if (Option.isNone(vote)) {
      throw new Error(`no vote ${voteId}`);
    }
    return vote.value;
  });

/** Every system row in the transcript, as `{ event, text }`. */
const systemRows = (harness: Harness) =>
  groupTranscript(harness).flatMap((message) => {
    const marker = markerOf(message);
    return marker?.speaker.kind === "system"
      ? [{ event: marker.speaker.event, text: message.text }]
      : [];
  });

const answerVote = (vote: PersonalGroupVoteId, decision: "approve" | "reject") =>
  Effect.gen(function* () {
    const service = yield* PersonalGroupService.PersonalGroupService;
    const round = yield* service.continueRound({
      groupId: GROUP,
      vote: { voteId: vote, decision },
    });
    yield* service.drain;
    return round;
  });

// ---------------------------------------------------------------------------
// 20. a vote turn spends budget exactly like an ordinary reply
// ---------------------------------------------------------------------------

it.effect("a turn that only voted still spends its budget, and gets nothing back", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    // One member, so calling the vote queues nobody and the turn under test is
    // the only one that runs. Any refund would show up as 6.
    yield* makeGroup(["assistant"], 6);
    yield* send("@Assistant what do we do?");
    expect((yield* currentRound).budgetRemaining).toBe(5);

    const vote = yield* callVote("Ship on Friday?", ["ship", "wait"]);
    yield* castVote(vote.vote.voteId, "ship", "it is ready");
    // The vote is not the reply: this turn produced no prose at all, which is
    // the one shape where a refund could plausibly have been added. It is not
    // - a refund belongs only to a turn the provider never ran (a throttle, an
    // abandon), and this member did get its say.
    yield* speak(harness, "");

    const after = yield* currentRound;
    expect(after.budgetRemaining).toBe(5);
    expect(after.spoken).toEqual([botId("assistant")]);
    expect(after.status).toBe("paused_vote");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("every member queued by a vote spends a turn of the budget to answer it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"], 6);
    yield* send("@Assistant what do we do?");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    // Calling a vote queues exactly the OTHER members, in sort order. The
    // caller is not among them: it votes in the turn it already holds, and
    // asking the question buys it nothing (section V.2).
    expect((yield* currentRound).queue).toEqual([botId("dev"), botId("planner")]);

    yield* castVote(vote.voteId, "ship", "green build");
    yield* speak(harness, "Called a vote.");
    yield* castVote(vote.voteId, "ship", "agreed");
    yield* speak(harness, "Voted.");
    yield* castVote(vote.voteId, "wait", "not yet");
    yield* speak(harness, "Voted.");

    const after = yield* currentRound;
    // Three members, three turns, three of six bot turns spent. Answering a
    // vote is an ordinary reply as far as the budget is concerned.
    expect(after.spoken).toEqual([botId("assistant"), botId("dev"), botId("planner")]);
    expect(after.budgetRemaining).toBe(3);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 23 + 24 + 27. plurality, then a round that parks instead of completing
// ---------------------------------------------------------------------------

it.effect("a plurality wins, nothing runs on it, and the round parks for the user", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"], 6);
    yield* send("@Assistant settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    // Everyone may ballot, the caller included.
    expect([...vote.options]).toEqual(["ship", "wait"]);
    yield* castVote(vote.voteId, "ship", "the build is green");
    yield* speak(harness, "I have called a vote.");

    // Calling a vote bought the caller no extra turn: the two OTHER members
    // were queued, and they are the ones speaking now.
    yield* castVote(vote.voteId, "wait", "the migration is not tested");
    yield* speak(harness, "Voted.");
    const startsBefore = turnStarts(harness).length;
    const last = yield* castVote(vote.voteId, "ship", "I agree with Assistant");
    // The last ballot resolves it: 2 for ship, 1 for wait.
    expect(last.status).toBe("decided");
    expect(last.winningOption).toBe("ship");
    yield* speak(harness, "Voted.");

    // Test 24: resolution executed nothing. No turn was started by the vote
    // resolving, and nobody is speaking.
    expect(turnStarts(harness).length).toBe(startsBefore);
    const parked = yield* currentRound;
    // Test 27: the queue ran dry, which would normally complete the round.
    expect(parked.queue).toEqual([]);
    expect(parked.status).toBe("paused_vote");
    expect(parked.activeBotId).toBe(null);

    const resolved = systemRows(harness).filter((row) => row.event === "vote-resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]!.text).toContain("ship");
    expect(resolved[0]!.text).toContain("Nothing happens until you approve it");

    // Still parked after a sweep: no timer resolves it, only the user does.
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* service.sweep;
    yield* service.drain;
    expect((yield* currentRound).status).toBe("paused_vote");
    expect(turnStarts(harness).length).toBe(startsBefore);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 23b. an exact tie resolves with no winner, and cannot be approved
// ---------------------------------------------------------------------------

it.effect("an exact tie resolves tied, with no winner to approve", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    yield* castVote(vote.voteId, "ship", "the build is green");
    yield* speak(harness, "Called a vote.");
    const decided = yield* castVote(vote.voteId, "wait", "not tested");
    yield* speak(harness, "Voted.");

    expect(decided.status).toBe("decided");
    expect(decided.winningOption).toBe(null);
    expect((yield* currentRound).status).toBe("paused_vote");
    const resolved = systemRows(harness).find((row) => row.event === "vote-resolved");
    expect(resolved?.text).toContain("is tied");

    // There is no winner, so there is nothing to approve. No tie-break is
    // invented: a coin toss must not decide what the bots do next.
    const service = yield* PersonalGroupService.PersonalGroupService;
    const refused = yield* Effect.flip(
      service.continueRound({
        groupId: GROUP,
        vote: { voteId: vote.voteId, decision: "approve" },
      }),
    );
    expect(refused.message).toContain("tied");
    expect((yield* currentRound).status).toBe("paused_vote");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 22. the wall clock resolves an open vote with abstentions
// ---------------------------------------------------------------------------

it.effect("the wall clock resolves an open vote, counting the silent as abstentions", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"], 6);
    yield* send("@Assistant settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    yield* castVote(vote.voteId, "ship", "the build is green");
    yield* speak(harness, "Called a vote.");
    // Dev is now speaking and never votes. Time runs out on it.
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* TestClock.adjust("11 minutes");
    yield* service.sweep;
    yield* service.drain;

    const settled = yield* voteOf(vote.voteId);
    expect(settled.status).toBe("decided");
    // One ballot, two abstentions: a plurality of one still wins, and the
    // silence is counted and said out loud rather than read as agreement.
    expect(settled.winningOption).toBe("ship");
    expect(settled.ballots.length).toBe(1);
    const resolved = systemRows(harness).find((row) => row.event === "vote-resolved");
    expect(resolved?.text).toContain("2 did not vote");

    // The round parked rather than being interrupted: the wall clock ends the
    // talking, it does not throw away a tally the user has not seen.
    const parked = yield* currentRound;
    expect(parked.status).toBe("paused_vote");
    expect(parked.activeBotId).toBe(null);
    // And the member that was mid-sentence was stopped.
    expect(interrupts(harness).length).toBeGreaterThan(0);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 25. Approve relays the winning option into the right member's thread
// ---------------------------------------------------------------------------

it.effect("approve relays the winning option into the named member's next instruction", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant settle this");

    // The option names Dev, so Dev is who the decision becomes work for -
    // not Assistant, which called the vote.
    const vote = (yield* callVote("Who writes the migration?", ["@Dev writes it", "nobody"])).vote;
    yield* castVote(vote.voteId, "@Dev writes it", "it is their area");
    yield* speak(harness, "Called a vote.");
    yield* castVote(vote.voteId, "@Dev writes it", "fine by me");
    yield* speak(harness, "Voted.");
    expect((yield* currentRound).status).toBe("paused_vote");

    const startsBefore = turnStarts(harness).length;
    const resumed = yield* answerVote(vote.voteId, "approve");
    expect(resumed.status).toBe("running");
    expect((yield* voteOf(vote.voteId)).status).toBe("approved");

    const approved = systemRows(harness).find((row) => row.event === "vote-approved");
    expect(approved?.text).toContain("@Dev writes it");
    expect(approved?.text).toContain("Dev, that is the group's decision");

    // The decision reaches the bot the only way anything reaches it: as the
    // next line of its own brief. This is the whole of test 25.
    const started = turnStarts(harness).slice(startsBefore);
    expect(started.length).toBe(1);
    const live = yield* currentRound;
    expect(live.activeBotId).toBe(botId("dev"));
    expect(started[0]!.threadId).toBe(live.activeThreadId);
    expect(started[0]!.message.text).toContain("@Dev writes it");
    expect(started[0]!.message.text).toContain("that is the group's decision");
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("approve falls back to the bot that called the vote when no option names one", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Dev settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    yield* castVote(vote.voteId, "ship", "green build");
    yield* speak(harness, "Called a vote.");
    yield* castVote(vote.voteId, "ship", "agreed");
    yield* speak(harness, "Voted.");

    yield* answerVote(vote.voteId, "approve");
    // Dev asked the question, so Dev carries the answer.
    expect((yield* currentRound).activeBotId).toBe(botId("dev"));
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 26. Reject records the refusal and lets the discussion go on
// ---------------------------------------------------------------------------

it.effect("reject writes a system row and unparks the round", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    yield* castVote(vote.voteId, "ship", "green build");
    yield* speak(harness, "Called a vote.");
    yield* castVote(vote.voteId, "ship", "agreed");
    yield* speak(harness, "Voted.");
    expect((yield* currentRound).status).toBe("paused_vote");

    const startsBefore = turnStarts(harness).length;
    yield* answerVote(vote.voteId, "reject");

    expect((yield* voteOf(vote.voteId)).status).toBe("rejected");
    const rejected = systemRows(harness).find((row) => row.event === "vote-rejected");
    expect(rejected?.text).toContain("You rejected the vote");
    expect(rejected?.text).toContain("Ship on Friday?");

    // Nothing was started on a rejected decision. The round is no longer
    // parked either: its queue was empty, so the discussion simply ended.
    expect(turnStarts(harness).length).toBe(startsBefore);
    expect((yield* currentRound).status).toBe("completed");

    // And the group carries on talking: a reject is a refusal of one
    // decision, not the end of the conversation.
    yield* send("@Dev then what?", "msg-after-reject");
    const next = yield* currentRound;
    expect(next.status).toBe("running");
    expect(next.activeBotId).toBe(botId("dev"));
    expect(turnStarts(harness).length).toBe(startsBefore + 1);

    // The re-ask rail is scoped to a round, as the addendum says: the new
    // round may put the same question again, and it lands as a new vote.
    const again = yield* callVote("Ship on Friday?", ["ship", "wait"]);
    expect(again.vote.voteId).not.toBe(vote.voteId);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// A round that really ends takes its unanswered ballots with it
// ---------------------------------------------------------------------------

it.effect("stop expires an open vote instead of leaving it to be answered later", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    const service = yield* PersonalGroupService.PersonalGroupService;
    yield* service.stop({ groupId: GROUP });
    yield* service.drain;

    expect((yield* voteOf(vote.voteId)).status).toBe("expired");
    expect((yield* currentRound).status).toBe("stopped");
    // And an expired vote is not a tally the user can act on.
    const refused = yield* Effect.flip(
      service.continueRound({
        groupId: GROUP,
        vote: { voteId: vote.voteId, decision: "approve" },
      }),
    );
    expect(refused.message).toContain("expired");
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// The parked round is visible to a client that just connected
// ---------------------------------------------------------------------------

it.effect("list and subscribe replay the tally a parked round is waiting on", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev"], 6);
    yield* send("@Assistant settle this");

    const vote = (yield* callVote("Ship on Friday?", ["ship", "wait"])).vote;
    yield* castVote(vote.voteId, "ship", "green build");
    yield* speak(harness, "Called a vote.");
    yield* castVote(vote.voteId, "ship", "agreed");
    yield* speak(harness, "Voted.");

    const service = yield* PersonalGroupService.PersonalGroupService;
    const listed = yield* service.list();
    expect(listed.rounds.map((round) => round.status)).toEqual(["paused_vote"]);
    expect(listed.votes.length).toBe(1);
    expect(listed.votes[0]).toMatchObject({
      voteId: vote.voteId,
      status: "decided",
      winningOption: "ship",
    });
    // The ballots ride along: the card shows each member's choice AND reason,
    // which is the whole point of recording a vote as data.
    expect(listed.votes[0]!.ballots.map((ballot) => [ballot.botId, ballot.reason])).toEqual([
      [botId("assistant"), "green build"],
      [botId("dev"), "agreed"],
    ]);

    const replayed = yield* Stream.runCollect(Stream.take(service.subscribe, 3));
    expect([...replayed].map((event) => event.type)).toEqual(["group", "round", "vote"]);
  }).pipe(Effect.provide(makeLayer(harness)));
});
