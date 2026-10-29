import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
  PERSONAL_FALLBACK_REASON_SCHEDULE,
  PersonalBotId,
  type PersonalBotSchedule,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ServerProvider,
  type ServerProviderUsageLimits,
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
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
} from "../provider/providerUsageLimits.ts";
import { codexRateLimitsToUpdate } from "../provider/Layers/codexUsageLimits.ts";
import * as ServerSettings from "../serverSettings.ts";
import { botModelSelectionForThread } from "./botModelSelection.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalChatResume from "./PersonalChatResumeService.ts";
import * as PersonalModelFallback from "./PersonalModelFallbackService.ts";
import {
  decideFallback,
  decideSwitchBack,
  FALLBACK_CAPACITY_HOLD_MS,
  FALLBACK_DEFAULT_HOLD_MS,
  FALLBACK_RECHECK_MS,
  FALLBACK_RESWITCH_COOLDOWN_MS,
  FALLBACK_SWITCH_BACK_GRACE_MS,
  fallbackModelLabel,
  limitPool,
  modelFallbackEnabledByEnv,
  usageRoom,
  type FallbackDecisionInput,
  type SwitchBackInput,
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
  fullReadAt: isoAt(NOW),
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
  limits?: ServerProviderUsageLimits,
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

  it("a capacity hit holds the fallback for a short window, not a whole reset", () => {
    expect(decideFallback(baseDecision({ retryAtMs: null, capacityHit: true }))).toEqual({
      kind: "switch",
      resetAtMs: NOW + FALLBACK_CAPACITY_HOLD_MS,
    });
    // A reset the provider did report still wins.
    expect(decideFallback(baseDecision({ capacityHit: true }))).toEqual({
      kind: "switch",
      resetAtMs: RESET,
    });
  });

  it("a capacity hit may switch to another model on the same provider", () => {
    const other = { instanceId: HOME.instanceId, model: "opencode/glm-5" } as ModelSelection;
    expect(
      decideFallback(baseDecision({ home: HOME, fallback: other, capacityHit: true })).kind,
    ).toBe("switch");
    expect(decideFallback(baseDecision({ home: HOME, fallback: other }))).toEqual({
      kind: "none",
      reason: "same_pool",
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

  it("a capacity hold is a fixed wait that healthy usage readings cannot cut short", () => {
    const at = NOW + 60_000;
    const recovered = {
      ...usage([{ id: "primary", used: 4 }]),
      checkedAt: isoAt(at),
      fullReadAt: isoAt(at),
    };
    const capacity = {
      ...base,
      nowMs: at,
      resetAtMs: NOW + FALLBACK_CAPACITY_HOLD_MS,
      capacityHit: true,
      recoveryProviderReady: true,
      freshAfterMs: NOW,
      homeProvider: snapshot("codex", "codex", recovered),
    } as const;
    // Without the flag this same input is an early recovery: usage is healthy.
    expect(decideSwitchBack({ ...capacity, capacityHit: false })).toEqual({
      kind: "back",
      reason: "recovered",
    });
    // A capacity hit spent nothing, so a roomy account proves nothing about the
    // model serving again: the hold, not the reading, decides.
    expect(decideSwitchBack(capacity)).toEqual({ kind: "wait" });
    const ended = NOW + FALLBACK_CAPACITY_HOLD_MS + FALLBACK_SWITCH_BACK_GRACE_MS;
    expect(decideSwitchBack({ ...capacity, nowMs: ended - 1 })).toEqual({ kind: "wait" });
    expect(decideSwitchBack({ ...capacity, nowMs: ended })).toEqual({
      kind: "back",
      reason: "reset",
    });
    expect(decideSwitchBack({ ...capacity, nowMs: ended, idle: false })).toEqual({ kind: "wait" });
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

describe("confirmed early recovery", () => {
  const now = NOW + 60_000;
  const recovered = {
    ...usage([{ id: "primary", used: 5 }]),
    checkedAt: isoAt(now),
    fullReadAt: isoAt(now),
  };
  const base: SwitchBackInput = {
    killSwitchOn: true,
    botFallbackEnabled: true,
    nowMs: now,
    startedAtMs: NOW,
    resetAtMs: RESET,
    home: HOME,
    idle: true,
    recoveryProviderReady: true,
    freshAfterMs: NOW,
    homeProvider: snapshot("codex", "codex", recovered),
  };
  it("overrides a future reset only at idle, including unreported resets", () => {
    expect(decideSwitchBack(base)).toEqual({ kind: "back", reason: "recovered" });
    expect(decideSwitchBack({ ...base, idle: false })).toEqual({ kind: "wait" });
    expect(decideSwitchBack({ ...base, resetAtMs: null })).toEqual({
      kind: "back",
      reason: "recovered",
    });
  });
  it("rejects stale, failed, unavailable, missing, future and pre-hit readings", () => {
    for (const limits of [
      undefined,
      { ...recovered, fullReadAt: undefined },
      { ...recovered, fullReadAt: isoAt(NOW) },
      { ...recovered, checkedAt: isoAt(NOW) },
      { ...recovered, checkedAt: isoAt(now + 1) },
      { ...recovered, checkedAt: "invalid" },
      { ...recovered, refreshFailed: { at: isoAt(now) } },
      { ...recovered, unavailable: { reason: "probeFailed" as const } },
      { ...recovered, windows: [] },
    ]) {
      expect(decideSwitchBack({ ...base, homeProvider: { usageLimits: limits } })).toEqual({
        kind: "wait",
      });
    }
    expect(decideSwitchBack({ ...base, nowMs: now + 120_001 })).toEqual({ kind: "wait" });
    expect(decideSwitchBack({ ...base, recoveryProviderReady: false })).toEqual({ kind: "wait" });
  });
  it("requires explicit room in the exhausted pool; expired spent windows are not early recovery", () => {
    for (const windows of [
      [{ id: "primary", used: 100, resetsAt: isoAt(NOW - 1) }],
      [
        { id: "primary", used: 5 },
        { id: "secondary", used: 100 },
      ],
      [{ id: "seven_day_sonnet", used: 5 }],
    ]) {
      expect(
        decideSwitchBack({
          ...base,
          homeProvider: {
            usageLimits: { ...usage(windows), checkedAt: isoAt(now), fullReadAt: isoAt(now) },
          },
        }),
      ).toEqual({ kind: "wait" });
    }
    const opus = {
      ...base,
      home: { instanceId: CLAUDE, model: "claude-opus-5-5" } as ModelSelection,
      limitReason: "seven_day_opus",
    };
    expect(
      decideSwitchBack({
        ...opus,
        homeProvider: {
          usageLimits: {
            ...usage([{ id: "five_hour", used: 5 }]),
            checkedAt: isoAt(now),
            fullReadAt: isoAt(now),
          },
        },
      }),
    ).toEqual({ kind: "wait" });
    expect(
      decideSwitchBack({
        ...opus,
        homeProvider: {
          usageLimits: {
            ...usage([
              { id: "five_hour", used: 5 },
              { id: "seven_day_opus", used: 5 },
              { id: "seven_day_sonnet", used: 100 },
            ]),
            checkedAt: isoAt(now),
            fullReadAt: isoAt(now),
          },
        },
      }),
    ).toEqual({ kind: "back", reason: "recovered" });
  });
});

// --- the service, over a real database ------------------------------------------

it.effect("sparse runtime updates cannot wake waiting work; a full probe recovers once", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    yield* hit();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* sql`INSERT INTO personal_tasks (
      task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
      depth, max_depth, max_children, available_at, created_at, updated_at, thread_id
    ) VALUES ('sparse-wait', 'sparse-wait', ${BOT}, 't', 'o', 'rate_limited', 'user',
      'sparse-wait', 0, 2, 5, ${isoAt(RESET)}, ${isoAt(NOW)}, ${isoAt(NOW)}, ${CHAT})`;
    const at = NOW + 60_000;
    yield* TestClock.setTime(at);
    const stale = resolveUsageLimitsAfterProbe({
      published: usage([
        { id: "primary", used: 20 },
        { id: "secondary", used: 5 },
      ]),
      probed: undefined,
      context: { checkedAt: isoAt(at), message: "test probe failed" },
    });
    const update = codexRateLimitsToUpdate({
      limitId: "codex",
      primary: { usedPercent: 21, windowDurationMins: 300 },
    })!;
    const merged = applyUsageLimitsUpdate({ previous: stale, update, checkedAt: isoAt(at) });
    harness.providers = [snapshot("codex", "codex", merged)];
    yield* service.sweep;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(1);
    expect(
      yield* sql`SELECT available_at FROM personal_tasks WHERE task_id = 'sparse-wait'`,
    ).toEqual([{ available_at: isoAt(RESET) }]);
    expect(merged?.windows.find((window) => window.id === "secondary")?.usedPercent).toBe(5);
    expect(merged?.fullReadAt).toBeUndefined();

    const full = resolveUsageLimitsAfterProbe({
      published: merged,
      probed: {
        ...usage([
          { id: "primary", used: 21 },
          { id: "secondary", used: 5 },
        ]),
        checkedAt: isoAt(at),
      },
    });
    harness.providers = [snapshot("codex", "codex", full)];
    yield* service.sweep;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
    expect(
      yield* sql`SELECT available_at FROM personal_tasks WHERE task_id = 'sparse-wait'`,
    ).toEqual([{ available_at: isoAt(at) }]);
    expect(lines(harness)).toHaveLength(2);
  }).pipe(Effect.provide(makeLayer(harness)));
});

const BOT = PersonalBotId.make("bot-it");
const CHAT = ThreadId.make("chat-it-1");

interface Harness {
  readonly dispatched: Array<OrchestrationCommand>;
  providers: ServerProvider[];
  readonly refreshed: string[];
  /** Instances whose cached usage read was dropped before a re-probe. */
  readonly invalidated: string[];
  readonly running: Set<string>;
  sequence: number;
  onRefresh?: () => void;
}

const makeHarness = (): Harness => ({
  dispatched: [],
  providers: [
    snapshot("codex", "codex", usage([{ id: "primary", used: 100, resetsAt: isoAt(RESET) }])),
    snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
  ],
  refreshed: [],
  invalidated: [],
  running: new Set(),
  sequence: 0,
});

const makeLayer = (
  harness: Harness,
  env: Record<string, string> = {},
  /** DeepSeek peak switch tests: the instance's own "during peak hours" setting. */
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  PersonalModelFallback.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
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
            harness.onRefresh?.();
            return harness.providers;
          }),
        invalidateUsage: (instanceId: string) =>
          Effect.sync(() => {
            harness.invalidated.push(instanceId);
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
  "a reset that passed while a task runs switches the task's next turn back, never the running one",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* hit();
      yield* sql`INSERT INTO personal_tasks (
        task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
        depth, max_depth, max_children, available_at, created_at, updated_at, thread_id
      ) VALUES ('busy-task', 'busy-task', ${BOT}, 't', 'o', 'running', 'user',
        'busy-task', 0, 2, 5, ${isoAt(NOW)}, ${isoAt(NOW)}, ${isoAt(NOW)}, ${CHAT})`;

      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 3 }])),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
      ];
      yield* TestClock.setTime(RESET + FALLBACK_SWITCH_BACK_GRACE_MS + 1000);

      // The chat's turn is still running: the selection does not change mid-turn.
      yield* setBusy(true);
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);
      expect(
        Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
      ).toBeDefined();

      // Between the task's turns: the next turn starts on the bot's own model,
      // the row is gone, and the task itself is still running.
      yield* setBusy(false);
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(HOME);
      expect(
        Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
      ).toBeUndefined();
      expect(
        (yield* bots.listBots()).find((bot) => bot.botId === BOT)?.fallbackActive,
      ).toBeUndefined();
      expect(
        yield* sql<{ readonly status: string }>`
          SELECT status FROM personal_tasks WHERE task_id = 'busy-task'
        `,
      ).toEqual([{ status: "running" }]);
      expect(lines(harness)).toEqual([
        "Codex hit its usage limit. IT is on Sonnet 5.5 · H until it resets (about 18:40).",
        "Codex usage limit has reset. IT is back on gpt-6.1-sol · H.",
      ]);

      // A limit straight after the boundary switch back does not bounce it again.
      expect(yield* hit()).toEqual({ switched: false, skipped: "cooldown" });
      // Once the guard has passed, a real re-hit falls back again.
      yield* TestClock.adjust(FALLBACK_RESWITCH_COOLDOWN_MS + 1000);
      const reopenedAt = yield* DateTime.now;
      const laterReset = isoAt(DateTime.toEpochMillis(reopenedAt) + 3 * 3600_000);
      expect(yield* hit({ retryAt: laterReset })).toEqual({
        switched: true,
        modelLabel: "Sonnet 5.5 · H",
      });
      expect(
        Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
      ).toBeDefined();
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("the early-reset probe clears the row at the next turn boundary", () => {
  const harness = makeHarness();
  const recoveredAt = NOW + 60_000;
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* hit();
    yield* sql`INSERT INTO personal_tasks (
      task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
      depth, max_depth, max_children, available_at, created_at, updated_at, thread_id
    ) VALUES ('probe-task', 'probe-task', ${BOT}, 't', 'o', 'running', 'user',
      'probe-task', 0, 2, 5, ${isoAt(NOW)}, ${isoAt(NOW)}, ${isoAt(NOW)}, ${CHAT})`;

    // The provider resets before the recorded reset time; the sweep's own
    // re-probe (bounded to every 2 minutes) is the proof.
    harness.onRefresh = () => {
      harness.providers = [
        snapshot("codex", "codex", {
          ...usage([{ id: "primary", used: 3 }]),
          checkedAt: isoAt(recoveredAt),
          fullReadAt: isoAt(recoveredAt),
        }),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
      ];
    };
    yield* TestClock.setTime(recoveredAt);
    yield* setBusy(true);
    yield* service.sweep;
    expect(harness.refreshed).toContain("codex");
    // Mid-turn the sweep leaves the row; the next boundary ends it.
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);
    yield* setBusy(false);
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(HOME);
    expect(
      Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
    ).toBeUndefined();
    expect(lines(harness).at(-1)).toBe(
      "Codex usage limit has reset. IT is back on gpt-6.1-sol · H.",
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a schedule or peak row keeps its idle-gated switch back", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const base = {
      botId: BOT,
      fallbackModel: FALLBACK,
      fromInstanceId: CODEX,
      fromProvider: "Codex",
      startedAt: isoAt(NOW),
      resetAt: isoAt(RESET),
      noticeThreadId: null,
    };
    yield* bots.startFallback({ ...base, reason: PERSONAL_FALLBACK_REASON_SCHEDULE });
    yield* TestClock.setTime(RESET + FALLBACK_SWITCH_BACK_GRACE_MS + 1000);
    yield* setBusy(false);
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);
    expect(Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive?.reason).toBe(
      PERSONAL_FALLBACK_REASON_SCHEDULE,
    );

    yield* bots.switchFallback({ ...base, reason: PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK });
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);
    expect(Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive?.reason).toBe(
      PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
    );
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a capacity hit keeps its whole 15-minute hold, then says the model is available again",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      // A capacity hit spends nothing: the account has room, the model does not serve.
      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 40 }])),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
      ];
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      expect(
        yield* hit({
          retryAt: null,
          capacity: true,
          reason: "Selected model is at capacity. Please try a different model.",
        }),
      ).toEqual({ switched: true, modelLabel: "Sonnet 5.5 · H" });
      const state = Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive;
      expect(DateTime.toEpochMillis(state!.resetAt!)).toBe(NOW + FALLBACK_CAPACITY_HOLD_MS);
      expect(lines(harness)).toHaveLength(1);
      expect(lines(harness)[0]).toContain(
        "Codex is at capacity. IT is on Sonnet 5.5 · H until about ",
      );

      // Healthy usage one minute in: not proof that the model serves again.
      const at = NOW + 60_000;
      const recovered = {
        ...usage([{ id: "primary", used: 4 }]),
        checkedAt: isoAt(at),
        fullReadAt: isoAt(at),
      };
      harness.providers = [
        snapshot("codex", "codex", recovered),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
      ];
      yield* TestClock.setTime(at);
      yield* service.sweep;
      expect(
        Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
      ).toBeDefined();
      expect(lines(harness)).toHaveLength(1);

      // The hold itself ends the fallback, and the line says available again.
      const ended = NOW + FALLBACK_CAPACITY_HOLD_MS + FALLBACK_SWITCH_BACK_GRACE_MS;
      const later = { ...recovered, checkedAt: isoAt(ended), fullReadAt: isoAt(ended) };
      harness.providers = [
        snapshot("codex", "codex", later),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }])),
      ];
      yield* TestClock.setTime(ended);
      yield* service.sweep;
      expect(
        Option.getOrThrow(yield* bots.getBotById({ botId: BOT })).fallbackActive,
      ).toBeUndefined();
      const notices = lines(harness);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toContain("Codex is at capacity.");
      expect(notices[1]).toBe("Codex is available again. IT is back on gpt-6.1-sol · H.");
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

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
        botId: PersonalBotId.make("bot-missing"),
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
      Effect.provide(
        Layer.merge(makeLayer(harness), Logger.layer([logger], { mergeWithExisting: false })),
      ),
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

it.effect("a second chat's hit while the bot is already on its fallback runs there", () => {
  const harness = makeHarness();
  const other = ThreadId.make("chat-it-2");
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    expect(yield* hit()).toEqual({ switched: true, modelLabel: "Sonnet 5.5 · H" });
    // The chat that was switched: an unnamed hit is its own fallback turn
    // reporting the fallback's limit, so it waits.
    expect(yield* hit({ instanceId: undefined })).toEqual({
      switched: false,
      skipped: "already_on_fallback",
    });
    // The second chat's turn started before the row existed and died on the
    // home limit: the bot is already on the fallback, so the work runs there
    // instead of pausing until the reset.
    expect(yield* hit({ threadId: other, source: "task" })).toEqual({
      switched: true,
      modelLabel: "Sonnet 5.5 · H",
    });
    // The provider named no instance (the failed turn settled before its
    // session recorded one): the row is trusted once for that.
    expect(yield* hit({ threadId: other, source: "task", instanceId: undefined })).toEqual({
      switched: true,
      modelLabel: "Sonnet 5.5 · H",
    });
    // A second unnamed hit on the same row is not trusted again: the fallback
    // itself may be the model that is out of room, and retrying would loop.
    expect(yield* hit({ threadId: other, source: "task", instanceId: undefined })).toEqual({
      switched: false,
      skipped: "already_on_fallback",
    });
    // A hit from the fallback's own instance means both models are spent.
    expect(yield* hit({ threadId: other, source: "task", instanceId: CLAUDE })).toEqual({
      switched: false,
      skipped: "already_on_fallback",
    });
    expect(yield* bots.listFallbackStates()).toHaveLength(1);
    // One chat line for the switch, none for the hits that continued on it.
    expect(lines(harness)).toHaveLength(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a re-stamped pre-hit reading cannot end the row; the probe drops the cache first",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      yield* hit();
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      const claude = harness.providers[1]!;
      const at = NOW + 20_000;
      // The driver's 5-minute cache: the answer from before the hit, stamped
      // fresh every time it is handed back. A real re-probe says 100%.
      const cached = snapshot("codex", "codex", {
        ...usage([{ id: "primary", used: 10, resetsAt: isoAt(RESET + 3_600_000) }]),
        checkedAt: isoAt(at),
        fullReadAt: isoAt(at),
      });
      harness.providers = [cached, claude];
      harness.onRefresh = () => {
        const probed = harness.invalidated.includes("codex");
        harness.providers = [
          probed
            ? snapshot("codex", "codex", {
                ...usage([{ id: "primary", used: 100, resetsAt: isoAt(RESET) }]),
                checkedAt: isoAt(at),
                fullReadAt: isoAt(at),
              })
            : cached,
          claude,
        ];
      };
      yield* TestClock.setTime(at);
      yield* service.sweep;
      expect(harness.invalidated).toContain("codex");
      expect(harness.refreshed).toContain("codex");
      // The cached answer reads 10% and looks fresh, but the limit has not reset:
      // the row stays.
      expect(yield* bots.listFallbackStates()).toHaveLength(1);
      expect(lines(harness)).toHaveLength(1);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("recovery isolates old provider waits and rolls back a failed wake", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    yield* hit();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* bots.insertThreadLink({
      botId: BOT,
      threadId: ThreadId.make("chat-other-account"),
      createdAt: DateTime.makeUnsafe(NOW),
    });
    yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, runtime_mode, updated_at, provider_instance_id)
      VALUES ('chat-other-account', 'error', 'full-access', ${isoAt(NOW)}, 'other-account')`;
    yield* sql`INSERT INTO personal_chat_resumes (resume_id, thread_id, hit_key, provider, hit_at, resume_at, status)
      VALUES ('own-wait', ${CHAT}, 'own-wait', 'claudeAgent', ${isoAt(NOW)}, ${isoAt(RESET)}, 'scheduled'),
      ('other-wait', 'chat-other-account', 'other-wait', 'codex', ${isoAt(NOW)}, ${isoAt(RESET)}, 'scheduled')`;
    yield* sql`INSERT INTO personal_tasks (
      task_id, root_task_id, bot_id, title, objective, status, source, idempotency_key,
      depth, max_depth, max_children, available_at, created_at, updated_at, thread_id
    ) VALUES
      ('own-task', 'own-task', ${BOT}, 't', 'o', 'rate_limited', 'user', 'own-task', 0, 2, 5, ${isoAt(RESET)}, ${isoAt(NOW)}, ${isoAt(NOW)}, ${CHAT}),
      ('other-task', 'other-task', ${BOT}, 't', 'o', 'rate_limited', 'user', 'other-task', 0, 2, 5, ${isoAt(RESET)}, ${isoAt(NOW)}, ${isoAt(NOW)}, 'chat-other-account')`;
    const at = NOW + 60_000;
    yield* TestClock.setTime(at);
    harness.providers = [
      snapshot("codex", "codex", {
        ...usage([{ id: "primary", used: 5 }]),
        checkedAt: isoAt(at),
        fullReadAt: isoAt(at),
      }),
    ];
    yield* sql.unsafe(
      "CREATE TRIGGER fail_recovery_wake BEFORE UPDATE ON personal_chat_resumes BEGIN SELECT RAISE(ABORT, 'test wake failure'); END",
    );
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(1);
    expect(yield* sql`SELECT available_at FROM personal_tasks WHERE task_id = 'own-task'`).toEqual([
      { available_at: isoAt(RESET) },
    ]);
    yield* sql.unsafe("DROP TRIGGER fail_recovery_wake");
    yield* service.sweep;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
    expect(yield* sql`SELECT task_id, available_at FROM personal_tasks ORDER BY task_id`).toEqual([
      { task_id: "other-task", available_at: isoAt(RESET) },
      { task_id: "own-task", available_at: isoAt(at) },
    ]);
    expect(
      yield* sql`SELECT resume_id, resume_at FROM personal_chat_resumes ORDER BY resume_id`,
    ).toEqual([
      { resume_id: "other-wait", resume_at: isoAt(RESET) },
      { resume_id: "own-wait", resume_at: isoAt(at) },
    ]);
  }).pipe(Effect.provide(makeLayer(harness)));
});

for (const provider of ["codex", "claudeAgent"] as const) {
  it.effect(
    `${provider} early redemption is found by a probe despite a future reset; busy waits, idle returns once`,
    () => {
      const harness = makeHarness();
      const home = provider === "codex" ? HOME : FALLBACK;
      const fallback = provider === "codex" ? FALLBACK : HOME;
      const recoveryAt = NOW + 60_000;
      return Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        yield* seedBot();
        const bots = yield* PersonalBotRepository.PersonalBotRepository;
        yield* bots.updateBot({
          botId: BOT,
          modelSelection: home,
          fallbackModelSelection: fallback,
          updatedAt: DateTime.makeUnsafe(NOW),
        });
        yield* bots.startFallback({
          botId: BOT,
          fallbackModel: fallback,
          fromInstanceId: home.instanceId,
          fromProvider: provider,
          reason: "usage_limit",
          startedAt: isoAt(NOW),
          resetAt: isoAt(RESET),
          noticeThreadId: CHAT,
        });
        const service = yield* PersonalModelFallback.PersonalModelFallback;
        harness.providers = [
          snapshot(
            home.instanceId,
            provider,
            usage([{ id: "primary", used: 100, resetsAt: isoAt(RESET) }]),
          ),
        ];
        harness.onRefresh = () => {
          harness.providers = [
            snapshot(home.instanceId, provider, {
              ...usage([{ id: "primary", used: 5 }]),
              checkedAt: isoAt(recoveryAt),
              fullReadAt: isoAt(recoveryAt),
            }),
          ];
        };
        yield* TestClock.setTime(recoveryAt);
        yield* setBusy(true);
        yield* service.sweep;
        expect(harness.refreshed).toEqual([home.instanceId]);
        expect(yield* bots.listFallbackStates()).toHaveLength(1);
        yield* setBusy(false);
        yield* service.sweep;
        yield* service.sweep;
        expect(yield* bots.listFallbackStates()).toHaveLength(0);
        expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(home);
        expect(lines(harness)).toHaveLength(1);
        expect(yield* hit({ instanceId: home.instanceId })).toMatchObject({ skipped: "cooldown" });
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );
}

it.effect("stale or unavailable primary and another account's recovery keep the fallback", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedBot();
    yield* hit();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    const at = NOW + 60_000;
    yield* TestClock.setTime(at);
    const fresh = {
      ...usage([{ id: "primary", used: 5 }]),
      checkedAt: isoAt(at),
      fullReadAt: isoAt(at),
    };
    for (const own of [
      undefined,
      usage([{ id: "primary", used: 5 }]),
      { ...fresh, refreshFailed: { at: isoAt(at) } },
      { ...fresh, unavailable: { reason: "unsupported" as const } },
      {
        ...fresh,
        windows: [
          {
            id: "primary",
            kind: "weekly" as const,
            label: "primary",
            usedPercent: 100,
            resetsAt: isoAt(RESET),
          },
        ],
      },
    ]) {
      harness.providers = [
        snapshot("codex", "codex", own),
        snapshot("other-account", "codex", fresh),
      ];
      yield* service.sweep;
      expect(yield* bots.listFallbackStates()).toHaveLength(1);
    }
    expect(lines(harness)).toHaveLength(1);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a chat parked on the exhausted fallback resumes exactly once on the recovered primary",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seedBot();
      yield* hit();
      const sql = yield* SqlClient.SqlClient;
      const fallback = yield* PersonalModelFallback.PersonalModelFallback;
      const chat = yield* PersonalChatResume.PersonalChatResume;
      yield* sql`
      INSERT INTO personal_chat_resumes (resume_id, thread_id, hit_key, provider, hit_at, resume_at, status, fallback)
      VALUES ('fallback-wait', ${CHAT}, 'fallback-wait', 'claudeAgent', ${isoAt(NOW)}, ${isoAt(RESET)}, 'scheduled', 0)
    `;
      yield* sql`UPDATE projection_thread_sessions SET provider_instance_id = 'claudeAgent' WHERE thread_id = ${CHAT}`;
      const at = NOW + 60_000;
      yield* TestClock.setTime(at);
      harness.providers = [
        snapshot("codex", "codex", {
          ...usage([{ id: "primary", used: 5 }]),
          checkedAt: isoAt(at),
          fullReadAt: isoAt(at),
        }),
      ];
      yield* fallback.sweep;
      yield* chat.sweep;
      yield* fallback.sweep;
      yield* chat.sweep;
      const starts = harness.dispatched.filter((command) => command.type === "thread.turn.start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.modelSelection).toEqual(HOME);
      expect(
        yield* sql`SELECT status FROM personal_chat_resumes WHERE resume_id = 'fallback-wait'`,
      ).toEqual([{ status: "resumed" }]);
    }).pipe(Effect.provide(makeChatLayer(harness)));
  },
);

// --- the DeepSeek peak-hours switch (1.66.44) ------------------------------------

const DEEPSEEK = ProviderInstanceId.make("deepseek");
const CODEX_DS_FALLBACK: ModelSelection = {
  instanceId: CODEX,
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
} as ModelSelection;
const DS_HOME: ModelSelection = {
  instanceId: DEEPSEEK,
  model: "deepseek-flash",
} as ModelSelection;

/** Thursday 15 October 2026: 02:00 UTC is inside the 01:00-04:00 window. */
const PEAK_AT = Date.parse("2026-10-15T02:00:00.000Z");
const PEAK_ENDS = Date.parse("2026-10-15T04:00:00.000Z");
/** The second window of the same day, 06:00-10:00 UTC. */
const LATER_PEAK_AT = Date.parse("2026-10-15T07:15:00.000Z");
const LATER_PEAK_ENDS = Date.parse("2026-10-15T10:00:00.000Z");
const OFF_PEAK_AT = Date.parse("2026-10-15T11:30:00.000Z");
const SATURDAY_AT = Date.parse("2026-10-17T02:00:00.000Z");

const READY_CLAUDE = () =>
  snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 20 }]));

/** A DeepSeek bot, optionally with a fallback of its own, on the shared chat. */
const seedDeepSeekBot = (
  patch: {
    readonly botId?: PersonalBotId;
    readonly threadId?: ThreadId;
    readonly fallbackModelSelection?: ModelSelection;
  } = {},
) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const botId = patch.botId ?? BOT;
    const threadId = patch.threadId ?? CHAT;
    yield* bots.createBot({
      botId,
      name: "DS",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: DS_HOME,
      team: "assistant",
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      ...(patch.fallbackModelSelection === undefined
        ? {}
        : { fallbackModelSelection: patch.fallbackModelSelection }),
    });
    yield* bots.insertThreadLink({
      botId,
      threadId,
      createdAt: DateTime.makeUnsafe(NOW),
    });
    yield* sql`
      INSERT INTO projection_thread_sessions (thread_id, status, runtime_mode, updated_at)
      VALUES (${threadId}, 'ready', 'full-access', ${isoAt(NOW)})
    `.pipe(Effect.ignore);
  });

const peakState = (states: ReadonlyArray<PersonalBotRepository.PersonalBotFallbackState>) =>
  states.find((state) => state.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK);

it.effect(
  "moves a DeepSeek bot to Sonnet 5.5 High in a peak window and back when it closes",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(PEAK_AT);
      yield* seedDeepSeekBot();
      harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;

      yield* service.sweep;
      const state = peakState(yield* bots.listFallbackStates());
      expect(state).toBeDefined();
      expect(state!.fallbackModel).toEqual(FALLBACK);
      expect(state!.fromInstanceId).toBe(DEEPSEEK);
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(state!.resetAt!))).toBe(PEAK_ENDS);
      // Every turn the server starts reads it, so a new chat, task or routine
      // turn runs on the peak model too.
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);
      // The bot's own model is untouched.
      const bot = Option.getOrThrow(yield* bots.getBotById({ botId: BOT }));
      expect(bot.modelSelection).toEqual(DS_HOME);

      // The second window of the day moves the end time, without a second row.
      yield* TestClock.setTime(LATER_PEAK_AT);
      yield* service.sweep;
      const updated = peakState(yield* bots.listFallbackStates());
      expect(yield* bots.listFallbackStates()).toHaveLength(1);
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(updated!.resetAt!))).toBe(LATER_PEAK_ENDS);

      // Off-peak and idle: back to DeepSeek.
      yield* TestClock.setTime(OFF_PEAK_AT);
      yield* service.sweep;
      expect(yield* bots.listFallbackStates()).toHaveLength(0);
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(DS_HOME);
      expect(lines(harness)).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("never cuts a running turn: the switch back waits for the bot to be idle", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(PEAK_AT);
    yield* seedDeepSeekBot();
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(peakState(yield* bots.listFallbackStates())).toBeDefined();

    // The window closes while a turn is still running: the row stays, so that
    // turn finishes where it is.
    yield* setBusy(true);
    yield* TestClock.setTime(OFF_PEAK_AT);
    yield* service.sweep;
    expect(peakState(yield* bots.listFallbackStates())).toBeDefined();

    // Once it is idle the bot moves back.
    yield* setBusy(false);
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect(
  "a restart inside a window keeps bots on the peak model, and off-peak clears them",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(PEAK_AT);
      yield* seedDeepSeekBot();
      harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;

      // The row a previous run left behind is the whole state: nothing is kept in
      // memory, so the first sweep after a restart decides from the clock alone.
      yield* bots.startFallback({
        botId: BOT,
        fallbackModel: FALLBACK,
        fromInstanceId: DEEPSEEK,
        fromProvider: "DeepSeek",
        reason: PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
        startedAt: isoAt(PEAK_AT - 60_000),
        resetAt: isoAt(PEAK_AT + 60_000),
        noticeThreadId: null,
      });
      yield* service.sweep;
      const kept = peakState(yield* bots.listFallbackStates());
      expect(kept).toBeDefined();
      expect(DateTime.toEpochMillis(DateTime.makeUnsafe(kept!.resetAt!))).toBe(PEAK_ENDS);
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(FALLBACK);

      // A restart that lands after the window: the same row is cleared, so the
      // bot does not stay on Sonnet for the rest of the day.
      yield* TestClock.setTime(OFF_PEAK_AT);
      yield* service.sweep;
      expect(yield* bots.listFallbackStates()).toHaveLength(0);
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(DS_HOME);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect(
  "leaves a bot on a usage-limit fallback alone, and lets a peak bot fall through to its own",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(PEAK_AT);
      // This bot's own fallback is Codex, which has room.
      yield* seedDeepSeekBot({ fallbackModelSelection: CODEX_DS_FALLBACK });
      harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;

      yield* service.sweep;
      expect(peakState(yield* bots.listFallbackStates())).toBeDefined();

      // Sonnet hits its limit while the bot is on the peak model: the normal
      // chain applies from the model that is actually running, so the row changes
      // to the bot's own fallback with the limit's own reason and reset.
      const resetsAt = PEAK_AT + 3_600_000;
      harness.providers = [
        snapshot("deepseek", "deepseek"),
        snapshot(
          "claudeAgent",
          "claudeAgent",
          usage([{ id: "five_hour", used: 100, resetsAt: isoAt(resetsAt) }]),
        ),
        snapshot("codex", "codex", usage([{ id: "primary", used: 10 }])),
      ];
      const result = yield* hit({
        instanceId: "claudeAgent",
        providerName: "claudeAgent",
        reason: "five_hour",
        retryAt: isoAt(resetsAt),
      });
      expect(result).toEqual({ switched: true, modelLabel: "gpt-6.1-sol · H" });
      const states = yield* bots.listFallbackStates();
      expect(states).toHaveLength(1);
      expect(states[0]!.reason).toBe("five_hour");
      expect(states[0]!.fallbackModel).toEqual(CODEX_DS_FALLBACK);
      expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(CODEX_DS_FALLBACK);
    }).pipe(Effect.provide(makeLayer(harness)));
  },
);

it.effect("does not touch a bot that is already on a usage-limit fallback", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedDeepSeekBot();
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;

    // A limit row made a moment ago, still waiting for its reset.
    const until = PEAK_AT + 3_600_000;
    yield* bots.startFallback({
      botId: BOT,
      fallbackModel: FALLBACK,
      fromInstanceId: "deepseek",
      fromProvider: "DeepSeek",
      reason: "usage_limit",
      startedAt: isoAt(NOW),
      resetAt: isoAt(until),
      noticeThreadId: null,
    });

    yield* TestClock.setTime(PEAK_AT);
    yield* service.sweep;
    const states = yield* bots.listFallbackStates();
    expect(states).toHaveLength(1);
    expect(states[0]!.reason).toBe("usage_limit");
    expect(states[0]!.fallbackModel).toEqual(FALLBACK);
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(states[0]!.resetAt!))).toBe(until);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("the kill switch holds the peak switch back", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(PEAK_AT);
    yield* seedDeepSeekBot();
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness, { PERSONAL_DEEPSEEK_PEAK_SWITCH: "off" })));
});

it.effect("the DeepSeek instance's own setting holds the peak switch back", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(PEAK_AT);
    yield* seedDeepSeekBot();
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(
    Effect.provide(
      makeLayer(harness, {}, {
        providerInstances: {
          [DEEPSEEK]: { driver: "deepseek", config: { peakSwitch: false } },
        },
      } as Parameters<typeof ServerSettings.layerTest>[0]),
    ),
  );
});

it.effect("the clock override drives the switch-over without waiting for a window", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    // The real clock is well off-peak; the override says peak.
    yield* TestClock.setTime(OFF_PEAK_AT);
    yield* seedDeepSeekBot();
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(peakState(yield* bots.listFallbackStates())).toBeDefined();
  }).pipe(
    Effect.provide(makeLayer(harness, { PERSONAL_DEEPSEEK_PEAK_NOW: "2026-10-15T02:00:00.000Z" })),
  );
});

it.effect("the clock override can hold the switch back while the real clock is in a window", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(PEAK_AT);
    yield* seedDeepSeekBot();
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(
    Effect.provide(makeLayer(harness, { PERSONAL_DEEPSEEK_PEAK_NOW: "2026-10-17T02:00:00.000Z" })),
  );
});

it.effect("a bot created during a peak window is switched on the next pass", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(PEAK_AT);
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    // Nothing to switch yet: no bot, no row, and the sweep must not fail.
    yield* service.sweep;
    yield* seedDeepSeekBot();
    yield* service.sweep;
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    expect(peakState(yield* bots.listFallbackStates())).toBeDefined();
  }).pipe(Effect.provide(makeLayer(harness)));
});

// --- the per-bot model schedule ---------------------------------------------------

const OPUS_HOME: ModelSelection = {
  instanceId: CLAUDE,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
} as ModelSelection;
const SCHEDULED: ModelSelection = {
  instanceId: CLAUDE,
  model: "claude-haiku-5-5",
  options: [{ id: "effort", value: "low" }],
} as ModelSelection;
const DS_OTHER: ModelSelection = {
  instanceId: DEEPSEEK,
  model: "deepseek-pro",
} as ModelSelection;

/** Thursday 15 October 2026, 23:30 BST: inside a 22:00 to 07:00 window. */
const NIGHT_AT = Date.parse("2026-10-15T22:30:00.000Z");
/** The window that opened at 22:00 BST ends at 07:00 BST = 06:00Z the next morning. */
const NIGHT_ENDS = Date.parse("2026-10-16T06:00:00.000Z");
const EARLY_AT = Date.parse("2026-10-16T02:30:00.000Z");
const DAY_AT = Date.parse("2026-10-15T12:00:00.000Z");
const SCHEDULE_TZ = { PERSONAL_MODEL_SCHEDULE_TZ: "Europe/London" };

const nightSchedule = (patch: Partial<PersonalBotSchedule> = {}): PersonalBotSchedule => ({
  enabled: true,
  from: "22:00",
  to: "07:00",
  modelSelection: SCHEDULED,
  ...patch,
});

/** A Claude Opus bot with a model schedule, on the shared chat. */
const seedScheduledBot = (
  patch: {
    readonly home?: ModelSelection;
    readonly schedule?: PersonalBotSchedule | undefined;
    readonly fallbackModelSelection?: ModelSelection;
  } = {},
) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const sql = yield* SqlClient.SqlClient;
    const schedule = "schedule" in patch ? patch.schedule : nightSchedule();
    yield* bots.createBot({
      botId: BOT,
      name: "Sched",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: patch.home ?? OPUS_HOME,
      team: "assistant",
      lead: false,
      pinned: false,
      sortOrder: 0,
      createdAt: DateTime.makeUnsafe(NOW),
      updatedAt: DateTime.makeUnsafe(NOW),
      ...(schedule === undefined ? {} : { schedule }),
      ...(patch.fallbackModelSelection === undefined
        ? {}
        : { fallbackModelSelection: patch.fallbackModelSelection }),
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

const scheduleState = (states: ReadonlyArray<PersonalBotRepository.PersonalBotFallbackState>) =>
  states.find((state) => state.reason === PERSONAL_FALLBACK_REASON_SCHEDULE);

const claudeProviders = (harness: Harness) => {
  harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
};

it.effect("the model is stored on the bot and round-trips through the repository", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seedScheduledBot();
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const bot = Option.getOrThrow(yield* bots.getBotById({ botId: BOT }));
    expect(bot.schedule).toEqual(nightSchedule());
    // A bot with none reads as none.
    const plain = Option.getOrThrow(
      yield* bots.updateBot({
        botId: BOT,
        schedule: nightSchedule({ enabled: false }),
        updatedAt: DateTime.makeUnsafe(NOW),
      }),
    );
    expect(plain.schedule?.enabled).toBe(false);
  }).pipe(Effect.provide(makeLayer(harness)));
});

it.effect("a bot runs on its scheduled model inside the window and on its own outside it", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(DAY_AT);
    yield* seedScheduledBot();
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;

    // 13:00 BST: outside. Nothing changes.
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(OPUS_HOME);

    // 23:30 BST: open. The row names the scheduled model and the window's end.
    yield* TestClock.setTime(NIGHT_AT);
    yield* service.sweep;
    const state = scheduleState(yield* bots.listFallbackStates());
    expect(state).toBeDefined();
    expect(state!.fallbackModel).toEqual(SCHEDULED);
    expect(state!.fromInstanceId).toBe(CLAUDE);
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(state!.resetAt!))).toBe(NIGHT_ENDS);
    // Every turn the server starts reads it.
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(SCHEDULED);
    // The bot's own model is untouched, and no chat line was written.
    const bot = Option.getOrThrow(yield* bots.getBotById({ botId: BOT }));
    expect(bot.modelSelection).toEqual(OPUS_HOME);
    expect(bot.fallbackActive?.reason).toBe(PERSONAL_FALLBACK_REASON_SCHEDULE);
    expect(lines(harness)).toHaveLength(0);

    // Past midnight the same row stays, still ending at 07:00.
    yield* TestClock.setTime(EARLY_AT);
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(1);
    expect(
      DateTime.toEpochMillis(
        DateTime.makeUnsafe(scheduleState(yield* bots.listFallbackStates())!.resetAt!),
      ),
    ).toBe(NIGHT_ENDS);

    // 07:00 BST: closed, so the bot is back on its own model.
    yield* TestClock.setTime(NIGHT_ENDS);
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
    expect(yield* botModelSelectionForThread(bots, CHAT, undefined)).toEqual(OPUS_HOME);
    expect(lines(harness)).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect("a window on the night the clocks go back ends at 07:00 local, not 07:00 elapsed", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    // 23:30 BST on Saturday 24 October; the clocks go back at 02:00 BST.
    yield* TestClock.setTime(Date.parse("2026-10-24T22:30:00.000Z"));
    yield* seedScheduledBot();
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    const state = scheduleState(yield* bots.listFallbackStates());
    expect(DateTime.toEpochMillis(DateTime.makeUnsafe(state!.resetAt!))).toBe(
      Date.parse("2026-10-25T07:00:00.000Z"),
    );
    // 06:59 GMT: still the scheduled model. 07:00 GMT: back on its own.
    yield* TestClock.setTime(Date.parse("2026-10-25T06:59:00.000Z"));
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(1);
    yield* TestClock.setTime(Date.parse("2026-10-25T07:00:00.000Z"));
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect("never cuts a running turn: it starts and ends only between turns", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NIGHT_AT);
    yield* seedScheduledBot();
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;

    // The window opens while a turn is running: nothing yet, so that turn is not touched.
    yield* setBusy(true);
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
    // The turn ends: the next pass puts the bot on the scheduled model.
    yield* setBusy(false);
    yield* service.sweep;
    expect(scheduleState(yield* bots.listFallbackStates())).toBeDefined();

    // The window closes while a turn is running: the row stays until it is idle.
    yield* setBusy(true);
    yield* TestClock.setTime(NIGHT_ENDS);
    yield* service.sweep;
    expect(scheduleState(yield* bots.listFallbackStates())).toBeDefined();
    yield* setBusy(false);
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect(
  "a restart inside a window applies it on the first sweep, and a stale row is corrected",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NIGHT_AT);
      yield* seedScheduledBot();
      claudeProviders(harness);
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;

      // Boot: no row exists, the first sweep decides from the clock alone.
      yield* service.sweep;
      expect(scheduleState(yield* bots.listFallbackStates())).toBeDefined();

      // A row left from a previous run, with an old end, is brought to the right one.
      yield* bots.updateFallbackReset({ botId: BOT, resetAt: isoAt(NIGHT_AT + 60_000) });
      yield* service.sweep;
      expect(
        DateTime.toEpochMillis(
          DateTime.makeUnsafe(scheduleState(yield* bots.listFallbackStates())!.resetAt!),
        ),
      ).toBe(NIGHT_ENDS);
    }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
  },
);

it.effect("PERSONAL_MODEL_SCHEDULE=off applies nothing and clears a row that exists", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NIGHT_AT);
    yield* seedScheduledBot();
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* bots.startFallback({
      botId: BOT,
      fallbackModel: SCHEDULED,
      fromInstanceId: CLAUDE,
      fromProvider: "Claude",
      reason: PERSONAL_FALLBACK_REASON_SCHEDULE,
      startedAt: isoAt(NIGHT_AT - 60_000),
      resetAt: isoAt(NIGHT_ENDS),
      noticeThreadId: null,
    });
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness, { ...SCHEDULE_TZ, PERSONAL_MODEL_SCHEDULE: "off" })));
});

it.effect("the clock override drives both switch-overs without waiting for a window", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    // The real clock is mid-day; the override says 23:30.
    yield* TestClock.setTime(DAY_AT);
    yield* seedScheduledBot();
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(scheduleState(yield* bots.listFallbackStates())).toBeDefined();
  }).pipe(
    Effect.provide(
      makeLayer(harness, { ...SCHEDULE_TZ, PERSONAL_MODEL_SCHEDULE_NOW: "2026-10-15T22:30:00Z" }),
    ),
  );
});

it.effect("a disabled schedule, the same model, or From = To does nothing", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NIGHT_AT);
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* seedScheduledBot();
    const set = (schedule: PersonalBotSchedule) =>
      bots.updateBot({ botId: BOT, schedule, updatedAt: DateTime.makeUnsafe(NIGHT_AT) });

    yield* set(nightSchedule({ enabled: false }));
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);

    yield* set(nightSchedule({ modelSelection: OPUS_HOME }));
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);

    yield* set(nightSchedule({ from: "08:00", to: "08:00" }));
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);

    // Back to a good one: it applies.
    yield* set(nightSchedule());
    yield* service.sweep;
    expect(scheduleState(yield* bots.listFallbackStates())).toBeDefined();
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect(
  "editing the schedule while it applies moves the row, and switching it off ends it",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NIGHT_AT);
      claudeProviders(harness);
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      yield* seedScheduledBot();
      yield* service.sweep;
      expect(scheduleState(yield* bots.listFallbackStates())!.fallbackModel).toEqual(SCHEDULED);

      // A different scheduled model: the row follows it.
      const other: ModelSelection = {
        instanceId: CLAUDE,
        model: "claude-sonnet-5-5",
      } as ModelSelection;
      yield* bots.updateBot({
        botId: BOT,
        schedule: nightSchedule({ modelSelection: other }),
        updatedAt: DateTime.makeUnsafe(NIGHT_AT),
      });
      yield* service.sweep;
      expect(scheduleState(yield* bots.listFallbackStates())!.fallbackModel).toEqual(other);

      // The window moved so that it has closed: the bot goes back.
      yield* bots.updateBot({
        botId: BOT,
        schedule: nightSchedule({ modelSelection: other, from: "10:00", to: "11:00" }),
        updatedAt: DateTime.makeUnsafe(NIGHT_AT),
      });
      yield* service.sweep;
      expect(yield* bots.listFallbackStates()).toHaveLength(0);
    }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
  },
);

it.effect(
  "a usage limit outranks the schedule: the bot's own fallback takes over, then the schedule returns",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NIGHT_AT);
      // Scheduled on Codex, with the default Claude Sonnet fallback.
      const onCodex: ModelSelection = {
        instanceId: CODEX,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      } as ModelSelection;
      yield* seedScheduledBot({ schedule: nightSchedule({ modelSelection: onCodex }) });
      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 10 }])),
        READY_CLAUDE(),
      ];
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      yield* service.sweep;
      expect(scheduleState(yield* bots.listFallbackStates())!.fallbackModel).toEqual(onCodex);

      // The scheduled Codex model hits its limit: the bot's own fallback runs.
      const resetsAt = NIGHT_AT + 3_600_000;
      harness.providers = [
        snapshot(
          "codex",
          "codex",
          usage([{ id: "primary", used: 100, resetsAt: isoAt(resetsAt) }]),
        ),
        READY_CLAUDE(),
      ];
      const result = yield* hit({ retryAt: isoAt(resetsAt), reason: "usage_limit" });
      expect(result.switched).toBe(true);
      const limited = yield* bots.listFallbackStates();
      expect(limited).toHaveLength(1);
      expect(limited[0]!.reason).toBe("usage_limit");
      expect(limited[0]!.fallbackModel).toEqual(FALLBACK);

      // While it is on the limit fallback the schedule does not touch it.
      yield* TestClock.setTime(NIGHT_AT + 60_000);
      yield* service.sweep;
      expect((yield* bots.listFallbackStates())[0]!.reason).toBe("usage_limit");

      // After the reset the bot leaves the limit fallback and, the window still open,
      // the schedule applies again (on the same or the next pass).
      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 5 }])),
        READY_CLAUDE(),
      ];
      yield* TestClock.setTime(resetsAt + 120_000);
      yield* service.sweep;
      yield* service.sweep;
      const after = yield* bots.listFallbackStates();
      expect(after).toHaveLength(1);
      expect(after[0]!.reason).toBe(PERSONAL_FALLBACK_REASON_SCHEDULE);
    }).pipe(
      Effect.provide(
        makeLayer(harness, { ...SCHEDULE_TZ, PERSONAL_MODEL_SCHEDULE_NOW: "2026-10-15T22:30:00Z" }),
      ),
    );
  },
);

it.effect("a usage limit already in force is never replaced by the schedule", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NIGHT_AT);
    yield* seedScheduledBot();
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    const until = NIGHT_AT + 3_600_000;
    yield* bots.startFallback({
      botId: BOT,
      fallbackModel: FALLBACK,
      fromInstanceId: "claudeAgent",
      fromProvider: "Claude",
      reason: "usage_limit",
      startedAt: isoAt(NIGHT_AT - 60_000),
      resetAt: isoAt(until),
      noticeThreadId: null,
    });
    yield* service.sweep;
    const states = yield* bots.listFallbackStates();
    expect(states).toHaveLength(1);
    expect(states[0]!.reason).toBe("usage_limit");
    expect(states[0]!.fallbackModel).toEqual(FALLBACK);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect("the schedule outranks the DeepSeek peak switch for a DeepSeek bot", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    // Thursday 02:00 UTC is a peak window; 03:00 BST is also inside 22:00-07:00.
    yield* TestClock.setTime(PEAK_AT);
    yield* seedScheduledBot({ home: DS_HOME });
    claudeProviders(harness);
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;

    // A peak row from before the schedule window mattered.
    yield* bots.startFallback({
      botId: BOT,
      fallbackModel: FALLBACK,
      fromInstanceId: DEEPSEEK,
      fromProvider: "DeepSeek",
      reason: PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK,
      startedAt: isoAt(PEAK_AT - 60_000),
      resetAt: isoAt(PEAK_ENDS),
      noticeThreadId: null,
    });
    yield* service.sweep;
    const states = yield* bots.listFallbackStates();
    expect(states).toHaveLength(1);
    expect(states[0]!.reason).toBe(PERSONAL_FALLBACK_REASON_SCHEDULE);
    expect(states[0]!.fallbackModel).toEqual(SCHEDULED);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect("a scheduled DeepSeek model runs on Sonnet 5.5 High while a peak window is open", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    // Opus bot scheduled onto DeepSeek, 03:00 BST on Thursday: a peak window.
    yield* TestClock.setTime(PEAK_AT);
    yield* seedScheduledBot({ schedule: nightSchedule({ modelSelection: DS_OTHER }) });
    harness.providers = [snapshot("deepseek", "deepseek"), READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    const during = scheduleState(yield* bots.listFallbackStates());
    expect(during).toBeDefined();
    expect(during!.fallbackModel).toEqual(FALLBACK);

    // Off peak but still inside the scheduled window (04:30 UTC = 05:30 BST, Thursday
    // 04:00 UTC the peak ended): the row moves to DeepSeek itself.
    yield* TestClock.setTime(Date.parse("2026-10-15T04:30:00.000Z"));
    yield* service.sweep;
    const after = scheduleState(yield* bots.listFallbackStates());
    expect(after).toBeDefined();
    expect(after!.fallbackModel).toEqual(DS_OTHER);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect("a scheduled model whose provider cannot run is not applied", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    yield* TestClock.setTime(NIGHT_AT);
    yield* seedScheduledBot({ schedule: nightSchedule({ modelSelection: DS_OTHER }) });
    // No DeepSeek provider at all.
    harness.providers = [READY_CLAUDE()];
    const bots = yield* PersonalBotRepository.PersonalBotRepository;
    const service = yield* PersonalModelFallback.PersonalModelFallback;
    yield* service.sweep;
    expect(yield* bots.listFallbackStates()).toHaveLength(0);
  }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
});

it.effect(
  "a bot whose usage limit ends inside the window is told it is back on the scheduled model",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(NIGHT_AT);
      const onCodex: ModelSelection = {
        instanceId: CODEX,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      } as ModelSelection;
      yield* seedScheduledBot({ schedule: nightSchedule({ modelSelection: onCodex }) });
      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 100, resetsAt: isoAt(RESET) }])),
        READY_CLAUDE(),
      ];
      const bots = yield* PersonalBotRepository.PersonalBotRepository;
      const service = yield* PersonalModelFallback.PersonalModelFallback;
      // Opus (the bot's own model) hit its limit at 23:30; its fallback is Sonnet.
      yield* bots.startFallback({
        botId: BOT,
        fallbackModel: FALLBACK,
        fromInstanceId: "claudeAgent",
        fromProvider: "Claude",
        reason: "usage_limit",
        startedAt: isoAt(NIGHT_AT - 60_000),
        resetAt: isoAt(NIGHT_AT + 60_000),
        noticeThreadId: CHAT,
      });
      harness.providers = [
        snapshot("codex", "codex", usage([{ id: "primary", used: 5 }])),
        snapshot("claudeAgent", "claudeAgent", usage([{ id: "five_hour", used: 5 }])),
      ];
      yield* TestClock.setTime(NIGHT_AT + 120_000);
      yield* service.sweep;
      expect(lines(harness)).toEqual([expect.stringContaining("is back on gpt-6.1-sol")]);
    }).pipe(Effect.provide(makeLayer(harness, SCHEDULE_TZ)));
  },
);
