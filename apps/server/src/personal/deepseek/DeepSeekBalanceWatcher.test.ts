import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { DeepSeekBalanceRead } from "@t3tools/provider-deepseek/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { PersonalSessionEvent } from "../engine/PersonalProviders.ts";
import {
  deepSeekBalanceAlertMetaKey,
  deepSeekBalanceLastKindValue,
  parseDeepSeekBalanceLastKind,
} from "./deepSeekBalanceAlert.ts";
import { makeWith, watchableDeepSeekProviders } from "./DeepSeekBalanceWatcher.ts";

const instanceId = ProviderInstanceId.make("deepseek");

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("deepseek"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", type: "api_key", label: "DeepSeek API key" },
    checkedAt: "2026-10-14T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function ready(totalBalance: number, isAvailable = true): DeepSeekBalanceRead {
  return {
    status: "ready",
    fetchedAtMs: 1_000_000,
    amounts: {
      currency: "USD",
      totalBalance,
      grantedBalance: 0,
      toppedUpBalance: totalBalance,
      isAvailable,
    },
  };
}

const failedRead: DeepSeekBalanceRead = {
  status: "failed",
  reason: "network_error",
  lastGood: null,
};

function harness(input: {
  readonly providers: ReadonlyArray<ServerProvider> | (() => ReadonlyArray<ServerProvider>);
  readonly reads: () => DeepSeekBalanceRead | null;
  readonly now?: () => number;
  /** Survives a "restart": a second harness can share the same rows. */
  readonly meta?: Map<string, string>;
  /** Registry snapshots, when the test drives the instance list itself. */
  readonly providerChanges?: Stream.Stream<ReadonlyArray<ServerProvider>>;
  readonly runtimeEvents?: Stream.Stream<PersonalSessionEvent>;
  /**
   * Runs after the check has written its flag (or cleared it). The notice is
   * sent before that, so this is "the whole check is done" for a test that
   * wants to look at the state it left behind.
   */
  readonly onMetaWrite?: () => Effect.Effect<void>;
}) {
  const meta = input.meta ?? new Map<string, string>();
  const notifications: Array<{
    readonly instanceId: string;
    readonly label: string;
    readonly balance: string;
    readonly empty: boolean;
    readonly at: string;
  }> = [];
  let readCalls = 0;

  const make = makeWith({
    getProviders: Effect.suspend(() =>
      Effect.succeed(typeof input.providers === "function" ? input.providers() : input.providers),
    ),
    runtimeEvents: input.runtimeEvents ?? Stream.empty,
    providerChanges: input.providerChanges ?? Stream.empty,
    readBalance: () => {
      readCalls += 1;
      const read = input.reads();
      return Effect.succeed(read === null ? Option.none() : Option.some(read));
    },
    getMeta: (key) => Effect.succeed(Option.fromNullishOr(meta.get(key))),
    setMeta: (key, value) =>
      Effect.sync(() => {
        meta.set(key, value);
      }).pipe(Effect.andThen(input.onMetaWrite?.() ?? Effect.void)),
    notify: (notification) =>
      Effect.sync(() => {
        notifications.push(notification);
      }),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  return {
    make,
    meta,
    notifications,
    readCalls: () => readCalls,
    lastKind: () => parseDeepSeekBalanceLastKind(meta.get(deepSeekBalanceAlertMetaKey(instanceId))),
  };
}

describe("watchableDeepSeekProviders", () => {
  it("is DeepSeek only, enabled, and carrying a key", () => {
    expect(watchableDeepSeekProviders([provider()])).toHaveLength(1);
    expect(watchableDeepSeekProviders([provider({ enabled: false })])).toHaveLength(0);
    expect(
      watchableDeepSeekProviders([provider({ auth: { status: "unauthenticated" } })]),
    ).toHaveLength(0);
    expect(
      watchableDeepSeekProviders([
        provider({ driver: ProviderDriverKind.make("codex"), auth: { status: "authenticated" } }),
      ]),
    ).toHaveLength(0);
  });
});

describe("DeepSeekBalanceWatcher", () => {
  it.effect("warns once, and remembers the spell across a restart", () =>
    Effect.gen(function* () {
      const meta = new Map<string, string>();
      const first = harness({ providers: [provider()], reads: () => ready(0.94), meta });
      const watcher = yield* first.make;

      yield* watcher.check({ instanceId });

      expect(first.notifications).toEqual([
        {
          instanceId: "deepseek",
          label: "DeepSeek",
          balance: "$0.94",
          empty: false,
          at: expect.any(String),
        },
      ]);
      expect(first.lastKind()).toBe("low");

      yield* watcher.check({ instanceId, force: true });
      expect(first.notifications).toHaveLength(1);

      const after = harness({ providers: [provider()], reads: () => ready(0.9), meta });
      yield* (yield* after.make).check({ instanceId });
      expect(after.notifications).toHaveLength(0);
    }),
  );

  it.effect("re-arms above 1.50 and reports the next drop", () =>
    Effect.gen(function* () {
      const meta = new Map<string, string>();
      let balance = 0.94;
      const test = harness({ providers: [provider()], reads: () => ready(balance), meta });
      const watcher = yield* test.make;

      yield* watcher.check({ instanceId });
      expect(test.notifications).toHaveLength(1);
      expect(test.lastKind()).toBe("low");

      // A top-up ends the spell; nothing is announced for the recovery.
      balance = 7;
      yield* watcher.check({ instanceId, force: true });
      expect(test.notifications).toHaveLength(1);
      expect(test.lastKind()).toBeNull();

      // The next drop is a new spell and is reported.
      balance = 0.5;
      yield* watcher.check({ instanceId, force: true });
      expect(test.notifications).toHaveLength(2);
      expect(test.notifications[1]?.balance).toBe("$0.50");
    }),
  );

  it.effect("sends the stronger notice for an empty account", () =>
    Effect.gen(function* () {
      const test = harness({ providers: [provider()], reads: () => ready(0, false) });
      yield* (yield* test.make).check({ instanceId });

      expect(test.notifications).toHaveLength(1);
      expect(test.notifications[0]?.empty).toBe(true);
      expect(test.notifications[0]?.balance).toBe("$0.00");
      expect(test.lastKind()).toBe("empty");
    }),
  );

  it.effect("is silent on a failed read, and does not end the spell", () =>
    Effect.gen(function* () {
      const meta = new Map<string, string>();
      const test = harness({ providers: [provider()], reads: () => failedRead, meta });
      const watcher = yield* test.make;

      yield* watcher.check({ instanceId });
      expect(test.notifications).toHaveLength(0);
      expect(test.lastKind()).toBeNull();

      // Already warned, then an outage: still warned, so the recovery back to
      // low does not warn a second time for the same spell.
      test.meta.set(
        deepSeekBalanceAlertMetaKey(instanceId),
        deepSeekBalanceLastKindValue({ kind: "low", at: "2026-10-14T10:00:00Z" }),
      );
      yield* watcher.check({ instanceId, force: true });
      expect(test.lastKind()).toBe("low");
    }),
  );

  it.effect("asks at most once per five minutes for turn-triggered checks", () =>
    Effect.gen(function* () {
      let nowMs = 1_000_000;
      const test = harness({
        providers: [provider()],
        reads: () => ready(12.34),
        now: () => nowMs,
      });
      const watcher = yield* test.make;

      yield* watcher.check({ instanceId });
      yield* watcher.check({ instanceId });
      expect(test.readCalls()).toBe(1);

      nowMs += 4 * 60_000;
      yield* watcher.check({ instanceId });
      expect(test.readCalls()).toBe(1);

      nowMs += 2 * 60_000;
      yield* watcher.check({ instanceId });
      expect(test.readCalls()).toBe(2);

      // The timer's own path is never debounced.
      yield* watcher.check({ instanceId, force: true });
      expect(test.readCalls()).toBe(3);
    }),
  );

  it.effect("makes no request while there is no enabled DeepSeek instance with a key", () =>
    Effect.gen(function* () {
      const idle = harness({ providers: [], reads: () => ready(0.5) });
      yield* (yield* idle.make).sweep;
      expect(idle.readCalls()).toBe(0);
      expect(idle.notifications).toHaveLength(0);

      const disabled = harness({
        providers: [provider({ enabled: false })],
        reads: () => ready(0.5),
      });
      yield* (yield* disabled.make).sweep;
      expect(disabled.readCalls()).toBe(0);

      const keyless = harness({
        providers: [provider({ auth: { status: "unauthenticated" } })],
        reads: () => ready(0.5),
      });
      yield* (yield* keyless.make).sweep;
      expect(keyless.readCalls()).toBe(0);

      const live = harness({ providers: [provider()], reads: () => ready(0.5) });
      yield* (yield* live.make).sweep;
      expect(live.readCalls()).toBe(1);
      expect(live.notifications).toHaveLength(1);
    }),
  );

  it.effect("walks 5.00, 0.90, 0.00, 7.00, 0.00: low, empty, re-arm, empty", () =>
    Effect.gen(function* () {
      const meta = new Map<string, string>();
      const sequence = [5, 0.9, 0, 7, 0];
      let step = 0;
      const test = harness({
        providers: [provider()],
        reads: () => {
          const value = sequence[Math.min(step, sequence.length - 1)]!;
          step += 1;
          return ready(value, value > 0);
        },
        meta,
      });
      const watcher = yield* test.make;

      yield* watcher.check({ instanceId, force: true });
      yield* watcher.check({ instanceId, force: true });
      yield* watcher.check({ instanceId, force: true });
      yield* watcher.check({ instanceId, force: true });
      yield* watcher.check({ instanceId, force: true });

      expect(test.notifications.map((notice) => [notice.balance, notice.empty])).toEqual([
        ["$0.90", false],
        ["$0.00", true],
        ["$0.00", true],
      ]);
      expect(test.lastKind()).toBe("empty");
    }),
  );

  it.effect("checks the moment a slow probe makes a DeepSeek instance authenticated", () =>
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
      const checked = yield* Deferred.make<void>();
      const test = harness({
        providers: [provider({ auth: { status: "unauthenticated" } })],
        reads: () => ready(0.4),
        providerChanges: Stream.fromQueue(changes),
        onMetaWrite: () => Deferred.succeed(checked, undefined),
      });
      const watcher = yield* test.make;

      yield* watcher.sweep;
      expect(test.readCalls()).toBe(0);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* watcher.start();
          // The probe finished; the registry publishes the authenticated
          // instance, which is the check the startup sweep could not make.
          yield* Queue.offer(changes, [provider()]);
          yield* Deferred.await(checked);
        }),
      );

      expect(test.readCalls()).toBe(1);
      expect(test.notifications).toEqual([
        {
          instanceId: "deepseek",
          label: "DeepSeek",
          balance: "$0.40",
          empty: false,
          at: expect.any(String),
        },
      ]);
      expect(test.lastKind()).toBe("low");
    }),
  );

  it.effect("checks a settled turn on its session's instance, and ignores an unknown one", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<PersonalSessionEvent>();
      const checked = yield* Deferred.make<void>();
      const thread = ThreadId.make("thread-1");
      // The startup sweep sees nothing; the session arrives after it, as a real
      // session does, so the only read this test can see is the turn's.
      let providers: ReadonlyArray<ServerProvider> = [];
      const test = harness({
        providers: () => providers,
        reads: () => ready(0.5),
        runtimeEvents: Stream.fromQueue(events),
        onMetaWrite: () => Deferred.succeed(checked, undefined),
      });
      const watcher = yield* test.make;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* watcher.start();
          // No `SessionStarted` for this chat, so the instance is unknown.
          yield* Queue.offer(events, { _tag: "TurnSettled", threadId: ThreadId.make("other") });
          yield* Effect.yieldNow;
          expect(test.readCalls()).toBe(0);

          providers = [provider()];
          yield* Queue.offer(events, { _tag: "SessionStarted", threadId: thread, instanceId });
          yield* Queue.offer(events, { _tag: "TurnSettled", threadId: thread });
          yield* Deferred.await(checked);
        }),
      );

      expect(test.readCalls()).toBe(1);
      expect(test.notifications).toHaveLength(1);
      expect(test.lastKind()).toBe("low");
    }),
  );
});
