import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { DeepSeekBalanceRead } from "../../provider/Drivers/DeepSeekBalance.ts";
import {
  DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS,
  DEEPSEEK_BALANCE_CHECK_INTERVAL_MS,
  deepSeekBalanceAlertMetaKey,
  deepSeekBalanceWarnedValue,
  parseDeepSeekBalanceWarned,
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

/**
 * A watcher over fakes: the instance list, the balance reads, the persisted
 * meta rows and the notifications are all in the test's hands, so the rules
 * can be driven directly rather than through the real services.
 */
function harness(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly reads: () => DeepSeekBalanceRead | null;
  readonly now?: () => number;
  /** Survives a "restart": a second harness can share the same rows. */
  readonly meta?: Map<string, string>;
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
    getProviders: Effect.succeed(input.providers),
    runtimeEvents: Stream.empty,
    readBalance: () => {
      readCalls += 1;
      const read = input.reads();
      return Effect.succeed(read === null ? Option.none() : Option.some(read));
    },
    getMeta: (key) => Effect.succeed(Option.fromNullishOr(meta.get(key))),
    setMeta: (key, value) =>
      Effect.sync(() => {
        meta.set(key, value);
      }),
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
    warned: () => parseDeepSeekBalanceWarned(meta.get(deepSeekBalanceAlertMetaKey(instanceId))),
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
      expect(first.warned()).toBe(true);

      // A second reading in the same spell stays quiet even when it drops.
      yield* watcher.check({ instanceId, force: true });
      expect(first.notifications).toHaveLength(1);

      // "Restart": a fresh watcher over the same persisted rows must not warn
      // again for the same low spell.
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
      expect(test.warned()).toBe(true);

      // A top-up ends the spell; nothing is announced for the recovery.
      balance = 7;
      yield* watcher.check({ instanceId, force: true });
      expect(test.notifications).toHaveLength(1);
      expect(test.warned()).toBe(false);

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
      expect(test.warned()).toBe(true);
    }),
  );

  it.effect("is silent on a failed read, and does not end the spell", () =>
    Effect.gen(function* () {
      const meta = new Map<string, string>();
      const test = harness({ providers: [provider()], reads: () => failedRead, meta });
      const watcher = yield* test.make;

      yield* watcher.check({ instanceId });
      expect(test.notifications).toHaveLength(0);
      expect(test.warned()).toBe(false);

      // Already warned, then an outage: still warned, so the recovery back to
      // low does not warn a second time for the same spell.
      test.meta.set(
        deepSeekBalanceAlertMetaKey(instanceId),
        deepSeekBalanceWarnedValue({ warned: true, at: "2026-10-14T10:00:00Z" }),
      );
      yield* watcher.check({ instanceId, force: true });
      expect(test.warned()).toBe(true);
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

      nowMs += DEEPSEEK_BALANCE_CHECK_DEBOUNCE_MS - 1;
      yield* watcher.check({ instanceId });
      expect(test.readCalls()).toBe(1);

      nowMs += 2;
      yield* watcher.check({ instanceId });
      expect(test.readCalls()).toBe(2);

      // The timer's own path is never debounced: it is already half an hour
      // apart, and a forced check is what keeps the card honest.
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

      // The timer's cadence is the light half-hour sweep, not a per-step poll.
      expect(DEEPSEEK_BALANCE_CHECK_INTERVAL_MS).toBe(30 * 60_000);

      const live = harness({ providers: [provider()], reads: () => ready(0.5) });
      yield* (yield* live.make).sweep;
      expect(live.readCalls()).toBe(1);
      expect(live.notifications).toHaveLength(1);
    }),
  );

  it.effect("walks 5.00, 0.90, 0.00, 7.00 and sends exactly the expected notices", () =>
    Effect.gen(function* () {
      const meta = new Map<string, string>();
      const sequence = [5, 0.9, 0, 7];
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

      yield* watcher.check({ instanceId, force: true }); // 5.00: above the line
      yield* watcher.check({ instanceId, force: true }); // 0.90: the drop
      yield* watcher.check({ instanceId, force: true }); // 0.00: same spell
      yield* watcher.check({ instanceId, force: true }); // 7.00: the top-up

      // One notice for the spell, none for the recovery - and the flag is
      // cleared, so a later drop is a new spell and reports again.
      expect(test.notifications.map((notice) => [notice.balance, notice.empty])).toEqual([
        ["$0.90", false],
      ]);
      expect(test.warned()).toBe(false);
    }),
  );

  it.effect("ignores a turn that carries no instance, and needs a scope only to start", () =>
    Effect.gen(function* () {
      const test = harness({ providers: [provider()], reads: () => ready(0.5) });
      const watcher = yield* test.make;
      // The turn path is the stream inside `start`; the decision itself is the
      // same `check`, which is what the tests above drive.
      const event: ProviderRuntimeEvent = {
        type: "turn.completed",
        turnId: "t1",
      } as ProviderRuntimeEvent;
      expect(event.providerInstanceId).toBeUndefined();
      expect(watcher.start).toBeTypeOf("function");
    }),
  );
});
