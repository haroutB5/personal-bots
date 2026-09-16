import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";

import { PROBE_BACKOFF_CAP, probeBackoffInterval } from "./probeBackoff.ts";

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
