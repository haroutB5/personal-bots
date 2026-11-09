// @effect-diagnostics globalTimers:off -- real time is the point: the interrupt must land while the dispatch is in flight. Tests only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PersonalBotId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as PersonalEngine from "./engine/PersonalEngine.ts";
import { PersonalProviders } from "./engine/PersonalProviders.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import { personalThreadLinkIntentKey } from "./personalThreadLinkRepair.ts";
import { personalTestDatabase } from "./test/personalReadsTestLayer.ts";

/**
 * QA's 1.66.70 blocker, at the service boundary: `personalBots.createThread`
 * must leave the chat's bot link behind even when the requesting fiber is
 * interrupted (a browser that disconnects) while the thread.create dispatch is
 * still returning.
 *
 * The engine seam is doubled with a real-time delay: it is the dispatch that
 * has to still be in flight when the interrupt lands, so the test clock is not
 * used here.
 */

interface TestContext {
  readonly calls: Array<{
    readonly type: "createThread" | "deleteThread";
    readonly threadId: ThreadId;
  }>;
  onThreadCreate?: (() => void) | undefined;
  onThreadDelete?: (() => void) | undefined;
}

const context: TestContext = { calls: [] };

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

const engineLayer = Layer.mock(PersonalEngine.PersonalEngine)({
  createProject: (input) =>
    Effect.succeed(input.projectId ?? ProjectId.make("personal-worker-test-project")),
  getProject: () => Effect.succeed(Option.none()),
  listProjects: () => Effect.succeed([]),
  createThread: (input) =>
    Effect.gen(function* () {
      const threadId = input.threadId ?? ThreadId.make("personal-worker-test-thread");
      context.calls.push({ type: "createThread", threadId });
      // A real dispatch returns only after its command has landed. The
      // wait is where a disconnecting client's interrupt arrives.
      context.onThreadCreate?.();
      context.onThreadCreate = undefined;
      yield* realDelay(150);
      return threadId;
    }),
  updateMeta: () => Effect.void,
  getThread: () => Effect.succeed(Option.none()),
  stop: () => Effect.void,
  deleteThread: (threadId) =>
    Effect.gen(function* () {
      context.calls.push({ type: "deleteThread", threadId });
      context.onThreadDelete?.();
      context.onThreadDelete = undefined;
      yield* realDelay(150);
    }),
});

const testLayer = PersonalBotService.layerRequiringEngine.pipe(
  Layer.provideMerge(engineLayer),
  Layer.provideMerge(PersonalBotRepository.layer),
  Layer.provideMerge(
    Layer.mock(PersonalProviders)({
      listProviders: () => Effect.sync(() => [provider()]),
    }),
  ),
  Layer.provideMerge(personalTestDatabase),
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
    context.calls.length = 0;
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
    context.calls.length = 0;
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
    context.calls.length = 0;
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
