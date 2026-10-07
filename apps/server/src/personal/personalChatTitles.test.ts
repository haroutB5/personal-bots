import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CHAT_NAME_TAKEN_CODE,
  PersonalBotId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  chatNameTakenMessage,
  normalizeChatName,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import {
  chatNameIsTaken,
  isPlaceholderChatTitle,
  uniqueAutomaticTitle,
  uniqueChatTitle,
  unarchivedChatTitle,
} from "./personalChatTitles.ts";

describe("chat name rules (pure)", () => {
  it("compares names trimmed, with inner whitespace collapsed, ignoring case", () => {
    assert.strictEqual(normalizeChatName("  Weekly   REPORT \t"), "weekly report");
    assert.strictEqual(normalizeChatName("Main"), normalizeChatName(" main "));
    assert.notStrictEqual(normalizeChatName("Main"), normalizeChatName("Mai n"));
  });

  it("treats the placeholders as no name at all", () => {
    assert.isTrue(isPlaceholderChatTitle("New chat"));
    assert.isTrue(isPlaceholderChatTitle("  New thread "));
    assert.isFalse(isPlaceholderChatTitle("New chat 2"));
    assert.isFalse(chatNameIsTaken("New chat", ["New chat"]));
    assert.strictEqual(uniqueChatTitle("New chat", ["New chat", "New chat"]), "New chat");
  });

  it("picks the lowest free number from 2", () => {
    assert.strictEqual(uniqueChatTitle("Main", []), "Main");
    assert.strictEqual(uniqueChatTitle("Main", ["Main"]), "Main 2");
    assert.strictEqual(uniqueChatTitle("Main", ["main", "MAIN 2", "Main  3"]), "Main 4");
    // A gap is filled before the count goes on.
    assert.strictEqual(uniqueChatTitle("Main", ["Main", "Main 3"]), "Main 2");
    assert.strictEqual(uniqueChatTitle("Main", ["Main 2"]), "Main");
  });

  it("builds the message the owner reads", () => {
    assert.strictEqual(chatNameTakenMessage("Main"), 'A chat called "Main" already exists');
  });
});

const claudeSnapshot = (): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-13T00:00:00.000Z",
    models: [
      {
        slug: "claude-sonnet-5-5",
        name: "claude-sonnet-5-5",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
  }) as unknown as ServerProvider;

// The real engine and projections, so the open names the rule reads are the
// ones the title commands actually wrote.
const makeLayer = () =>
  PersonalBotService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
        ),
        OrchestrationProjectionSnapshotQueryLive,
        PersonalBotRepository.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([claudeSnapshot()]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-chat-titles-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const botInput = (botId: string) =>
  ({
    botId: PersonalBotId.make(botId),
    name: botId,
    title: "Helper bot",
    description: "Helps with things.",
    instructions: "Be helpful.",
    avatarShape: "blob" as const,
    avatarColor: "#1A73E8",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-sonnet-5-5",
    },
  }) as const;

let threadCount = 0;
const nextThreadId = () => ThreadId.make(`thread-title-${++threadCount}`);

/** What the setup of one test needs, from the layer. */
const services = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  yield* bots.create(botInput("bot-a"));
  yield* bots.create(botInput("bot-b"));
  const botA = PersonalBotId.make("bot-a");
  const botB = PersonalBotId.make("bot-b");
  const titleOf = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.map((shell) => (Option.isSome(shell) ? shell.value.title : null)));
  const owner = (botId: PersonalBotId, title: string) =>
    Effect.gen(function* () {
      const threadId = nextThreadId();
      yield* bots.createThread({ botId, threadId, title, titleSource: "owner" });
      return threadId;
    });
  const auto = (botId: PersonalBotId, title?: string) =>
    Effect.gen(function* () {
      const threadId = nextThreadId();
      yield* bots.createThread({ botId, threadId, ...(title === undefined ? {} : { title }) });
      return threadId;
    });
  return { bots, repository, snapshots, engine, botA, botB, titleOf, owner, auto };
});

describe("a name the owner types", () => {
  it.effect("is refused on create when the bot has an open chat with it", () =>
    Effect.gen(function* () {
      const { owner, titleOf, snapshots, bots, botA } = yield* services;
      const first = yield* owner(botA, "Main");
      assert.strictEqual(yield* titleOf(first), "Main");
      for (const variant of ["Main", "main", "  MAIN  ", "Main "]) {
        const threadId = nextThreadId();
        const error = yield* Effect.flip(
          bots.createThread({ botId: botA, threadId, title: variant, titleSource: "owner" }),
        );
        assert.strictEqual(error.code, CHAT_NAME_TAKEN_CODE);
        assert.strictEqual(error.message, chatNameTakenMessage(variant.trim()));
        // The refused chat was not made at all.
        assert.isTrue(Option.isNone(yield* snapshots.getThreadShellById(threadId)));
      }
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("compares inner whitespace and case the same way", () =>
    Effect.gen(function* () {
      const { owner, botA, bots } = yield* services;
      yield* owner(botA, "Weekly report");
      const error = yield* Effect.flip(
        bots.createThread({
          botId: botA,
          threadId: nextThreadId(),
          title: "weekly    REPORT",
          titleSource: "owner",
        }),
      );
      assert.strictEqual(error.code, CHAT_NAME_TAKEN_CODE);
      // A different name is fine.
      yield* owner(botA, "Weekly reports");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is per bot: another bot may use the name", () =>
    Effect.gen(function* () {
      const { owner, botA, botB, titleOf } = yield* services;
      yield* owner(botA, "Main");
      const other = yield* owner(botB, "Main");
      assert.strictEqual(yield* titleOf(other), "Main");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is not blocked by an archived chat, and the placeholder is never refused", () =>
    Effect.gen(function* () {
      const { owner, auto, bots, botA, titleOf } = yield* services;
      const old = yield* owner(botA, "Main");
      yield* bots.archiveThread({ threadId: old, archived: true });
      const fresh = yield* owner(botA, "Main");
      assert.strictEqual(yield* titleOf(fresh), "Main");
      const a = yield* auto(botA);
      const b = yield* auto(botA);
      assert.strictEqual(yield* titleOf(a), "New chat");
      assert.strictEqual(yield* titleOf(b), "New chat");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is checked on rename: a taken name is refused and the write does not run", () =>
    Effect.gen(function* () {
      const { owner, bots, botA } = yield* services;
      yield* owner(botA, "Main");
      const other = yield* owner(botA, "Other");
      let wrote = 0;
      const write = Effect.sync(() => {
        wrote += 1;
      });
      for (const variant of ["main", " Main ", "MAIN"]) {
        const error = yield* Effect.flip(
          bots.withOwnerChatTitle({ threadId: other, title: variant }, write),
        );
        assert.strictEqual(error.code, CHAT_NAME_TAKEN_CODE);
      }
      assert.strictEqual(wrote, 0);
      // Its own name (even in other letters) and a free name go through.
      yield* bots.withOwnerChatTitle({ threadId: other, title: "OTHER" }, write);
      yield* bots.withOwnerChatTitle({ threadId: other, title: "Third" }, write);
      assert.strictEqual(wrote, 2);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("a name a machine picks", () => {
  it.effect("gets the lowest free number and never fails", () =>
    Effect.gen(function* () {
      const { auto, bots, botA, titleOf } = yield* services;
      const one = yield* auto(botA, "Morning report");
      const two = yield* auto(botA, "Morning report");
      const three = yield* auto(botA, "morning REPORT");
      assert.deepStrictEqual(
        [yield* titleOf(one), yield* titleOf(two), yield* titleOf(three)],
        ["Morning report", "Morning report 2", "morning REPORT 3"],
      );
      // Number 2 leaves the open set: the next chat takes the gap.
      yield* bots.archiveThread({ threadId: two, archived: true });
      const four = yield* auto(botA, "Morning report");
      assert.strictEqual(yield* titleOf(four), "Morning report 2");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is unique per bot", () =>
    Effect.gen(function* () {
      const { auto, botA, botB, titleOf } = yield* services;
      yield* auto(botA, "Upstream probe");
      const other = yield* auto(botB, "Upstream probe");
      assert.strictEqual(yield* titleOf(other), "Upstream probe");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("stays unique when many chats are named at the same moment", () =>
    Effect.gen(function* () {
      const { auto, botA, botB, titleOf } = yield* services;
      // The Personal project exists long before any real burst of chats.
      yield* auto(botB);
      const ids = yield* Effect.all(
        Array.from({ length: 6 }, () => auto(botA, "Crypto alerts")),
        { concurrency: "unbounded" },
      );
      const titles = yield* Effect.all(ids.map(titleOf));
      assert.strictEqual(new Set(titles.map((title) => normalizeChatName(title ?? ""))).size, 6);
      assert.deepStrictEqual([...titles].toSorted(), [
        "Crypto alerts",
        "Crypto alerts 2",
        "Crypto alerts 3",
        "Crypto alerts 4",
        "Crypto alerts 5",
        "Crypto alerts 6",
      ]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("covers a title written to an existing chat (seed, AI, provider, regeneration)", () =>
    Effect.gen(function* () {
      const { owner, auto, repository, botA, botB } = yield* services;
      yield* owner(botA, "Main");
      const chat = yield* auto(botA);
      const elsewhere = yield* auto(botB);
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: chat, title: "main" }),
        "main 2",
      );
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: chat, title: "Fresh" }),
        "Fresh",
      );
      // Its own current name is not a clash with itself.
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: chat, title: "New chat" }),
        "New chat",
      );
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: elsewhere, title: "Main" }),
        "Main",
      );
      // A thread that is not a bot chat keeps what it was given.
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, {
          threadId: ThreadId.make("not-a-bot-chat"),
          title: "Main",
        }),
        "Main",
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("sees only live chats of its own bot: deleted and archived ones do not count", () =>
    Effect.gen(function* () {
      const { owner, auto, bots, repository, engine, botA, botB } = yield* services;
      const archived = yield* owner(botA, "Archived name");
      yield* bots.archiveThread({ threadId: archived, archived: true });
      const deleted = yield* auto(botA, "Deleted name");
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: `test:delete:${deleted}` as never,
        threadId: deleted,
      });
      const chat = yield* auto(botB);
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: chat, title: "Archived name" }),
        "Archived name",
      );
      const peer = yield* auto(botA);
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: peer, title: "Archived name" }),
        "Archived name",
      );
      assert.strictEqual(
        yield* uniqueAutomaticTitle(repository, { threadId: peer, title: "Deleted name" }),
        "Deleted name",
      );
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("unarchive", () => {
  it.effect("keeps the name when nothing has taken it", () =>
    Effect.gen(function* () {
      const { owner, bots, botA, titleOf } = yield* services;
      const chat = yield* owner(botA, "Main");
      yield* bots.archiveThread({ threadId: chat, archived: true });
      const back = yield* bots.archiveThread({ threadId: chat, archived: false });
      assert.isNull(back.archivedAt);
      assert.isUndefined(back.renamedTo);
      assert.strictEqual(yield* titleOf(chat), "Main");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("adds the lowest free number when an open chat has the name now, and says so", () =>
    Effect.gen(function* () {
      const { owner, bots, botA, titleOf } = yield* services;
      const old = yield* owner(botA, "Main");
      yield* bots.archiveThread({ threadId: old, archived: true });
      yield* owner(botA, "Main");
      const taken = yield* owner(botA, "Main 2");
      assert.strictEqual(yield* titleOf(taken), "Main 2");
      const back = yield* bots.archiveThread({ threadId: old, archived: false });
      assert.strictEqual(back.renamedTo, "Main 3");
      assert.strictEqual(yield* titleOf(old), "Main 3");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("unarchiving an open chat renames nothing", () =>
    Effect.gen(function* () {
      const { auto, bots, repository, botA, titleOf } = yield* services;
      const one = yield* auto(botA, "Same");
      const two = yield* auto(botA, "Same");
      const back = yield* bots.archiveThread({ threadId: two, archived: false });
      assert.isUndefined(back.renamedTo);
      assert.strictEqual(yield* titleOf(two), "Same 2");
      assert.strictEqual(
        yield* unarchivedChatTitle(repository, { threadId: one, title: "Same" }),
        null,
      );
    }).pipe(Effect.provide(makeLayer())),
  );
});
