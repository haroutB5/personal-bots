// @effect-diagnostics globalTimers:off -- real time is the point: the interrupt must land while the dispatch is in flight. Tests only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PersonalBotId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemoryWorker } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import { personalThreadLinkIntentKey } from "./personalThreadLinkRepair.ts";

/**
 * QA's 1.66.70 blocker, at the service boundary and on the real worker:
 * `personalBots.createThread` must leave the chat's bot link behind even when
 * the requesting fiber is interrupted (a browser that disconnects) while the
 * thread.create dispatch is still returning.
 *
 * The test clock is not used for the dispatch delay on purpose: it has to be
 * real time, so the interrupt reaches the service while the dispatch is still
 * in flight.
 */

interface TestContext {
  readonly dispatched: Array<OrchestrationCommand>;
  onThreadCreate?: (() => void) | undefined;
  onThreadDelete?: (() => void) | undefined;
}

const context: TestContext = { dispatched: [] };

const realDelay = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const provider = (): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T00:00:00.000Z",
    models: [
      {
        slug: "gpt-6-astra",
        name: "gpt-6-astra",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  }) as unknown as ServerProvider;

const testLayer = PersonalBotService.layer.pipe(
  Layer.provideMerge(PersonalBotRepository.layer),
  // Explicit worker mode: this is the path the regression came from.
  Layer.provideMerge(SqlitePersistenceMemoryWorker),
  Layer.provideMerge(
    Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          context.dispatched.push(command);
          // A real dispatch returns only after its command has landed. The
          // wait is where a disconnecting client's interrupt arrives.
          if (command.type === "thread.create") {
            context.onThreadCreate?.();
            context.onThreadCreate = undefined;
            yield* realDelay(150);
          }
          if (command.type === "thread.delete") {
            context.onThreadDelete?.();
            context.onThreadDelete = undefined;
            yield* realDelay(150);
          }
          return { sequence: context.dispatched.length };
        }),
    } as unknown as OrchestrationEngine.OrchestrationEngineShape),
  ),
  Layer.provideMerge(
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.sync(() => [provider()]),
    } as unknown as ProviderRegistry.ProviderRegistryShape),
  ),
  Layer.provideMerge(
    Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getProjectShellById: () => Effect.succeed(Option.none()),
      getProjectShells: () => Effect.succeed([]),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-worker-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const botInput = (botId: string) =>
  ({
    botId: PersonalBotId.make(botId),
    name: "Helper",
    title: "Helper bot",
    description: "Helps with things.",
    instructions: "Be helpful.",
    avatarShape: "blob" as const,
    avatarColor: "#1A73E8",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
    },
  }) as const;

it.effect("a disconnect during createThread still links the chat (worker mode)", () =>
  Effect.gen(function* () {
    context.dispatched.length = 0;
    const service = yield* PersonalBotService.PersonalBotService;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* service.create(botInput("bot-disconnect"));
    const threadId = ThreadId.make("thread-disconnect");

    let signalCreate!: () => void;
    const createSeen = new Promise<void>((resolve) => {
      signalCreate = resolve;
    });
    context.onThreadCreate = signalCreate;
    const creating = yield* Effect.forkChild(
      service.createThread({
        botId: bot.botId,
        threadId,
        title: "QA16670 disconnect",
        titleSource: "owner",
      }),
    );
    yield* Effect.promise(() => createSeen);
    // What the closed socket does to the RPC fiber, mid-createThread.
    yield* Fiber.interrupt(creating);

    const link = yield* repository.getThreadLink({ threadId });
    expect(Option.isSome(link)).toBe(true);
    expect(Option.getOrThrow(link).threadId).toBe(threadId);
    const intent = yield* sql<{ readonly count: number }>`
      SELECT count(*) AS "count" FROM personal_meta
      WHERE key = ${personalThreadLinkIntentKey(threadId)}
    `;
    expect(intent[0]?.count).toBe(0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a retried createThread links a projection whose link is missing", () =>
  Effect.gen(function* () {
    context.dispatched.length = 0;
    const service = yield* PersonalBotService.PersonalBotService;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const bot = yield* service.create(botInput("bot-retry"));
    const threadId = ThreadId.make("thread-retry");

    yield* service.createThread({ botId: bot.botId, threadId, title: "Retry me" });
    // The state a process death between the two writes used to leave.
    yield* sql`DELETE FROM personal_bot_threads WHERE thread_id = ${threadId}`;
    expect(Option.isNone(yield* repository.getThreadLink({ threadId }))).toBe(true);

    yield* service.createThread({ botId: bot.botId, threadId, title: "Retry me" });
    const link = yield* repository.getThreadLink({ threadId });
    expect(Option.isSome(link)).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a disconnect during deleteThread removes the link too (worker mode)", () =>
  Effect.gen(function* () {
    context.dispatched.length = 0;
    const service = yield* PersonalBotService.PersonalBotService;
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const bot = yield* service.create(botInput("bot-delete"));
    const threadId = ThreadId.make("thread-delete");
    yield* service.createThread({ botId: bot.botId, threadId, title: "Delete me" });

    let signalDelete!: () => void;
    const deleteSeen = new Promise<void>((resolve) => {
      signalDelete = resolve;
    });
    context.onThreadDelete = signalDelete;
    const deleting = yield* Effect.forkChild(service.deleteThread({ threadId }));
    yield* Effect.promise(() => deleteSeen);
    yield* Fiber.interrupt(deleting);

    const link = yield* repository.getThreadLink({ threadId });
    expect(Option.isNone(link)).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);
