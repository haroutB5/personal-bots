import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";

import {
  PROBE_BACKOFF_CAP,
  USAGE_RESET_GRACE,
  probeBackoffInterval,
  usageAwareWait,
} from "./probeBackoff.ts";

const minutes = (base: Duration.Input, failures: number) =>
  Duration.toMillis(probeBackoffInterval(base, failures)) / 60_000;

describe("probeBackoffInterval", () => {
  it("doubles the five-minute default once per consecutive failure, up to the cap", () => {
    expect([0, 1, 2, 3, 4, 5].map((failures) => minutes("5 minutes", failures))).toEqual([
      5, 10, 20, 30, 30, 30,
    ]);
  });

  it("never shortens an interval that is already longer than the cap", () => {
    // battery-saver probes every 15 minutes; an hour is a caller's explicit choice.
    expect(minutes("15 minutes", 0)).toBe(15);
    expect(minutes("15 minutes", 1)).toBe(30);
    expect(minutes("1 hour", 3)).toBe(60);
  });

  it("leaves a disabled refresh disabled", () => {
    expect(Duration.toMillis(probeBackoffInterval(0, 9))).toBe(0);
    expect(Duration.toMillis(probeBackoffInterval(-1, 9))).toBe(0);
  });

  it("cannot overflow to Infinity on a long outage", () => {
    expect(Duration.toMillis(probeBackoffInterval("5 minutes", 5_000))).toBe(
      Duration.toMillis(PROBE_BACKOFF_CAP),
    );
  });
});

describe("usageAwareWait", () => {
  const limits = (resetsAt: string | undefined) => ({
    checkedAt: "1970-01-01T00:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session" as const,
        label: "Session",
        usedPercent: 100,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      },
    ],
  });
  const waitMs = (resetsAt: string | undefined, nowMs: number) =>
    Duration.toMillis(usageAwareWait(Duration.minutes(5), limits(resetsAt), nowMs));

  it("wakes just after a reset that comes before the interval", () => {
    expect(waitMs("1970-01-01T00:02:00.000Z", 0)).toBe(
      120_000 + Duration.toMillis(USAGE_RESET_GRACE),
    );
  });

  it("keeps the interval when the next reset is further away or unknown", () => {
    expect(waitMs("1970-01-01T05:00:00.000Z", 0)).toBe(300_000);
    expect(waitMs(undefined, 0)).toBe(300_000);
    expect(Duration.toMillis(usageAwareWait(Duration.minutes(5), undefined, 0))).toBe(300_000);
  });

  it("ignores a reset already in the past, so it cannot spin the loop", () => {
    expect(waitMs("1970-01-01T00:00:00.000Z", 60_000)).toBe(300_000);
  });
});
