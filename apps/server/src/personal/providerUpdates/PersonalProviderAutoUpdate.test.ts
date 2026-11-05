// @effect-diagnostics preferSchemaOverJson:off - the stored record is asserted verbatim.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
  type PersonalBot,
  type ProviderSession,
  type ServerProvider,
  type ServerProviderSmokeCheck,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { autoUpdateMetaKey } from "./providerAutoUpdate.ts";
import { makeWith, type PersonalProviderUpdatesDeps } from "./PersonalProviderUpdates.ts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const BOT_THREAD = ThreadId.make("thread-bot");
const NOW = "2026-11-04T10:00:00.000Z";

const advisory = (version: string, latest: string, overrides: Record<string, unknown> = {}) => ({
  status: latest === version ? ("current" as const) : ("behind_latest" as const),
  currentVersion: version,
  latestVersion: latest,
  updateCommand: "mise install claude@latest",
  canUpdate: true,
  canInstallVersion: true,
  checkedAt: NOW,
  message: null,
  ...overrides,
});

const claude = (version: string, latest: string): ServerProvider => ({
  instanceId: CLAUDE,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    {
      slug: "claude-opus-5",
      name: "Opus 5",
      isDefault: true,
      capabilities: [],
    } as never,
  ],
  slashCommands: [],
  skills: [],
  versionAdvisory: advisory(version, latest),
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

const shell = (overrides: Record<string, unknown> = {}) =>
  ({
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

const bot = {
  modelSelection: { instanceId: CLAUDE, model: "claude-opus-5" },
  sortOrder: 0,
} as unknown as PersonalBot;

const makeHarness = (meta = new Map<string, string>()) => {
  const state = {
    providers: [claude("2.1.310", "2.1.317")] as Array<ServerProvider>,
    sessions: [] as Array<ProviderSession>,
    shells: new Map<ThreadId, OrchestrationThreadShell>(),
    meta,
    smokeModels: [] as Array<string>,
    smokeFailure: null as string | null,
    smokeTestAvailable: true,
    bots: [bot],
    updates: [] as Array<{ readonly targetVersion?: string; readonly rollback: boolean }>,
    autoUpdates: [] as Array<unknown>,
    projections: [] as Array<ServerProviderSmokeCheck | null>,
    pushes: [] as Array<{ instanceId: string; label: string; version: string }>,
  };
  const setProvider = (version: string, latest: string) => {
    state.providers = [claude(version, latest)];
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
          const next = { ...provider };
          if (smokeCheck === null) delete next.smokeCheck;
          else next.smokeCheck = smokeCheck;
          return next;
        });
      }),
    setAutoUpdate: (instanceId, autoUpdate) =>
      Effect.sync(() => {
        state.autoUpdates.push(autoUpdate);
        state.providers = state.providers.map((provider) => {
          if (provider.instanceId !== instanceId) return provider;
          const next = { ...provider };
          if (autoUpdate === null) delete next.autoUpdate;
          else next.autoUpdate = autoUpdate;
          return next;
        });
      }),
    updateProvider: (input) =>
      Effect.gen(function* () {
        if (input.rollback === true) {
          const previous = state.providers[0]?.smokeCheck?.previousVersion;
          if (previous !== input.targetVersion) {
            return yield* Effect.fail({
              _tag: "ProviderUpdateError",
              reason:
                "This version is no longer recommended or this installer cannot install a specific version.",
            });
          }
        }
        state.updates.push({
          ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
          rollback: input.rollback === true,
        });
        const target =
          input.targetVersion ??
          input.provider.versionAdvisory?.latestVersion ??
          input.provider.version ??
          "2.1.317";
        setProvider(target, target === "2.1.310" ? "2.1.317" : target);
        return state.providers;
      }),
    runtimeEvents: Stream.empty,
    listSessions: Effect.sync(() => state.sessions),
    stopSession: () => Effect.void,
    threadShell: (threadId) => Effect.sync(() => Option.fromNullishOr(state.shells.get(threadId))),
    isPersonalThread: () => Effect.succeed(true),
    listBots: Effect.sync(() => state.bots),
    getMeta: (key) => Effect.sync(() => Option.fromNullishOr(state.meta.get(key))),
    setMeta: (key, value) => Effect.sync(() => void state.meta.set(key, value)),
    smokeTestFor: () =>
      Effect.succeed(
        state.smokeTestAvailable
          ? Option.some((model: string) =>
              Effect.suspend(() => {
                state.smokeModels.push(model);
                return state.smokeFailure === null
                  ? Effect.void
                  : Effect.fail({ detail: state.smokeFailure });
              }),
            )
          : Option.none(),
      ),
    notifyBroken: (input) => Effect.sync(() => void state.pushes.push(input)),
  };
  return { state, deps, setProvider };
};

it.effect("auto-updates a behind provider once, tests the new version and shows it", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;

    assert.deepEqual(state.updates, [{ rollback: false }]);
    assert.equal(state.providers[0]?.version, "2.1.317");
    assert.deepEqual(state.smokeModels, ["claude-opus-5"]);
    assert.equal(state.providers[0]?.autoUpdate?.status, "updated");
    assert.equal(state.providers[0]?.autoUpdate?.fromVersion, "2.1.310");
    assert.equal(state.providers[0]?.autoUpdate?.toVersion, "2.1.317");
    assert.equal(state.providers[0]?.autoUpdate?.message, "Updated automatically.");
    assert.include(state.meta.get(autoUpdateMetaKey(CLAUDE)) ?? "", '"toVersion":"2.1.317"');

    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("waits for a turn on the provider to finish", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    state.sessions = [session(BOT_THREAD, { status: "running", activeTurnId: "turn-1" as never })];
    state.shells.set(BOT_THREAD, shell({ latestTurn: { state: "running" } }));

    yield* service.autoUpdatePass;
    assert.deepEqual(state.updates, []);

    state.sessions = [session(BOT_THREAD)];
    state.shells.set(BOT_THREAD, shell({ latestTurn: { state: "completed" } }));
    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, 1);
    assert.equal(state.providers[0]?.version, "2.1.317");
  }).pipe(Effect.scoped),
);

it.effect("rolls back to the previous version when the new one fails its test", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    state.smokeFailure = "API Error: 500";

    yield* service.autoUpdatePass;

    assert.deepEqual(state.updates, [
      { rollback: false },
      { targetVersion: "2.1.310", rollback: true },
    ]);
    assert.equal(state.providers[0]?.version, "2.1.310");
    assert.equal(state.providers[0]?.autoUpdate?.status, "rolled_back");
    assert.equal(state.providers[0]?.autoUpdate?.toVersion, "2.1.317");
    assert.include(state.providers[0]?.autoUpdate?.message ?? "", "2.1.310");
    assert.include(state.providers[0]?.autoUpdate?.message ?? "", "API Error: 500");
    assert.equal(state.providers[0]?.smokeCheck, undefined);
  }).pipe(Effect.scoped),
);

it.effect("runs at most once a day per provider", () =>
  Effect.gen(function* () {
    const { state, deps, setProvider } = makeHarness();
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;
    assert.equal(state.providers[0]?.version, "2.1.317");

    setProvider("2.1.317", "2.1.318");
    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, 1);

    yield* TestClock.adjust("25 hours");
    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, 2);
    assert.equal(state.providers[0]?.version, "2.1.318");
  }).pipe(Effect.scoped),
);

it.effect("does not loop when the installer's latest is 2.1.317 and npm says 2.1.318", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;
    assert.equal(state.providers[0]?.version, "2.1.317");
    assert.equal(state.providers[0]?.versionAdvisory?.latestVersion, "2.1.317");

    yield* TestClock.adjust("25 hours");
    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("never retries a version that failed and was rolled back", () =>
  Effect.gen(function* () {
    const { state, deps, setProvider } = makeHarness();
    const service = yield* makeWith(deps);
    state.smokeFailure = "API Error: 500";

    yield* service.autoUpdatePass;
    const attempted = state.updates.length;
    assert.equal(attempted, 2);

    yield* TestClock.adjust("25 hours");
    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, attempted);

    state.smokeFailure = null;
    setProvider("2.1.310", "2.1.318");
    yield* service.autoUpdatePass;
    assert.equal(state.updates.length, attempted + 1);
    assert.equal(state.providers[0]?.version, "2.1.318");
  }).pipe(Effect.scoped),
);

it.effect("records why a provider cannot update itself instead of updating it", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    const service = yield* makeWith(deps);
    state.providers = [
      {
        ...claude("2.1.310", "2.1.317"),
        versionAdvisory: advisory("2.1.310", "2.1.317", {
          canUpdate: false,
          updateCommand: null,
        }),
      },
    ];

    yield* service.autoUpdatePass;

    assert.deepEqual(state.updates, []);
    assert.deepEqual(state.providers[0]?.autoUpdate, {
      status: "blocked",
      message: "This provider updates outside the app. Update it on your computer.",
      fromVersion: null,
      toVersion: null,
      finishedAt: null,
      nextAttemptAt: null,
    });
  }).pipe(Effect.scoped),
);

it.effect("rolls back with a recorded reason even when no test can run", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.smokeTestAvailable = false;
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;

    assert.deepEqual(state.updates, [
      { rollback: false },
      { targetVersion: "2.1.310", rollback: true },
    ]);
    assert.equal(state.providers[0]?.version, "2.1.310");
    assert.equal(state.providers[0]?.autoUpdate?.status, "rolled_back");
    assert.include(state.providers[0]?.autoUpdate?.message ?? "", "could not run");
  }).pipe(Effect.scoped),
);

it.effect("does not update a version that already failed its test", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.providers = [
      {
        ...claude("2.1.310", "2.1.317"),
        smokeCheck: {
          status: "failed",
          version: "2.1.310",
          checkedAt: NOW,
          message: "claude-opus-5-5: API Error: 500",
        },
      },
    ];
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;

    assert.deepEqual(state.updates, []);
    assert.equal(state.providers[0]?.autoUpdate?.status, "blocked");
    assert.equal(
      state.providers[0]?.autoUpdate?.message,
      "The current version failed its test. Fix it before updates can run.",
    );
  }).pipe(Effect.scoped),
);

it.effect("an errored session does not block a provider update forever", () =>
  Effect.gen(function* () {
    const { state, deps } = makeHarness();
    state.sessions = [session(BOT_THREAD, { status: "error" })];
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;

    assert.equal(state.updates.length, 1);
    assert.equal(state.providers[0]?.version, "2.1.317");
  }).pipe(Effect.scoped),
);

it.effect("finishes an update a restart interrupted", () =>
  Effect.gen(function* () {
    const meta = new Map<string, string>([
      [
        autoUpdateMetaKey(CLAUDE),
        JSON.stringify({
          status: "updating",
          fromVersion: "2.1.310",
          toVersion: "2.1.317",
          message: "Updating to 2.1.317.",
          attemptedAt: "1970-01-01T00:00:00.000Z",
          finishedAt: null,
        }),
      ],
    ]);
    const { state, deps } = makeHarness(meta);
    state.providers = [claude("2.1.317", "2.1.317")];
    const service = yield* makeWith(deps);

    yield* service.autoUpdatePass;

    assert.deepEqual(state.updates, []);
    assert.deepEqual(state.smokeModels, ["claude-opus-5"]);
    assert.equal(state.providers[0]?.autoUpdate?.status, "updated");
  }).pipe(Effect.scoped),
);
