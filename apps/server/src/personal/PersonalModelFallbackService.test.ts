import {
  type ModelSelection,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PersonalProviders } from "./engine/PersonalProviders.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalModelFallbackService from "./PersonalModelFallbackService.ts";
import {
  makePersonalEngineHarness,
  personalEngineTestLayer,
} from "./test/personalEngineTestLayer.ts";

const BOT = PersonalBotId.make("bot-fallback");
const HOME: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
};
const FALLBACK = PERSONAL_BOT_DEFAULT_FALLBACK_MODEL;
const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(Date.now()));
const inOneHour = () => DateTime.formatIso(DateTime.makeUnsafe(Date.now() + 3_600_000));

const provider = (instanceId: string, driver: string, overrides: Record<string, unknown> = {}) =>
  ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    ...overrides,
  }) as never;

const ready = [provider("codex", "codex"), provider(FALLBACK.instanceId, "claudeAgent")];

const DEEPSEEK_HOME: ModelSelection = {
  instanceId: ProviderInstanceId.make("deepseek"),
  model: "deepseek-flash",
};
const DEEPSEEK_READY = [
  provider(DEEPSEEK_HOME.instanceId, "deepseek"),
  provider(FALLBACK.instanceId, "claudeAgent"),
];
const PEAK_SETTINGS = {
  providerInstances: {
    [DEEPSEEK_HOME.instanceId]: {
      driver: "deepseek",
      enabled: true,
      config: { peakSwitch: true },
    },
  },
};

const makeLayer = (
  providers: ReadonlyArray<unknown>,
  env: Record<string, string> = {},
  settings: Record<string, unknown> = {},
) => {
  const providerPort = Layer.mock(PersonalProviders)({
    listProviders: () => Effect.succeed(providers as never),
    invalidateUsage: () => Effect.void,
    refreshInstance: () => Effect.succeed(providers as never),
  });
  return PersonalModelFallbackService.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(providerPort),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest(settings as never)),
    Layer.provideMerge(personalEngineTestLayer(makePersonalEngineHarness())),
    Layer.provideMerge(SecureRandom.layerWebCrypto),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fallback-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );
};

const createBot = (
  overrides: {
    readonly fallbackEnabled?: boolean;
    readonly modelSelection?: ModelSelection;
  } = {},
) =>
  Effect.gen(function* () {
    const repository = yield* PersonalBotRepository.PersonalBotRepository;
    const at = DateTime.makeUnsafe(Date.now());
    yield* repository.createBot({
      botId: BOT,
      name: "Fallback",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: HOME,
      team: "default",
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    } as never);
  });

const limitHit = (overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const fallback = yield* PersonalModelFallbackService.PersonalModelFallback;
    return yield* fallback.onLimitHit({
      botId: BOT,
      threadId: null,
      source: "chat",
      instanceId: HOME.instanceId,
      providerName: "codex",
      reason: "usage limit reached",
      retryAt: inOneHour(),
      ...overrides,
    });
  });

const states = Effect.gen(function* () {
  const repository = yield* PersonalBotRepository.PersonalBotRepository;
  return yield* repository.listFallbackStates();
});

describe("PersonalModelFallback on the v2 stack", () => {
  it.effect("moves the bot to its fallback when the fallback has room", () =>
    Effect.gen(function* () {
      yield* createBot();
      const result = yield* limitHit();
      expect(result.switched).toBe(true);
      expect(result.modelLabel).toBeTruthy();
      const rows = yield* states;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.botId).toBe(BOT);
      expect(rows[0]?.fromInstanceId).toBe(HOME.instanceId);
      expect(rows[0]?.fallbackModel.instanceId).toBe(FALLBACK.instanceId);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("answers no_bot for a bot that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* limitHit({ botId: PersonalBotId.make("bot-missing") });
      expect(result).toEqual({ switched: false, skipped: "no_bot" });
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("stays on the home model when the fallback provider is not ready", () =>
    Effect.gen(function* () {
      yield* createBot();
      const result = yield* limitHit();
      expect(result).toEqual({ switched: false, skipped: "fallback_unavailable" });
      expect(yield* states).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer([provider("codex", "codex")]))),
  );

  it.effect("does not switch a bot whose own fallback is turned off", () =>
    Effect.gen(function* () {
      yield* createBot({ fallbackEnabled: false });
      const result = yield* limitHit();
      expect(result).toEqual({ switched: false, skipped: "disabled" });
      expect(yield* states).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("honours the kill switch", () =>
    Effect.gen(function* () {
      yield* createBot();
      const result = yield* limitHit();
      expect(result).toEqual({ switched: false, skipped: "kill_switch" });
      expect(yield* states).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(ready, { PERSONAL_MODEL_FALLBACK: "off" }))),
  );

  it.effect("continues a home-provider turn that was already running when it switched", () =>
    Effect.gen(function* () {
      yield* createBot();
      expect((yield* limitHit()).switched).toBe(true);
      const again = yield* limitHit();
      expect(again.switched).toBe(true);
      expect(yield* states).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("waits when the fallback itself reports the limit", () =>
    Effect.gen(function* () {
      yield* createBot();
      expect((yield* limitHit()).switched).toBe(true);
      const result = yield* limitHit({ instanceId: FALLBACK.instanceId });
      expect(result.switched).toBe(false);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("releases the bot's rate-limited tasks to run on the fallback", () =>
    Effect.gen(function* () {
      yield* createBot();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO personal_tasks (
          task_id, root_task_id, bot_id, title, objective, status, source,
          idempotency_key, depth, max_depth, max_children, available_at, created_at, updated_at
        ) VALUES (
          'task-1', 'task-1', ${BOT}, 'Waiting', 'wait out the limit', 'rate_limited', 'delegation',
          'key-1', 0, 3, 3, ${inOneHour()}, ${nowIso()}, ${nowIso()}
        )
      `;
      expect((yield* limitHit({ source: "task" })).switched).toBe(true);
      const rows = yield* sql<{ readonly availableAt: string }>`
        SELECT available_at AS "availableAt" FROM personal_tasks WHERE task_id = 'task-1'
      `;
      expect(Date.parse(rows[0]?.availableAt ?? "")).toBeLessThanOrEqual(Date.now() + 1000);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("switches back on the sweep once the reset has passed and the bot is idle", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      yield* createBot();
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      const fallback = yield* PersonalModelFallbackService.PersonalModelFallback;
      yield* repository.startFallback({
        botId: BOT,
        fallbackModel: FALLBACK,
        fromInstanceId: HOME.instanceId,
        fromProvider: "Codex",
        reason: null,
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now() - 3_600_000)),
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now() - 60_000)),
        noticeThreadId: null,
      } as never);
      expect(yield* states).toHaveLength(1);
      yield* fallback.sweep;
      expect(yield* states).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("leaves the row alone while the reset is still ahead", () =>
    Effect.gen(function* () {
      yield* createBot();
      expect((yield* limitHit()).switched).toBe(true);
      const fallback = yield* PersonalModelFallbackService.PersonalModelFallback;
      yield* fallback.sweep;
      expect(yield* states).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("ends a due row at the turn boundary, never mid-turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      yield* createBot();
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      const fallback = yield* PersonalModelFallbackService.PersonalModelFallback;
      const thread = ThreadId.make("thread-boundary");
      yield* repository.startFallback({
        botId: BOT,
        fallbackModel: FALLBACK,
        fromInstanceId: HOME.instanceId,
        fromProvider: "Codex",
        reason: null,
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now() - 3_600_000)),
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now() - 60_000)),
        noticeThreadId: null,
      } as never);
      yield* fallback.switchBackAtTurnBoundary({ botId: BOT, threadId: thread });
      expect(yield* states).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(ready))),
  );

  it.effect("moves a DeepSeek bot to Sonnet 5.5 High at 02:00 UTC when peakSwitch is on", () =>
    Effect.gen(function* () {
      yield* createBot({ modelSelection: DEEPSEEK_HOME });
      const fallback = yield* PersonalModelFallbackService.PersonalModelFallback;

      yield* fallback.sweep;

      const rows = yield* states;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe(PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK);
      expect(rows[0]?.fromInstanceId).toBe(DEEPSEEK_HOME.instanceId);
      expect(rows[0]?.fallbackModel).toEqual(PERSONAL_BOT_DEFAULT_FALLBACK_MODEL);
    }).pipe(
      Effect.provide(
        makeLayer(
          DEEPSEEK_READY,
          { PERSONAL_DEEPSEEK_PEAK_NOW: "2026-10-14T02:00:00Z" },
          PEAK_SETTINGS,
        ),
      ),
    ),
  );

  it.effect("takes the DeepSeek selection back at 12:00 UTC", () =>
    Effect.gen(function* () {
      yield* createBot({ modelSelection: DEEPSEEK_HOME });
      const repository = yield* PersonalBotRepository.PersonalBotRepository;
      const fallback = yield* PersonalModelFallbackService.PersonalModelFallback;
      yield* repository.startFallback({
        botId: BOT,
        fallbackModel: PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
        fromInstanceId: DEEPSEEK_HOME.instanceId,
        fromProvider: "DeepSeek",
        reason: PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.now() - 3_600_000)),
        resetAt: "2026-10-14T04:00:00.000Z",
        noticeThreadId: null,
      } as never);

      yield* fallback.sweep;

      expect(yield* states).toHaveLength(0);
      const bot = yield* repository.getBotById({ botId: BOT });
      expect(Option.getOrThrow(bot).modelSelection).toEqual(DEEPSEEK_HOME);
    }).pipe(
      Effect.provide(
        makeLayer(
          DEEPSEEK_READY,
          { PERSONAL_DEEPSEEK_PEAK_NOW: "2026-10-14T12:00:00Z" },
          PEAK_SETTINGS,
        ),
      ),
    ),
  );
});
