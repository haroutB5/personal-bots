import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PersonalBotId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { botModelSelectionForThread } from "./botModelSelection.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalChatResume from "./PersonalChatResumeService.ts";
import * as PersonalModelFallback from "./PersonalModelFallbackService.ts";
import {
  decideFallback,
  decideSwitchBack,
  FALLBACK_DEFAULT_HOLD_MS,
  FALLBACK_RECHECK_MS,
  FALLBACK_RESWITCH_COOLDOWN_MS,
  FALLBACK_SWITCH_BACK_GRACE_MS,
  fallbackModelLabel,
  limitPool,
  modelFallbackEnabledByEnv,
  usageRoom,
  type FallbackDecisionInput,
} from "./personalModelFallbackPolicy.ts";
import { PERSONAL_CHAT_FALLBACK_RESUME_PROMPT } from "./personalChatResumePolicy.ts";
import * as PersonalTaskService from "./tasks/PersonalTaskService.ts";

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const HOME: ModelSelection = {
  instanceId: CODEX,
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
} as ModelSelection;
const FALLBACK = PERSONAL_BOT_DEFAULT_FALLBACK_MODEL;
const NOW = Date.parse("2026-10-06T15:00:00.000Z");
const RESET = Date.parse("2026-10-06T17:40:00.000Z");

const usage = (windows: ReadonlyArray<{ id: string; used: number; resetsAt?: string }>) => ({
  checkedAt: isoAt(NOW),
  windows: windows.map((window) => ({
    id: window.id,
    kind: window.id.includes("seven") ? ("weekly" as const) : ("session" as const),
    label: window.id,
    usedPercent: window.used,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  })),
});

const snapshot = (
  instanceId: string,
  driver: string,
  limits?: ReturnType<typeof usage>,
): ServerProvider =>
  ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    ...(limits === undefined ? {} : { usageLimits: limits }),
  }) as unknown as ServerProvider;

const baseDecision = (patch: Partial<FallbackDecisionInput> = {}): FallbackDecisionInput => ({
  killSwitchOn: true,
  botFallbackEnabled: true,
  home: HOME,
  fallback: FALLBACK,
  onFallback: false,
  reason: "usage_limit",
  retryAtMs: RESET,
  nowMs: NOW,
  fallbackProvider: snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
  fallbackProviderReady: true,
  homeProvider: snapshot("codex", "codex"),
  ...patch,
});

describe("decideFallback", () => {
  it("switches when the fallback has room, with the reported reset", () => {
    expect(decideFallback(baseDecision())).toEqual({ kind: "switch", resetAtMs: RESET });
  });

  it("does nothing with the kill switch off, the bot switch off, or when already on the fallback", () => {
    expect(decideFallback(baseDecision({ killSwitchOn: false }))).toEqual({
      kind: "none",
      reason: "kill_switch",
    });
    expect(decideFallback(baseDecision({ botFallbackEnabled: false }))).toEqual({
      kind: "none",
      reason: "disabled",
    });
    expect(decideFallback(baseDecision({ onFallback: true }))).toEqual({
      kind: "none",
      reason: "already_on_fallback",
    });
  });

  it("does nothing when the fallback provider is limited too, missing or not ready", () => {
    const limited = snapshot(
      "claudeAgent",
      "claudeAgent",
      usage([{ id: "five_hour", used: 100, resetsAt: isoAt(NOW + 3600_000) }]),
    );
    expect(decideFallback(baseDecision({ fallbackProvider: limited }))).toEqual({
      kind: "none",
      reason: "fallback_limited",
    });
    expect(decideFallback(baseDecision({ fallbackProvider: undefined }))).toEqual({
      kind: "none",
      reason: "fallback_unavailable",
    });
    expect(decideFallback(baseDecision({ fallbackProviderReady: false }))).toEqual({
      kind: "none",
      reason: "fallback_unavailable",
    });
  });

  it("goes ahead when the fallback provider reports nothing, or only a lagging spent window", () => {
    expect(
      decideFallback(baseDecision({ fallbackProvider: snapshot("claudeAgent", "claudeAgent") }))
        .kind,
    ).toBe("switch");
    const lagging = snapshot(
      "claudeAgent",
      "claudeAgent",
      usage([{ id: "five_hour", used: 100, resetsAt: isoAt(NOW - 60_000) }]),
    );
    expect(decideFallback(baseDecision({ fallbackProvider: lagging })).kind).toBe("switch");
  });

  it("same provider and shared pool shares the limit; a model-specific limit can still switch families", () => {
    const opus: ModelSelection = { instanceId: CLAUDE, model: "claude-opus-5-5" } as ModelSelection;
    expect(decideFallback(baseDecision({ home: opus, reason: "five_hour" }))).toEqual({
      kind: "none",
      reason: "same_pool",
    });
    expect(decideFallback(baseDecision({ home: opus, reason: "seven_day_opus" })).kind).toBe(
      "switch",
    );
    // A Sonnet fallback is not helped by a Sonnet-only limit.
    expect(decideFallback(baseDecision({ home: opus, reason: "seven_day_sonnet" }))).toEqual({
      kind: "none",
      reason: "same_pool",
    });
    expect(decideFallback(baseDecision({ home: FALLBACK }))).toEqual({
      kind: "none",
      reason: "same_model",
    });
  });

  it("an Opus-only window does not block a Sonnet fallback", () => {
    const opusSpent = snapshot(
      "claudeAgent",
      "claudeAgent",
      usage([
        { id: "five_hour", used: 10 },
        { id: "seven_day_opus", used: 100, resetsAt: isoAt(NOW + 86_400_000) },
      ]),
    );
    expect(decideFallback(baseDecision({ fallbackProvider: opusSpent })).kind).toBe("switch");
  });

  it("takes the reset from the home provider's readings when the hit reports none", () => {
    const decision = decideFallback(
      baseDecision({
        retryAtMs: null,
        homeProvider: snapshot(
          "codex",
          "codex",
          usage([{ id: "primary", used: 100, resetsAt: isoAt(RESET) }]),
        ),
      }),
    );
    expect(decision).toEqual({ kind: "switch", resetAtMs: RESET });
    expect(decideFallback(baseDecision({ retryAtMs: null }))).toEqual({
      kind: "switch",
      resetAtMs: null,
    });
    // A reset beyond a weekly window is not believed.
    expect(decideFallback(baseDecision({ retryAtMs: NOW + 30 * 86_400_000 }))).toEqual({
      kind: "switch",
      resetAtMs: null,
    });
  });
});

describe("decideSwitchBack", () => {
  const base = {
    killSwitchOn: true,
    botFallbackEnabled: true,
    nowMs: RESET + FALLBACK_SWITCH_BACK_GRACE_MS + 1,
    startedAtMs: NOW,
    resetAtMs: RESET,
    home: HOME,
    homeProvider: snapshot("codex", "codex", usage([{ id: "primary", used: 5 }])),
    idle: true,
  } as const;

  it("waits for the reset, then goes back only when idle", () => {
    expect(decideSwitchBack({ ...base, nowMs: RESET - 1 })).toEqual({ kind: "wait" });
    expect(decideSwitchBack(base)).toEqual({ kind: "back", reason: "reset" });
    expect(decideSwitchBack({ ...base, idle: false })).toEqual({ kind: "wait" });
  });

  it("a reset the provider still reports as spent is extended, not trusted", () => {
    const later = RESET + 3600_000;
    const spent = snapshot(
      "codex",
      "codex",
      usage([{ id: "primary", used: 100, resetsAt: isoAt(later) }]),
    );
    expect(decideSwitchBack({ ...base, homeProvider: spent })).toEqual({
      kind: "extend",
      resetAtMs: later,
    });
  });

  it("with no reset reported it re-checks the readings, and holds a full window without any", () => {
    const noReset = { ...base, resetAtMs: null } as const;
    expect(decideSwitchBack({ ...noReset, nowMs: NOW + FALLBACK_RECHECK_MS - 1 })).toEqual({
      kind: "wait",
    });
    expect(decideSwitchBack({ ...noReset, nowMs: NOW + FALLBACK_RECHECK_MS })).toEqual({
      kind: "back",
      reason: "recheck",
    });
    const blind = { ...noReset, homeProvider: snapshot("codex", "codex") } as const;
    expect(decideSwitchBack({ ...blind, nowMs: NOW + FALLBACK_DEFAULT_HOLD_MS - 1 })).toEqual({
      kind: "wait",
    });
    expect(decideSwitchBack({ ...blind, nowMs: NOW + FALLBACK_DEFAULT_HOLD_MS })).toEqual({
      kind: "back",
      reason: "hold_over",
    });
  });

  it("switching the bot's setting or the kill switch off sends it back as soon as it is idle", () => {
    expect(decideSwitchBack({ ...base, nowMs: NOW, botFallbackEnabled: false })).toEqual({
      kind: "back",
      reason: "disabled",
    });
    expect(decideSwitchBack({ ...base, nowMs: NOW, killSwitchOn: false, idle: false })).toEqual({
      kind: "wait",
    });
  });
});

describe("helpers", () => {
  it("reads the kill switch", () => {
    expect(modelFallbackEnabledByEnv(undefined)).toBe(true);
    expect(modelFallbackEnabledByEnv("on")).toBe(true);
    for (const off of ["off", "OFF", " 0 ", "false", "no", "disabled"]) {
      expect(modelFallbackEnabledByEnv(off)).toBe(false);
    }
  });

  it("names pools, usage room and the short model label", () => {
    expect(limitPool("seven_day_opus")).toBe("opus");
    expect(limitPool("seven_day_sonnet")).toBe("sonnet");
    expect(limitPool("five_hour")).toBe("shared");
    expect(limitPool(undefined)).toBe("shared");
    expect(usageRoom(undefined, "claude-sonnet-5-5", NOW)).toEqual({
      room: true,
      known: false,
      resetsAtMs: null,
    });
    expect(fallbackModelLabel(FALLBACK)).toBe("Sonnet 5.5 · H");
    expect(fallbackModelLabel(HOME)).toBe("gpt-6.1-sol · H");
  });
});

// --- the service, over a real database ------------------------------------------

const BOT = PersonalBotId.make("bot-it");
const CHAT = ThreadId.make("chat-it-1");

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  providers: ServerProvider[];
  readonly refreshed: string[];
  readonly running: Set<string>;
  sequence: number;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  providers: [
    snapshot("codex", "codex", usage([{ id: "primary", used: 100, resetsAt: isoAt(RESET) }])),
    snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
  ],
  refreshed: [],
  running: new Set(),
  sequence: 0,
});

const makeLayer = (harness: Harness, env: Record<string, string> = {}) =>
  PersonalModelFallback.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            harness.dispatched.push(command);
            return { sequence: harness.dispatched.length };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.never),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.sync(() => harness.providers),
        refreshInstance: (instanceId: string) =>
          Effect.sync(() => {
            harness.refreshed.push(instanceId);
            return harness.providers;
          }),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    Layer.provideMerge(NodeServices.layer),
  );

const seedBot = (patch: { readonly fallbackEnabled?: boolean } = {}) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    yield* bots.createBot({
      botId: BOT,
      name: "IT",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: HOME,
      team: "assistant",
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      ...(patch.fallbackEnabled === undefined ? {} : { fallbackEnabled: patch.fallbackEnabled }),
    });
    yield* bots.insertThreadLink({
      botId: BOT,
      threadId: CHAT,
      createdAt: DateTime.makeUnsafe(NOW),
    });
    yield* sql`
      INSERT INTO projection_thread_sessions (thread_id, status, runtime_mode, updated_at)
      VALUES (${CHAT}, 'ready', 'full-access', ${isoAt(NOW)})
    `.pipe(Effect.ignore);
  });

const setBusy = (running: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE projection_thread_sessions SET status = ${running ? "running" : "ready"}
      WHERE thread_id = ${CHAT}
    `;
  });

const lines = (harness: Harness) =>
  harness.dispatched.flatMap((command) =>
    command.type === "thread.message.assistant.delta" ? [command.delta] : [],
  );

const hit = (patch: Partial<PersonalModelFallback.LimitHitInput> = {}) =>
  Effect.gen(function* () {
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    return yield* service.onLimitHit({
      botId: BOT,
      threadId: CHAT,
      source: "chat",
      instanceId: CODEX,
      providerName: "codex",
      reason: "usage_limit",
      retryAt: isoAt(RESET),
      ...patch,
    });
  });

it.effect(
  "a Codex limit moves the bot to Sonnet 5.5 High 1M, says so once, and keeps its home model",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const result = yield* hit();
      expect(result).toEqual({ switched: true, modelLabel: "Sonnet 5.5 · H" });

      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: BOT }));
      expect(bot.modelSelection).toEqual(HOME);
      expect(bot.fallbackActive?.modelSelection).toEqual(FALLBACK);
      expect(bot.fallbackActive?.fromProvider).toBe("Codex");
      expect(DateTime.toEpochMillis(bot.fallbackActive!.resetAt!)).toBe(RESET);

      // Every turn the server starts for this bot now runs on the fallback.
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);
      expect(yield* botModelSelectionForThread(bots, CHAT, HOME)).toEqual(FALLBACK);

      expect(lines(harness)).toEqual([
        "Codex hit its usage limit. IT is on Sonnet 5.5 · H until it resets (about 18:40).",
      ]);
      const delta = harness.dispatched[0] as Extract<
        OrchestrationCommand,
        { type: "thread.message.assistant.delta" }
      >;
      expect(delta.context?.records[0]).toMatchObject({
        kind: PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
        payload: { notice: "model-fallback-on", provider: "Codex" },
      });

      // The same limit seen again from a turn that was still running on Codex:
      // it continues on the fallback, and no second line is written.
      expect(yield* hit()).toEqual({ switched: true, modelLabel: "Sonnet 5.5 · H" });
      expect(lines(harness).length).toBe(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("waits as before when the fallback provider is limited too", () => {
  const harness = makeHarness();
  harness.providers = [
    snapshot("codex", "codex"),
    snapshot(
      "claudeAgent",
      "claudeAgent",
      usage([{ id: "five_hour", used: 100, resetsAt: isoAt(NOW + 3600_000) }]),
    ),
  ];
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    expect(yield* hit()).toEqual({ switched: false, skipped: "fallback_limited" });
    expect(
      Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
    ).toBeUndefined();
    expect(lines(harness)).toEqual([]);
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(HOME);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("waits as before when the bot's fallback switch is off", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot({ fallbackEnabled: false });
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    expect(yield* hit()).toEqual({ switched: false, skipped: "disabled" });
    expect(Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallback?.enabled).toBe(false);
    expect(lines(harness)).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("PERSONAL_MODEL_FALLBACK=off keeps every bot waiting", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    expect(yield* hit()).toEqual({ switched: false, skipped: "kill_switch" });
    expect(lines(harness)).toEqual([]);
  }).pipe(Effect.provide(makeLayer(harness, { PERSONAL_MODEL_FALLBACK: "off" })));
});

it.effect("an Opus bot on the shared Claude limit has nothing to switch to", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot();
    yield* bots.updateBot({
      botId: BOT,
      modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" } as ModelSelection,
      updatedAt: DateTime.makeUnsafe(NOW),
    });
    expect(yield* hit({ instanceId: CLAUDE, reason: "five_hour" })).toEqual({
      switched: false,
      skipped: "same_pool",
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("goes back only after the reset and only when the bot is idle, with one line", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* hit();
    expect(lines(harness).length).toBe(1);

    // Before the reset: stays.
    yield* TestClock.setTime(RESET - 60_000);
    yield* service.sweep;
    expect(Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive).toBeDefined();

    // The limit has reset, but the bot is in the middle of a turn: stays.
    harness.providers = [
      snapshot("codex", "codex", usage([{ id: "primary", used: 3 }])),
      snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
    ];
    yield* TestClock.setTime(RESET + FALLBACK_SWITCH_BACK_GRACE_MS + 1000);
    yield* setBusy(true);
    yield* service.sweep;
    expect(Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive).toBeDefined();
    expect(lines(harness).length).toBe(1);

    // Idle: back on its own model, after re-checking the provider once.
    yield* setBusy(false);
    yield* service.sweep;
    const bot = Option.getOrThrow(yield* bots.getBotById({ botId: BOT }));
    expect(bot.fallbackActive).toBeUndefined();
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(HOME);
    expect(harness.refreshed).toEqual(["codex"]);
    expect(lines(harness)).toEqual([
      "Codex hit its usage limit. IT is on Sonnet 5.5 · H until it resets (about 18:40).",
      "Codex usage limit has reset. IT is back on gpt-6.1-sol · H.",
    ]);

    // A limit straight after the switch back does not bounce it again at once.
    expect(yield* hit()).toEqual({ switched: false, skipped: "cooldown" });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a switch the cooldown holds back is logged with the bot, the reason and the seconds left",
  () => {
    const harness = makeHarness();
    const logs: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
    // `Effect.logInfo(text, fields)` hands the logger [text, fields].
    const logger = Logger.make<unknown, void>(({ fiber, message }) => {
      const [text, fields] = Array.isArray(message) ? message : [message, {}];
      logs.push({
        message: text,
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations), ...fields },
      });
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      yield* hit();
      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 3 }])),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
      ];
      yield* TestClock.setTime(RESET + FALLBACK_SWITCH_BACK_GRACE_MS + 1000);
      yield* service.sweep;
      logs.length = 0;

      // 20 s after the switch back: held, and the line says for how much longer.
      yield* TestClock.adjust(20_000);
      expect(yield* hit()).toEqual({ switched: false, skipped: "cooldown" });
      const held = logs.filter((line) => line.message === "personal model fallback not used");
      expect(held).toHaveLength(1);
      expect(held[0]!.annotations).toMatchObject({
        botId: BOT,
        source: "chat",
        reason: "cooldown",
        secondsLeft: Math.ceil((FALLBACK_RESWITCH_COOLDOWN_MS - 20_000) / 1000),
      });

      // A bot that does not exist is logged the same way, with no time left.
      logs.length = 0;
      yield* service.onLimitHit({
        botId: "bot-missing",
        threadId: CHAT,
        source: "task",
        instanceId: CODEX,
        providerName: "codex",
        reason: "usage_limit",
        retryAt: null,
      });
      expect(logs.map((line) => line.annotations)).toEqual([
        expect.objectContaining({ botId: "bot-missing", source: "task", reason: "no_bot" }),
      ]);
    }).pipe(
      Effect.provide(makeLayer(harness)),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  },
);

it.effect("a reset the provider still reports as spent moves the switch back later", () => {
  const harness = makeHarness();
  const later = RESET + 2 * 3600_000;
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* hit();
    harness.providers = [
      snapshot("codex", "codex", usage([{ id: "primary", used: 100, resetsAt: isoAt(later) }])),
      snapshot("claudeAgent", "claudeAgent"),
    ];
    yield* TestClock.setTime(RESET + 60_000);
    yield* service.sweep;
    const bot = Option.getOrThrow(yield* bots.getBotById({ botId: BOT }));
    expect(bot.fallbackActive).toBeDefined();
    expect(DateTime.toEpochMillis(bot.fallbackActive!.resetAt!)).toBe(later);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "turning the bot's switch off sends it back when idle; the state survives a restart",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      yield* hit();
      // The row is the state: a fresh service over the same database still sees it.
      expect((yield* bots.listFallbackStates()).map((state) => state.botId)).toEqual([BOT]);
      yield* bots.updateBot({
        botId: BOT,
        fallbackEnabled: false,
        updatedAt: DateTime.makeUnsafe(NOW),
      });
      yield* service.sweep;
      expect(
        Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
      ).toBeUndefined();
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("tasks waiting out the home limit run now on the fallback", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_tasks (
        task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
        depth, max_depth, max_children, error_category, available_at, created_at, updated_at
      )
      VALUES (
        'task-1', 'task-1', ${BOT}, 't', 'o', 'rate_limited', 'user', 'k1',
        0, 2, 5, 'rate_limited', ${isoAt(RESET)}, ${isoAt(NOW)}, ${isoAt(NOW)}
      )
    `;
    yield* hit({ source: "task" });
    const rows = yield* sql<{ readonly at: string | null }>`
      SELECT available_at AS "at" FROM personal_tasks WHERE task_id = 'task-1'
    `;
    expect(rows).toEqual([{ at: isoAt(NOW) }]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

// --- a chat that hits the limit continues on the fallback straight away -------------

const CHAT_INSTANCE_SESSION = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId: CHAT,
  status,
  providerName: "codex",
  providerInstanceId: CODEX,
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: "Codex usage limit reached.",
  providerRetry: {
    kind: "rate_limited",
    retryAt: isoAt(RESET),
    reason: "usage_limit",
    provider: "codex",
    observedAt: isoAt(NOW),
  },
  updatedAt: isoAt(NOW),
});

const makeChatLayer = (harness: Harness, env: Record<string, string> = {}) =>
  PersonalChatResume.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            Option.some({
              id: threadId,
              session: CHAT_INSTANCE_SESSION("error"),
              archivedAt: null,
              latestTurn: { turnId: TurnId.make("turn-1") },
              modelSelection: HOME,
              runtimeMode: "full-access",
              interactionMode: "default",
            }),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(PersonalTaskStub),
    Layer.provideMerge(makeLayer(harness, env)),
  );

const PersonalTaskStub = Layer.mock(PersonalTaskService.PersonalTaskService)({
  ownsThreadTurn: () => Effect.succeed(false),
  reserveExternalSlot: () => Effect.succeed(true),
  releaseExternalSlot: () => Effect.void,
});

const sessionEvent = (harness: Harness): OrchestrationEvent => {
  harness.sequence += 1;
  const id = `evt-${harness.sequence}`;
  return {
    sequence: harness.sequence,
    eventId: EventId.make(id),
    aggregateKind: "thread",
    aggregateId: CHAT,
    occurredAt: isoAt(NOW),
    commandId: CommandId.make(`cmd-${id}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-${id}`),
    metadata: {},
    type: "thread.session-set",
    payload: { threadId: CHAT, session: CHAT_INSTANCE_SESSION("error") },
  } as unknown as OrchestrationEvent;
};

it.effect("a chat turn stopped by a Codex limit continues on the fallback model at once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const sql = yield* SqlClient.SqlClient;
    const chat = yield* PersonalChatResume.PersonalChatResume;
    yield* chat.ingestDomainEvent(sessionEvent(harness));
    yield* chat.drain;

    const rows = yield* sql<{ readonly status: string; readonly fallback: number }>`
      SELECT status, fallback FROM personal_chat_resumes
    `;
    expect(rows).toEqual([{ status: "scheduled", fallback: 1 }]);
    // One muted line from the fallback, no "Paused" row.
    expect(lines(harness)).toEqual([
      "Codex hit its usage limit. IT is on Sonnet 5.5 · H until it resets (about 18:40).",
    ]);

    // The next sweep starts the continue, on the fallback model, with the fallback prompt.
    yield* TestClock.adjust("20 seconds");
    yield* chat.sweep;
    const start = harness.dispatched.find((command) => command.type === "thread.turn.start");
    expect(start).toBeDefined();
    const turn = start as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
    expect(turn.modelSelection).toEqual(FALLBACK);
    expect(turn.message.text).toBe(PERSONAL_CHAT_FALLBACK_RESUME_PROMPT);
    expect(turn.message.context?.records[0]).toMatchObject({
      payload: { notice: "model-fallback-resumed", provider: "Codex" },
    });
    const after = yield* sql<{ readonly status: string }>`SELECT status FROM personal_chat_resumes`;
    expect(after).toEqual([{ status: "resumed" }]);
  }).pipe(Effect.provide(makeChatLayer(harness)));
});

it.effect("a chat turn stopped by a limit waits for the reset when the fallback is off", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot({ fallbackEnabled: false });
    const sql = yield* SqlClient.SqlClient;
    const chat = yield* PersonalChatResume.PersonalChatResume;
    yield* chat.ingestDomainEvent(sessionEvent(harness));
    yield* chat.drain;
    const rows = yield* sql<{ readonly status: string; readonly fallback: number }>`
      SELECT status, fallback FROM personal_chat_resumes
    `;
    expect(rows).toEqual([{ status: "scheduled", fallback: 0 }]);
    expect(lines(harness)[0]).toMatch(/^Paused: Codex usage limit\. Continues at /);
    yield* TestClock.adjust("20 seconds");
    yield* chat.sweep;
    expect(harness.dispatched.some((command) => command.type === "thread.turn.start")).toBe(false);
  }).pipe(Effect.provide(makeChatLayer(harness)));
});

it.effect("a chat turn stopped by a limit waits when the fallback provider is limited too", () => {
  const harness = makeHarness();
  harness.providers = [
    snapshot("codex", "codex"),
    snapshot(
      "claudeAgent",
      "claudeAgent",
      usage([{ id: "seven_day", used: 100, resetsAt: isoAt(NOW + 86_400_000) }]),
    ),
  ];
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const sql = yield* SqlClient.SqlClient;
    const chat = yield* PersonalChatResume.PersonalChatResume;
    yield* chat.ingestDomainEvent(sessionEvent(harness));
    yield* chat.drain;
    const rows = yield* sql<{ readonly status: string; readonly fallback: number }>`
      SELECT status, fallback FROM personal_chat_resumes
    `;
    expect(rows).toEqual([{ status: "scheduled", fallback: 0 }]);
    expect(lines(harness)[0]).toMatch(/^Paused: Codex usage limit/);
  }).pipe(Effect.provide(makeChatLayer(harness)));
});

void MessageId;

it.effect("a fallback on the home provider never re-queues its own limit hits (no loop)", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    yield* seedBot();
    yield* bots.updateBot({
      botId: BOT,
      modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" } as ModelSelection,
      updatedAt: DateTime.makeUnsafe(NOW),
    });
    expect(yield* hit({ instanceId: CLAUDE, reason: "seven_day_opus" })).toEqual({
      switched: true,
      modelLabel: "Sonnet 5.5 · H",
    });
    // The Sonnet turn then hits the account's 5-hour limit: same instance, so it
    // waits for the reset instead of switching again or re-running at once.
    expect(yield* hit({ instanceId: CLAUDE, reason: "five_hour" })).toEqual({
      switched: false,
      skipped: "already_on_fallback",
    });
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a late hit from the home provider is no longer treated as in flight", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    yield* hit();
    yield* TestClock.setTime(NOW + 6 * 60_000);
    expect(yield* hit()).toEqual({ switched: false, skipped: "already_on_fallback" });
  }).pipe(Effect.provide(makeLayer(harness)));
});
