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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";

const makeProviderSnapshot = (input: {
  readonly instanceId: string;
  readonly driver: "claudeAgent" | "codex";
  readonly defaultModel: string;
}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models: [
      {
        slug: input.defaultModel,
        name: input.defaultModel,
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  }) as unknown as ServerProvider;

const claudeSnapshot = () =>
  makeProviderSnapshot({
    instanceId: "claude",
    driver: "claudeAgent",
    defaultModel: "claude-fable-5-1",
  });

const codexSnapshot = () =>
  makeProviderSnapshot({ instanceId: "codex", driver: "codex", defaultModel: "gpt-6-astra" });

interface PersonalBotsTestContext {
  readonly snapshots: Array<ServerProvider>;
  readonly dispatched: Array<OrchestrationCommand>;
}

const makeContext = (snapshots: ReadonlyArray<ServerProvider> = []): PersonalBotsTestContext => ({
  snapshots: [...snapshots],
  dispatched: [],
});

const makeTestLayer = (context: PersonalBotsTestContext) =>
  PersonalBotService.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            context.dispatched.push(command);
            return { sequence: context.dispatched.length };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.sync(() => [...context.snapshots]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-bots-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const botInput = (botId: string) =>
  ({
    botId: PersonalBotId.make(botId),
    name: "Helper",
    description: "Helps with things.",
    instructions: "Be helpful.",
    avatarShape: "blob" as const,
    avatarColor: "#1A73E8",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
    },
  }) as const;

it.effect(
  "create then list round-trips the bot; recreating the same botId returns the existing bot",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      const created = yield* service.create(botInput("bot-1"));
      const listed = yield* service.list();
      expect(listed.bots.length).toBe(1);
      expect(listed.bots[0]?.botId).toBe(created.botId);
      expect(listed.bots[0]?.avatarShape).toBe("blob");
      expect(listed.bots[0]?.avatarColor).toBe("#1A73E8");
      expect(listed.bots[0]?.modelSelection.instanceId).toBe("codex");
      expect(listed.bots[0]?.modelSelection.model).toBe("gpt-6-astra");
      expect(listed.bots[0]).toEqual(created);

      const again = yield* service.create(botInput("bot-1"));
      expect(again.botId).toBe(created.botId);
      const relisted = yield* service.list();
      expect(relisted.bots.length).toBe(1);
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect("update changes name and avatar; delete hides the bot from list", () => {
  const context = makeContext();
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const created = yield* service.create(botInput("bot-2"));
    const updated = yield* service.update({
      botId: created.botId,
      name: "Renamed",
      avatarShape: "pill",
      avatarColor: "#000000",
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.avatarShape).toBe("pill");
    expect(updated.avatarColor).toBe("#000000");

    yield* service.remove({ botId: created.botId });
    const listed = yield* service.list();
    expect(listed.bots.length).toBe(0);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect("seedDefaultsIfNeeded creates the four default bots once, even after a delete", () => {
  const context = makeContext([claudeSnapshot(), codexSnapshot()]);
  return Effect.gen(function* () {
    const service = yield* PersonalBotService.PersonalBotService;
    const seeded = yield* service.seedDefaultsIfNeeded;
    expect(seeded.length).toBe(4);
    expect(
      seeded.map((bot) => [
        bot.name,
        bot.avatarShape,
        bot.avatarColor,
        bot.modelSelection.instanceId,
        bot.modelSelection.model,
      ]),
    ).toEqual([
      ["Assistant", "blob", "#1A73E8", "claude", "claude-fable-5-1"],
      ["Developer", "roundedHexagon", "#F26A1B", "codex", "gpt-6-astra"],
      ["Researcher", "scallopedCloud", "#F0457E", "codex", "gpt-6-astra"],
      ["Planner", "roundedSquare", "#E5323B", "claude", "claude-fable-5-1"],
    ]);

    expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
    yield* service.remove({ botId: seeded[1]!.botId });
    expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
    const listed = yield* service.list();
    expect(listed.bots.length).toBe(3);
  }).pipe(Effect.provide(makeTestLayer(context)));
});

it.effect(
  "seeding waits for a provider and then puts every bot on the one available instance",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      // No provider yet: nothing seeded, and the flag stays unset so a later
      // provider still triggers the seed.
      expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
      expect((yield* service.list()).bots.length).toBe(0);

      context.snapshots.push(codexSnapshot());
      const seeded = yield* service.seedDefaultsIfNeeded;
      expect(seeded.length).toBe(4);
      for (const bot of seeded) {
        expect(bot.modelSelection.instanceId).toBe("codex");
        expect(bot.modelSelection.model).toBe("gpt-6-astra");
      }
      expect(yield* service.seedDefaultsIfNeeded).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);

it.effect(
  "createThread twice with the same threadId links once and dispatches thread.create once",
  () => {
    const context = makeContext();
    return Effect.gen(function* () {
      const service = yield* PersonalBotService.PersonalBotService;
      const created = yield* service.create(botInput("bot-3"));
      const threadId = ThreadId.make("thread-1");
      const first = yield* service.createThread({ botId: created.botId, threadId });
      const second = yield* service.createThread({ botId: created.botId, threadId });
      expect(second).toEqual(first);
      expect(first.botId).toBe(created.botId);
      expect(first.archivedAt).toBeNull();

      const listed = yield* service.list();
      expect(listed.threads.length).toBe(1);

      const threadCreates = context.dispatched.filter(
        (command) => command.type === "thread.create",
      );
      expect(threadCreates.length).toBe(1);
      expect(threadCreates[0]).toMatchObject({
        threadId,
        title: "New chat",
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
      });
      expect(context.dispatched.filter((command) => command.type === "project.create").length).toBe(
        1,
      );
    }).pipe(Effect.provide(makeTestLayer(context)));
  },
);
