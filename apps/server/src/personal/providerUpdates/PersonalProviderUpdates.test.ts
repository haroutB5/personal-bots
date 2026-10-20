// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off - local-time dates as Codex prints them; stored verdicts are asserted on verbatim.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type PersonalBot,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerProvider,
  type ServerProviderSmokeCheck,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeWith,
  providerProductName,
  smokeCheckMetaKey,
  type PersonalProviderUpdatesDeps,
} from "./PersonalProviderUpdates.ts";

it("names each bot runtime by its product name", () => {
  const name = (driver: string, displayName?: string) =>
    providerProductName({
      driver: ProviderDriverKind.make(driver),
      instanceId: ProviderInstanceId.make(driver),
      ...(displayName ? { displayName } : {}),
    });
  assert.strictEqual(name("claudeAgent", "Claude"), "Claude Code");
  assert.strictEqual(name("codex"), "Codex");
  assert.strictEqual(name("opencode"), "OpenCode");
  assert.strictEqual(name("grok", "Grok"), "Grok");
});

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const BOT_THREAD = ThreadId.make("thread-bot");
const PLAIN_THREAD = ThreadId.make("thread-plain");
const NOW = "2026-09-15T10:00:00.000Z";

const claude = (version: string | null): ServerProvider => ({
  instanceId: CLAUDE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [],
  slashCommands: [],
  skills: [],
});

const session = (
  threadId: ThreadId,
  overrides: Partial<ProviderSession> = {},
): ProviderSession => ({
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: CLAUDE,
  status: "ready",
  runtimeMode: "full-access",
  threadId,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// Only the fields the idle check reads.
const shell = (overrides: Record<string, unknown> = {}) =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const bot = { modelSelection: { instanceId: CLAUDE, model: "claude-opus-5" }, sortOrder: 0 };

const event = (type: string, threadId: ThreadId) =>
  ({
    type,
    eventId: `event-${type}`,
    provider: "claudeAgent",
    providerInstanceId: CLAUDE,
    threadId,
    createdAt: NOW,
    payload: {},
  }) as unknown as ProviderRuntimeEvent;

const makeHarness = (meta = new Map<string, string>()) => {
  const state = {
    providers: [claude("2.1.263")],
    sessions: [] as Array<ProviderSession>,
    shells: new Map<ThreadId, OrchestrationThreadShell>(),
    stopped: [] as Array<ThreadId>,
    meta,
    smokeModels: [] as Array<string>,
    smokeFailure: null as string | null,
    /** Per-model failures, for an instance whose bots do not all work. */
    smokeFailureByModel: new Map<string, string>(),
    bots: [bot] as Array<unknown>,
    projections: [] as Array<ServerProviderSmokeCheck | null>,
    pushes: [] as Array<{ instanceId: string; label: string; version: string }>,
  };
  const setVersion = (version: string) => {
    state.providers = state.providers.map((provider) => ({ ...provider, version }));
  };
  const deps: PersonalProviderUpdatesDeps = {
    getProviders: Effect.sync(() => state.providers),
    providerChanges: Stream.empty,
    refreshInstance: () => Effect.sync(() => state.providers),
    setSmokeCheck: (instanceId, smokeCheck) =>
      Effect.sync(() => {
        state.projections.push(smokeCheck);
        state.providers = state.providers.map((provider) => {
          if (provider.instanceId !== instanceId) return provider;
          const { smokeCheck: _previous, ...rest } = provider;
          return smokeCheck === null ? rest : { ...rest, smokeCheck };
        });
      }),
    runtimeEvents: Stream.empty,
    listSessions: Effect.sync(() => state.sessions),
    stopSession: (threadId) =>
      Effect.sync(() => {
        state.stopped.push(threadId);
        state.sessions = state.sessions.filter((candidate) => candidate.threadId !== threadId);
      }),
    threadShell: (threadId) => Effect.sync(() => Option.fromNullishOr(state.shells.get(threadId))),
    isPersonalThread: (threadId) => Effect.succeed(threadId === BOT_THREAD),
    listBots: Effect.sync(() => state.bots as Array<PersonalBot>),
    getMeta: (key) => Effect.sync(() => Option.fromNullishOr(state.meta.get(key))),
    setMeta: (key, value) => Effect.sync(() => void state.meta.set(key, value)),
    smokeTestFor: () =>
      Effect.succeed(
        Option.some((model: string) =>
          Effect.suspend(() => {
            state.smokeModels.push(model);
            const failure = state.smokeFailureByModel.get(model) ?? state.smokeFailure;
            return failure === null || failure === undefined
              ? Effect.void
              : Effect.fail({ detail: failure });
          }),
        ),
      ),
    notifyBroken: (input) => Effect.sync(() => void state.pushes.push(input)),
  };
  return { state, deps, setVersion };
};

it.effect("a bot session on the old version restarts only after its turn ends", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    state.sessions = [session(BOT_THREAD)];
    yield* service.handleRuntimeEvent(event("session.started", BOT_THREAD));

    // The update lands mid-turn: the running turn is not interrupted.
    state.sessions = [session(BOT_THREAD, { status: "running", activeTurnId: "turn-1" as never })];
    state.shells.set(BOT_THREAD, shell({ latestTurn: { state: "running" } }));
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    assert.deepEqual(state.stopped, []);

    // Between turns but waiting on an approval: still left alone.
    state.sessions = [session(BOT_THREAD)];
    state.shells.set(BOT_THREAD, shell({ hasPendingApprovals: true }));
    yield* service.restartStaleSessions;
    assert.deepEqual(state.stopped, []);

    // The turn ends and nothing is pending: stopped once, so the next turn resumes on 2.1.264.
    state.shells.set(BOT_THREAD, shell({ latestTurn: { state: "completed" } }));
    yield* service.handleRuntimeEvent(event("turn.completed", BOT_THREAD));
    assert.deepEqual(state.stopped, [BOT_THREAD]);
    yield* service.restartStaleSessions;
    assert.deepEqual(state.stopped, [BOT_THREAD]);
  }).pipe(Effect.scoped),
);

it.effect("sessions already on the new version and non-bot threads are never restarted", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    state.sessions = [session(PLAIN_THREAD)];
    yield* service.handleRuntimeEvent(event("session.started", PLAIN_THREAD));
    setVersion("2.1.264");
    state.sessions = [session(PLAIN_THREAD), session(BOT_THREAD)];
    yield* service.handleRuntimeEvent(event("session.started", BOT_THREAD));
    yield* service.handleProviders(state.providers);
    yield* service.restartStaleSessions;
    assert.deepEqual(state.stopped, []);
  }).pipe(Effect.scoped),
);

it.effect("each new version is tested once, and the verdict survives a server restart", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);

    // First sighting is a baseline: nobody updated to it, nothing is tested.
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, []);

    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, ["claude-opus-5"]);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    assert.equal(state.providers[0]?.smokeCheck?.version, "2.1.264");

    // A fresh service over the same stored meta does not test 2.1.264 again.
    const restarted = makeHarness(state.meta);
    restarted.setVersion("2.1.264");
    const again = yield* makeWith(restarted.deps);
    yield* again.handleProviders(restarted.state.providers);
    yield* again.drainChecks;
    assert.deepEqual(restarted.state.smokeModels, []);
    assert.equal(restarted.state.providers[0]?.smokeCheck?.status, "passed");
    assert.include(state.meta.get(smokeCheckMetaKey(CLAUDE)) ?? "", '"version":"2.1.264"');
  }).pipe(Effect.scoped),
);

it.effect("a failing version is marked broken with one push; a later pass clears it", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);

    state.smokeFailure = "API Error: 500";
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.deepEqual(state.providers[0]?.smokeCheck, {
      status: "failed",
      version: "2.1.264",
      checkedAt: state.providers[0]?.smokeCheck?.checkedAt ?? null,
      // The model is named: a bare "API Error: 500" does not say whether the
      // provider is broken or one bot points at a model that is gone.
      message: "claude-opus-5: API Error: 500",
      model: "claude-opus-5",
      // The version that worked before: the "Go back" target.
      previousVersion: "2.1.263",
    });
    assert.deepEqual(state.pushes, [
      { instanceId: CLAUDE, label: "Claude Code", version: "2.1.264" },
    ]);

    // No automatic retry: more snapshots of the same version do nothing.
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.equal(state.smokeModels.length, 1);

    // "Check again" that fails again stays quiet; one that passes clears it.
    yield* service.recheck({ instanceId: CLAUDE });
    yield* service.drainChecks;
    assert.equal(state.smokeModels.length, 2);
    assert.equal(state.pushes.length, 1);
    state.smokeFailure = null;
    yield* service.recheck({ instanceId: CLAUDE });
    yield* service.drainChecks;
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    assert.equal(state.pushes.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("a signed-out provider is not blamed on the update", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    setVersion("2.1.264");
    state.providers = state.providers.map((provider) => ({
      ...provider,
      auth: { status: "unauthenticated" as const },
    }));
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, []);
    assert.deepEqual(state.pushes, []);
  }).pipe(Effect.scoped),
);

it.effect("one bot on a dead model does not condemn an instance whose other model works", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    // The shape that sent us hunting a provider outage: a bot pinned to a
    // withdrawn stealth model, beside a bot on a model that answers fine.
    state.bots = [
      { modelSelection: { instanceId: CLAUDE, model: "dead-model" }, sortOrder: 0 },
      { modelSelection: { instanceId: CLAUDE, model: "claude-opus-5" }, sortOrder: 1 },
    ];
    state.smokeFailureByModel.set("dead-model", "Unexpected server error.");

    yield* service.handleProviders(state.providers);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    // It tried the dead one first, then found a model that works.
    assert.deepEqual(state.smokeModels, ["dead-model", "claude-opus-5"]);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    // Nothing is broken about the update, so the owner is not alerted.
    assert.deepEqual(state.pushes, []);
  }),
);

it.effect("still fails the instance, naming the model, when no model answers", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    state.bots = [
      { modelSelection: { instanceId: CLAUDE, model: "dead-model" }, sortOrder: 0 },
      { modelSelection: { instanceId: CLAUDE, model: "claude-opus-5" }, sortOrder: 1 },
    ];
    state.smokeFailure = "API Error: 500";

    yield* service.handleProviders(state.providers);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    assert.deepEqual(state.smokeModels, ["dead-model", "claude-opus-5"]);
    assert.equal(state.providers[0]?.smokeCheck?.status, "failed");
    // The message says which model was tried: "it failed" alone sent two
    // people looking for an outage that did not exist.
    assert.include(state.providers[0]?.smokeCheck?.message ?? "", "claude-opus-5");
    assert.deepEqual(state.pushes, [
      { instanceId: CLAUDE, label: "Claude Code", version: "2.1.264" },
    ]);
  }),
);

it.effect("tries each distinct model once, however many bots share it", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const service = yield* makeWith(deps);
    state.bots = [
      { modelSelection: { instanceId: CLAUDE, model: "dead-model" }, sortOrder: 0 },
      { modelSelection: { instanceId: CLAUDE, model: "dead-model" }, sortOrder: 1 },
      { modelSelection: { instanceId: CLAUDE, model: "claude-opus-5" }, sortOrder: 2 },
    ];
    state.smokeFailureByModel.set("dead-model", "Unexpected server error.");

    yield* service.handleProviders(state.providers);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    assert.deepEqual(state.smokeModels, ["dead-model", "claude-opus-5"]);
  }),
);

// --- Usage limits: out of tokens is not a broken update --------------------

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const ordinal = (day: number) => {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  return day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
};
/** Codex's "try again at" stamp, in the machine's local time: "Oct 16th, 2026 12:47 AM". */
const codexStamp = (ms: number) => {
  const at = new Date(ms);
  const hour = at.getHours() % 12 === 0 ? 12 : at.getHours() % 12;
  const minute = String(at.getMinutes()).padStart(2, "0");
  const meridiem = at.getHours() < 12 ? "AM" : "PM";
  return `${MONTH_NAMES[at.getMonth()]} ${at.getDate()}${ordinal(at.getDate())}, ${at.getFullYear()} ${hour}:${minute} ${meridiem}`;
};
const limitText = (resetMs: number) =>
  `ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${codexStamp(resetMs)}.`;
const localMs = (...parts: [number, number, number, number, number]) =>
  new Date(...parts).getTime();
const MINUTE = 60_000;

/** Lets the retry timer's fiber and the worker run after the test clock moved. */
const settle = (service: { readonly drainChecks: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    for (let round = 0; round < 3; round += 1) {
      yield* Effect.yieldNow;
      yield* service.drainChecks;
    }
  });

/** The harness with a version change behind it, so the next provider snapshot runs the test. */
const updatedHarness = (meta = new Map<string, string>()) => {
  const harness = makeHarness(meta);
  harness.setVersion("2.1.264");
  return harness;
};

it.effect("every model out of usage waits for the reset: no Update broke, no push", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    yield* TestClock.setTime(localMs(2026, 9, 16, 8, 52));
    const service = yield* makeWith(deps);
    state.bots = [
      { modelSelection: { instanceId: CLAUDE, model: "gpt-6-astra" }, sortOrder: 0 },
      { modelSelection: { instanceId: CLAUDE, model: "gpt-6-luna" }, sortOrder: 1 },
    ];
    yield* service.handleProviders(state.providers);

    const resetAt = localMs(2026, 9, 16, 23, 47);
    state.smokeFailure = limitText(resetAt);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    assert.deepEqual(state.smokeModels, ["gpt-6-astra", "gpt-6-luna"]);
    const check = state.providers[0]?.smokeCheck;
    assert.equal(check?.status, "waiting_for_limit");
    assert.equal(check?.version, "2.1.264");
    assert.equal(check?.retryAt, new Date(resetAt).toISOString());
    assert.include(check?.message ?? "", "gpt-6-luna: ");
    assert.deepEqual(state.pushes, []);
    assert.include(state.meta.get(smokeCheckMetaKey(CLAUDE)) ?? "", '"status":"waiting_for_limit"');
    assert.notInclude(JSON.stringify(state.projections), '"failed"');
  }),
);

it.effect("a limit on one model and a real error on another is still a failed update", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    yield* TestClock.setTime(localMs(2026, 9, 16, 8, 52));
    const service = yield* makeWith(deps);
    state.bots = [
      { modelSelection: { instanceId: CLAUDE, model: "limited" }, sortOrder: 0 },
      { modelSelection: { instanceId: CLAUDE, model: "broken" }, sortOrder: 1 },
    ];
    state.smokeFailureByModel.set("limited", limitText(localMs(2026, 9, 16, 23, 47)));
    state.smokeFailureByModel.set("broken", "API Error: 500");
    yield* service.handleProviders(state.providers);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    assert.equal(state.providers[0]?.smokeCheck?.status, "failed");
    assert.deepEqual(state.pushes, [
      { instanceId: CLAUDE, label: "Claude Code", version: "2.1.264" },
    ]);
    // A failure is not retried by the clock.
    const tried = state.smokeModels.length;
    yield* TestClock.adjust("2 days");
    yield* settle(service);
    assert.equal(state.smokeModels.length, tried);
  }),
);

it.effect("one model that answers passes the update even when another is out of usage", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    yield* TestClock.setTime(localMs(2026, 9, 16, 8, 52));
    const service = yield* makeWith(deps);
    state.bots = [
      { modelSelection: { instanceId: CLAUDE, model: "limited" }, sortOrder: 0 },
      { modelSelection: { instanceId: CLAUDE, model: "works" }, sortOrder: 1 },
    ];
    state.smokeFailureByModel.set("limited", limitText(localMs(2026, 9, 16, 23, 47)));
    yield* service.handleProviders(state.providers);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    assert.deepEqual(state.pushes, []);
  }),
);

it.effect("the retry runs a minute after the reset on the clock, and can pass", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const start = localMs(2026, 9, 16, 8, 52);
    yield* TestClock.setTime(start);
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    const resetAt = localMs(2026, 9, 16, 23, 47);
    state.smokeFailure = limitText(resetAt);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.equal(state.providers[0]?.smokeCheck?.status, "waiting_for_limit");
    assert.equal(state.smokeModels.length, 1);

    // The limit clears, but the clock has not reached reset + 1 minute yet.
    state.smokeFailure = null;
    yield* TestClock.adjust(resetAt + 59_000 - start);
    yield* settle(service);
    assert.equal(state.smokeModels.length, 1);
    assert.equal(state.providers[0]?.smokeCheck?.status, "waiting_for_limit");

    yield* TestClock.adjust("2 seconds");
    yield* settle(service);
    assert.equal(state.smokeModels.length, 2);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    assert.equal(state.providers[0]?.smokeCheck?.retryAt, undefined);
    assert.deepEqual(state.pushes, []);

    // Nothing is left on the clock.
    yield* TestClock.adjust("3 days");
    yield* settle(service);
    assert.equal(state.smokeModels.length, 2);
  }),
);

it.effect("a retry that meets the limit again keeps waiting with the new reset time", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const start = localMs(2026, 9, 16, 8, 52);
    yield* TestClock.setTime(start);
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    const firstReset = localMs(2026, 9, 16, 12, 47);
    state.smokeFailure = limitText(firstReset);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    // The weekly window turns out to be spent too: the provider names a later time.
    const secondReset = localMs(2026, 9, 18, 3, 15);
    state.smokeFailure = limitText(secondReset);
    yield* TestClock.adjust(firstReset + 61_000 - start);
    yield* settle(service);
    assert.equal(state.smokeModels.length, 2);
    const waiting = state.providers[0]?.smokeCheck;
    assert.equal(waiting?.status, "waiting_for_limit");
    assert.equal(waiting?.retryAt, new Date(secondReset).toISOString());
    assert.deepEqual(state.pushes, []);

    state.smokeFailure = null;
    yield* TestClock.adjust(secondReset - firstReset);
    yield* settle(service);
    assert.equal(state.smokeModels.length, 3);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    assert.deepEqual(state.pushes, []);
  }),
);

it.effect("with no reset time anywhere the test runs again 30 minutes later", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    yield* TestClock.setTime(localMs(2026, 9, 16, 8, 52));
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    state.smokeFailure = "You've hit your usage limit.";
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.equal(state.providers[0]?.smokeCheck?.status, "waiting_for_limit");

    yield* TestClock.adjust(30 * MINUTE - 1000);
    yield* settle(service);
    assert.equal(state.smokeModels.length, 1);
    state.smokeFailure = null;
    yield* TestClock.adjust("2 seconds");
    yield* settle(service);
    assert.equal(state.smokeModels.length, 2);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
  }),
);

const HAROUT_MESSAGE =
  "gpt-6-astra: …ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 16th, 2026 12:47 AM.";
const legacyFailed = JSON.stringify({
  version: "2.1.264",
  status: "failed",
  checkedAt: "2026-10-15T23:50:00.000Z",
  message: HAROUT_MESSAGE,
});

it.effect("Harout's stored 'Update broke' record reads as waiting and is retried at once", () =>
  Effect.gen(function* () {
    const meta = new Map([[smokeCheckMetaKey(CLAUDE), legacyFailed]]);
    const { state, deps } = updatedHarness(meta);
    // The morning he saw it still on screen, long after the reset.
    yield* TestClock.setTime(localMs(2026, 9, 16, 8, 52));
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;

    // First it reads back as waiting (not failed), with the message's own time...
    assert.equal(state.projections[0]?.status, "waiting_for_limit");
    assert.equal(
      state.projections[0]?.retryAt,
      new Date(localMs(2026, 9, 16, 0, 47)).toISOString(),
    );
    // ...and as that time has passed, the test ran and Codex answered.
    assert.deepEqual(state.smokeModels, ["claude-opus-5"]);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
    assert.deepEqual(state.pushes, []);
    assert.notInclude(JSON.stringify(state.projections), '"failed"');
  }),
);

it.effect("a stored limit failure whose reset is still ahead waits and then retries", () =>
  Effect.gen(function* () {
    const meta = new Map([[smokeCheckMetaKey(CLAUDE), legacyFailed]]);
    const { state, deps } = updatedHarness(meta);
    const start = localMs(2026, 9, 15, 23, 0);
    yield* TestClock.setTime(start);
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.equal(state.providers[0]?.smokeCheck?.status, "waiting_for_limit");
    assert.deepEqual(state.smokeModels, []);
    // Saved as waiting, so the time does not move on the next read.
    assert.include(state.meta.get(smokeCheckMetaKey(CLAUDE)) ?? "", '"status":"waiting_for_limit"');
    yield* service.handleProviders(state.providers);
    assert.equal(
      state.providers[0]?.smokeCheck?.retryAt,
      new Date(localMs(2026, 9, 16, 0, 47)).toISOString(),
    );

    yield* TestClock.adjust(localMs(2026, 9, 16, 0, 47) + 59_000 - start);
    yield* settle(service);
    assert.deepEqual(state.smokeModels, []);
    yield* TestClock.adjust("2 seconds");
    yield* settle(service);
    assert.deepEqual(state.smokeModels, ["claude-opus-5"]);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
  }),
);

it.effect("a restart re-arms a waiting record, and runs it at once when its time has passed", () =>
  Effect.gen(function* () {
    const start = localMs(2026, 9, 16, 8, 52);
    yield* TestClock.setTime(start);
    const resetAt = localMs(2026, 9, 16, 23, 47);
    const first = makeHarness();
    first.state.smokeFailure = limitText(resetAt);
    const scope = yield* Scope.make();
    const service = yield* makeWith(first.deps).pipe(Effect.provideService(Scope.Scope, scope));
    yield* service.handleProviders(first.state.providers);
    first.setVersion("2.1.264");
    yield* service.handleProviders(first.state.providers);
    yield* service.drainChecks;
    assert.equal(first.state.providers[0]?.smokeCheck?.status, "waiting_for_limit");
    // The server stops: the timer goes with it, the stored retry time stays.
    yield* Scope.close(scope, Exit.void);

    const second = updatedHarness(first.state.meta);
    const restarted = yield* makeWith(second.deps);
    yield* restarted.handleProviders(second.state.providers);
    yield* restarted.drainChecks;
    assert.equal(second.state.providers[0]?.smokeCheck?.status, "waiting_for_limit");
    assert.deepEqual(second.state.smokeModels, []);

    yield* TestClock.adjust(resetAt + 61_000 - start);
    yield* settle(restarted);
    assert.deepEqual(second.state.smokeModels, ["claude-opus-5"]);
    assert.equal(second.state.providers[0]?.smokeCheck?.status, "passed");
    assert.deepEqual(first.state.smokeModels, ["claude-opus-5"]);

    // Once more, restarted after the time has passed: it runs straight away.
    const late = updatedHarness(
      new Map([
        [
          smokeCheckMetaKey(CLAUDE),
          JSON.stringify({
            version: "2.1.264",
            status: "waiting_for_limit",
            checkedAt: "2026-10-16T08:00:00.000Z",
            message: "claude-opus-5: limit",
            retryAt: new Date(resetAt).toISOString(),
          }),
        ],
      ]),
    );
    const lateService = yield* makeWith(late.deps);
    yield* lateService.handleProviders(late.state.providers);
    yield* lateService.drainChecks;
    assert.deepEqual(late.state.smokeModels, ["claude-opus-5"]);
    assert.equal(late.state.providers[0]?.smokeCheck?.status, "passed");
  }).pipe(Effect.scoped),
);

it.effect("'Check again' runs the test at once and cancels the wait", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    const start = localMs(2026, 9, 16, 8, 52);
    yield* TestClock.setTime(start);
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    const resetAt = localMs(2026, 9, 16, 23, 47);
    state.smokeFailure = limitText(resetAt);
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.equal(state.smokeModels.length, 1);

    state.smokeFailure = null;
    yield* service.recheck({ instanceId: CLAUDE });
    yield* service.drainChecks;
    assert.equal(state.smokeModels.length, 2);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");

    yield* TestClock.adjust(resetAt + 2 * MINUTE - start);
    yield* settle(service);
    assert.equal(state.smokeModels.length, 2);
    assert.deepEqual(state.pushes, []);

    // Checking again into a real failure is a real failure, with its one push.
    state.smokeFailure = "API Error: 500";
    yield* service.recheck({ instanceId: CLAUDE });
    yield* service.drainChecks;
    assert.equal(state.providers[0]?.smokeCheck?.status, "failed");
    assert.equal(state.pushes.length, 1);
  }),
);

it.effect("a waiting record does not run while the account is signed out", () =>
  Effect.gen(function* () {
    const meta = new Map([
      [
        smokeCheckMetaKey(CLAUDE),
        JSON.stringify({
          version: "2.1.264",
          status: "waiting_for_limit",
          checkedAt: "2026-10-16T08:00:00.000Z",
          message: "claude-opus-5: limit",
          retryAt: "2026-10-16T09:00:00.000Z",
        }),
      ],
    ]);
    const { state, deps } = updatedHarness(meta);
    yield* TestClock.setTime(Date.parse("2026-10-16T10:00:00.000Z"));
    const service = yield* makeWith(deps);
    state.providers = state.providers.map((provider) => ({
      ...provider,
      auth: { status: "unauthenticated" as const },
    }));
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, []);
    assert.equal(state.providers[0]?.smokeCheck?.status, "waiting_for_limit");

    state.providers = state.providers.map((provider) => ({
      ...provider,
      auth: { status: "authenticated" as const },
    }));
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, ["claude-opus-5"]);
    assert.equal(state.providers[0]?.smokeCheck?.status, "passed");
  }),
);

const modelEntry = (slug: string, isDefault = false) => ({
  slug,
  name: slug,
  isCustom: false,
  isDefault,
  capabilities: null,
});

it.effect("Test runs on the default model with no bots, and records model and duration", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.bots = [];
    state.providers = state.providers.map((provider) => ({
      ...provider,
      models: [modelEntry("claude-haiku-5-5"), modelEntry("claude-sonnet-5-5", true)],
    }));
    const service = yield* makeWith(deps);
    yield* service.testRun({ instanceId: CLAUDE });
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, ["claude-sonnet-5-5"]);
    const check = state.providers[0]?.smokeCheck;
    assert.equal(check?.status, "passed");
    assert.equal(check?.model, "claude-sonnet-5-5");
    assert.equal(check?.manual, true);
    assert.isNumber(check?.durationMs);

    // A chosen model wins over the default.
    yield* service.testRun({ instanceId: CLAUDE, model: "claude-haiku-5-5" });
    yield* service.drainChecks;
    assert.deepEqual(state.smokeModels, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
  }).pipe(Effect.scoped),
);

it.effect("a failed Test is the owner's test: no push, no previous version", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.bots = [];
    state.providers = state.providers.map((provider) => ({
      ...provider,
      models: [modelEntry("claude-sonnet-5-5", true)],
    }));
    state.smokeFailure = "model not found";
    const service = yield* makeWith(deps);
    yield* service.testRun({ instanceId: CLAUDE });
    yield* service.drainChecks;
    const check = state.providers[0]?.smokeCheck;
    assert.equal(check?.status, "failed");
    assert.equal(check?.manual, true);
    assert.equal(check?.previousVersion, undefined);
    assert.deepEqual(state.pushes, []);
  }).pipe(Effect.scoped),
);

it.effect("Test refuses a provider that is missing, not installed or off", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    const missing = yield* Effect.flip(
      service.testRun({ instanceId: ProviderInstanceId.make("nothing") }),
    );
    assert.include(missing.message, "not set up");
    state.providers = state.providers.map((provider) => ({ ...provider, installed: false }));
    const notInstalled = yield* Effect.flip(service.testRun({ instanceId: CLAUDE }));
    assert.include(notInstalled.message, "Install it");
    state.providers = state.providers.map((provider) => ({
      ...provider,
      installed: true,
      enabled: false,
    }));
    const off = yield* Effect.flip(service.testRun({ instanceId: CLAUDE }));
    assert.include(off.message, "Turn it on");
    assert.deepEqual(state.smokeModels, []);
  }).pipe(Effect.scoped),
);

it.effect("a model the provider dropped is not blamed on the update", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    state.providers = state.providers.map((provider) => ({
      ...provider,
      models: [modelEntry("claude-sonnet-5-5", true)],
    }));
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    state.smokeFailureByModel.set("claude-opus-5", "Unexpected server error");
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    // The bot's model is not in the provider's list: the default model is tried
    // and answers, so the provider passed and only the bots need a new model.
    assert.deepEqual(state.smokeModels, ["claude-opus-5", "claude-sonnet-5-5"]);
    const check = state.providers[0]?.smokeCheck;
    assert.equal(check?.status, "passed");
    assert.equal(check?.model, "claude-sonnet-5-5");
    assert.deepEqual(check?.missingModels, ["claude-opus-5"]);
    assert.deepEqual(state.pushes, []);
  }).pipe(Effect.scoped),
);

it.effect("when the default model fails too, the update is blamed with the model named", () =>
  Effect.gen(function* () {
    const { state, deps, setVersion } = makeHarness();
    state.providers = state.providers.map((provider) => ({
      ...provider,
      models: [modelEntry("claude-sonnet-5-5", true)],
    }));
    const service = yield* makeWith(deps);
    yield* service.handleProviders(state.providers);
    state.smokeFailure = "Unexpected server error";
    setVersion("2.1.264");
    yield* service.handleProviders(state.providers);
    yield* service.drainChecks;
    const check = state.providers[0]?.smokeCheck;
    assert.equal(check?.status, "failed");
    assert.equal(check?.missingModels, undefined);
    assert.equal(check?.previousVersion, "2.1.263");
    assert.equal(state.pushes.length, 1);
  }).pipe(Effect.scoped),
);
