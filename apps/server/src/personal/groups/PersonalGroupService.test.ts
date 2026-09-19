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
  }) as OrchestrationEvent;

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

it.effect("a message with no mentions goes to the first member alone", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* seedBots;
    yield* makeGroup(["assistant", "dev", "planner"]);
    const round = yield* send("what do we do about the release?");

    expect(round.queue).toEqual([botId("assistant")]);
    const live = yield* currentRound;
    expect(live.activeBotId).toBe(botId("assistant"));
    expect(turnStarts(harness).length).toBe(1);
    // Only the addressee's chat exists; the silent members cost nothing.
    const bots = yield* PersonalBotService.PersonalBotService;
    expect((yield* bots.list()).threads.map((link) => link.botId)).toEqual([botId("assistant")]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// ---------------------------------------------------------------------------
// 4. serial multi-mention
// ---------------------------------------------------------------------------

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
    yield* send("plan the release");
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

    // The feedback-loop guard: the relay's own output on the group thread must
    // never be read back as input, or the round would restart itself.
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
