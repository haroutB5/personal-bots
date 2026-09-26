import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  confirmUsageAfterReset,
  RESET_CONFIRM_DELAYS,
  usageReflectsReset,
} from "./resetCreditConfirmation.ts";

// Harout's Claude account on 2026-09-26 just before the redeem, and what a
// read inside the lag returned: the same windows, reset times a few hundred
// milliseconds apart.
const limits = (
  checkedAt: string,
  session: number,
  weekly: number,
  jitter = "594",
): ServerProviderUsageLimits => ({
  checkedAt,
  windows: [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent: session,
      resetsAt: `2026-09-26T07:59:59.${jitter}Z`,
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: 10080,
      usedPercent: weekly,
      resetsAt: `2026-09-27T10:59:59.${jitter}Z`,
    },
  ],
});
const before = limits("2026-09-26T07:39:44.000Z", 6, 100);
const stale = limits("2026-09-26T07:39:53.000Z", 6, 100, "744");
const reset = limits("2026-09-26T07:39:58.000Z", 4, 0, "744");
const failed: ServerProviderUsageLimits = {
  checkedAt: "2026-09-26T07:39:53.000Z",
  windows: [],
  unavailable: { reason: "probeFailed" },
};

describe("usageReflectsReset", () => {
  it("rejects a read that still shows the pre-redeem windows", () => {
    expect(usageReflectsReset(before, stale)).toBe(false);
  });

  it("accepts a lower window", () => {
    expect(usageReflectsReset(before, reset)).toBe(true);
  });

  it("accepts a window that opened a new period at the same percentage", () => {
    const reopened: ServerProviderUsageLimits = {
      ...stale,
      windows: stale.windows.map((window) =>
        window.id === "five_hour" ? { ...window, resetsAt: "2026-09-26T12:39:59.744Z" } : window,
      ),
    };
    expect(usageReflectsReset(before, reopened)).toBe(true);
  });

  it("does not count a failed or empty read as proof", () => {
    expect(usageReflectsReset(before, failed)).toBe(false);
    expect(usageReflectsReset(before, undefined)).toBe(false);
  });

  it("accepts any good read when nothing was published before", () => {
    expect(usageReflectsReset(undefined, stale)).toBe(true);
    expect(usageReflectsReset(failed, stale)).toBe(true);
  });
});

describe("confirmUsageAfterReset", () => {
  const scripted = (reads: ReadonlyArray<ServerProviderUsageLimits | undefined>) => {
    let calls = 0;
    const reprobe = Effect.sync(() => reads[Math.min(calls++, reads.length - 1)]);
    return { reprobe, calls: () => calls };
  };

  it.effect("re-reads past a lagging provider until the reset shows", () =>
    Effect.gen(function* () {
      const { reprobe, calls } = scripted([stale, reset]);
      const fiber = yield* confirmUsageAfterReset({ before, reprobe }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toBe("confirmed");
      expect(calls()).toBe(2);
    }),
  );

  it.effect("stops at the first read that shows the reset", () =>
    Effect.gen(function* () {
      const { reprobe, calls } = scripted([reset]);
      expect(yield* confirmUsageAfterReset({ before, reprobe })).toBe("confirmed");
      expect(calls()).toBe(1);
    }),
  );

  it.effect("reports lagging when every read shows the old windows", () =>
    Effect.gen(function* () {
      const { reprobe, calls } = scripted([stale]);
      const fiber = yield* confirmUsageAfterReset({ before, reprobe }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toBe("lagging");
      expect(calls()).toBe(RESET_CONFIRM_DELAYS.length);
    }),
  );

  it.effect("reports unconfirmed when no read succeeded", () =>
    Effect.gen(function* () {
      const { reprobe } = scripted([failed, undefined]);
      const fiber = yield* confirmUsageAfterReset({ before, reprobe }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toBe("unconfirmed");
    }),
  );
});
