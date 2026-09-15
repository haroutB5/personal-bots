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
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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
    listBots: Effect.succeed([bot as unknown as PersonalBot]),
    getMeta: (key) => Effect.sync(() => Option.fromNullishOr(state.meta.get(key))),
    setMeta: (key, value) => Effect.sync(() => void state.meta.set(key, value)),
    smokeTestFor: () =>
      Effect.succeed(
        Option.some((model: string) =>
          Effect.suspend(() => {
            state.smokeModels.push(model);
            return state.smokeFailure === null
              ? Effect.void
              : Effect.fail({ detail: state.smokeFailure });
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
      message: "API Error: 500",
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
