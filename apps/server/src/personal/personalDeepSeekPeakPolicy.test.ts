import { PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  deepSeekPeakEnabledByEnv,
  deepSeekPeakWindowEndMs,
  isPeakAt,
  isPeakFallback,
  parsePeakClockOverride,
  peakDecisionNowMs,
  planPeakFallback,
  type PeakPlanInput,
} from "./personalDeepSeekPeakPolicy.ts";

/** Thursday 15 October 2026, the first peak day after this release. */
const THURSDAY = "2026-10-15";
/** The Saturday of the same week. */
const SATURDAY = "2026-10-17";
const SUNDAY = "2026-10-18";

const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000Z`);
const hhmmUtc = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(11, 16);

const base = (patch: Partial<PeakPlanInput> = {}): PeakPlanInput => ({
  atMs: at(THURSDAY, "02:00"),
  killSwitchOn: true,
  instanceSettingOn: true,
  homeIsDeepSeek: true,
  onUsageLimitFallback: false,
  onPeakFallback: false,
  ...patch,
});

describe("the DeepSeek peak window", () => {
  it("opens at 01:00 and 06:00 UTC on a weekday and closes at 04:00 and 10:00", () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ["00:59", false],
      ["01:00", true],
      ["03:59", true],
      ["04:00", false],
      ["05:59", false],
      ["06:00", true],
      ["09:59", true],
      ["10:00", false],
      ["23:59", false],
    ];
    for (const [time, peak] of cases) {
      expect(isPeakAt(at(THURSDAY, time)), time).toBe(peak);
    }
  });

  it("is off all weekend, including the weekday hours", () => {
    for (const day of [SATURDAY, SUNDAY]) {
      for (const time of ["01:00", "02:30", "06:00", "09:59"]) {
        expect(isPeakAt(at(day, time)), `${day} ${time}`).toBe(false);
      }
    }
  });

  it("ends at 04:00 or 10:00 UTC, and is null outside a window", () => {
    expect(hhmmUtc(deepSeekPeakWindowEndMs(at(THURSDAY, "01:00"))!)).toBe("04:00");
    expect(hhmmUtc(deepSeekPeakWindowEndMs(at(THURSDAY, "03:59"))!)).toBe("04:00");
    expect(hhmmUtc(deepSeekPeakWindowEndMs(at(THURSDAY, "06:00"))!)).toBe("10:00");
    expect(hhmmUtc(deepSeekPeakWindowEndMs(at(THURSDAY, "09:59"))!)).toBe("10:00");
    expect(deepSeekPeakWindowEndMs(at(THURSDAY, "04:00"))).toBeNull();
    expect(deepSeekPeakWindowEndMs(at(THURSDAY, "05:59"))).toBeNull();
    expect(deepSeekPeakWindowEndMs(at(THURSDAY, "10:00"))).toBeNull();
    expect(deepSeekPeakWindowEndMs(at(SATURDAY, "02:00"))).toBeNull();
  });

  it("works in UTC across the 25 October clock change", () => {
    // 06:00-10:00 UTC is 07:00-11:00 BST before the change and 06:00-10:00 GMT
    // after it; the window itself does not move.
    const before = deepSeekPeakWindowEndMs(at("2026-10-23", "06:00"))!;
    const after = deepSeekPeakWindowEndMs(at("2026-10-27", "06:00"))!;
    expect(hhmmUtc(before)).toBe("10:00");
    expect(hhmmUtc(after)).toBe("10:00");
  });
});

describe("planPeakFallback", () => {
  it("puts a DeepSeek bot on the peak model until the window ends", () => {
    expect(planPeakFallback(base())).toEqual({
      kind: "switch_on",
      untilMs: at(THURSDAY, "04:00"),
    });
    expect(planPeakFallback(base({ atMs: at(THURSDAY, "07:15") }))).toEqual({
      kind: "switch_on",
      untilMs: at(THURSDAY, "10:00"),
    });
  });

  it("does nothing off-peak, at the weekend, or for a bot that is not DeepSeek", () => {
    expect(planPeakFallback(base({ atMs: at(THURSDAY, "00:59") }))).toEqual({
      kind: "none",
      reason: "off_peak",
    });
    expect(planPeakFallback(base({ atMs: at(THURSDAY, "04:00") }))).toEqual({
      kind: "none",
      reason: "off_peak",
    });
    expect(planPeakFallback(base({ atMs: at(THURSDAY, "10:00") }))).toEqual({
      kind: "none",
      reason: "off_peak",
    });
    expect(planPeakFallback(base({ atMs: at(SATURDAY, "02:00") }))).toEqual({
      kind: "none",
      reason: "off_peak",
    });
    expect(planPeakFallback(base({ homeIsDeepSeek: false }))).toEqual({
      kind: "none",
      reason: "not_deepseek",
    });
  });

  it("honours the kill switch and the instance setting", () => {
    expect(planPeakFallback(base({ killSwitchOn: false }))).toEqual({
      kind: "none",
      reason: "kill_switch",
    });
    expect(planPeakFallback(base({ instanceSettingOn: false }))).toEqual({
      kind: "none",
      reason: "setting_off",
    });
  });

  it("never touches a bot that is on a usage-limit fallback", () => {
    expect(planPeakFallback(base({ onUsageLimitFallback: true }))).toEqual({
      kind: "none",
      reason: "on_limit_fallback",
    });
    // Even off-peak and with everything switched off, a limit row is left alone.
    expect(
      planPeakFallback(
        base({ onUsageLimitFallback: true, onPeakFallback: false, killSwitchOn: false }),
      ),
    ).toEqual({ kind: "none", reason: "on_limit_fallback" });
  });

  it("keeps a peak bot on the model inside the window, and updates the end time", () => {
    expect(planPeakFallback(base({ onPeakFallback: true }))).toEqual({
      kind: "keep",
      untilMs: at(THURSDAY, "04:00"),
    });
    expect(planPeakFallback(base({ onPeakFallback: true, atMs: at(THURSDAY, "06:30") }))).toEqual({
      kind: "keep",
      untilMs: at(THURSDAY, "10:00"),
    });
  });

  it("clears a peak bot when the window closes, the switches go off, or it is no longer DeepSeek", () => {
    expect(planPeakFallback(base({ onPeakFallback: true, atMs: at(THURSDAY, "04:00") }))).toEqual({
      kind: "switch_off",
      reason: "peak_ended",
    });
    expect(planPeakFallback(base({ onPeakFallback: true, atMs: at(SATURDAY, "02:00") }))).toEqual({
      kind: "switch_off",
      reason: "peak_ended",
    });
    expect(planPeakFallback(base({ onPeakFallback: true, killSwitchOn: false }))).toEqual({
      kind: "switch_off",
      reason: "kill_switch",
    });
    expect(planPeakFallback(base({ onPeakFallback: true, instanceSettingOn: false }))).toEqual({
      kind: "switch_off",
      reason: "setting_off",
    });
    expect(planPeakFallback(base({ onPeakFallback: true, homeIsDeepSeek: false }))).toEqual({
      kind: "switch_off",
      reason: "no_longer_deepseek",
    });
  });
});

describe("the peak clock", () => {
  it("reads the kill switch the same way the model fallback does", () => {
    expect(deepSeekPeakEnabledByEnv(undefined)).toBe(true);
    expect(deepSeekPeakEnabledByEnv("on")).toBe(true);
    expect(deepSeekPeakEnabledByEnv("off")).toBe(false);
    expect(deepSeekPeakEnabledByEnv(" OFF ")).toBe(false);
    expect(deepSeekPeakEnabledByEnv("0")).toBe(false);
    expect(deepSeekPeakEnabledByEnv("false")).toBe(false);
    expect(deepSeekPeakEnabledByEnv("no")).toBe(false);
  });

  it("parses the test override as epoch ms or an ISO instant", () => {
    expect(parsePeakClockOverride(undefined)).toBeNull();
    expect(parsePeakClockOverride("")).toBeNull();
    expect(parsePeakClockOverride("  ")).toBeNull();
    expect(parsePeakClockOverride(String(at(THURSDAY, "02:00")))).toBe(at(THURSDAY, "02:00"));
    expect(parsePeakClockOverride("2026-10-15T02:00:00.000Z")).toBe(at(THURSDAY, "02:00"));
    expect(parsePeakClockOverride("not a time")).toBeNull();
  });

  it("uses the override only when one is set", () => {
    expect(peakDecisionNowMs(1000, null)).toBe(1000);
    expect(peakDecisionNowMs(1000, 2000)).toBe(2000);
  });

  it("recognises only the peak reason as a peak row", () => {
    expect(isPeakFallback({ reason: PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK })).toBe(true);
    expect(isPeakFallback({ reason: "usage_limit" })).toBe(false);
    expect(isPeakFallback({ reason: null })).toBe(false);
  });
});
