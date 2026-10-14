import { PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { isDeepSeekPeakTime } from "../usage/usagePricing.ts";

/**
 * DeepSeek peak-hours switch (1.66.44).
 *
 * Harout's rule: "From now on dont use deepseek if we are not in the off peak
 * hours. Use sonnet 5.5 high instead." DeepSeek bills double during its peak
 * windows, so while one is open every bot whose own model is DeepSeek runs on
 * Claude Sonnet 5.5 High instead, and moves back when the window closes.
 *
 * The windows themselves are the ones the usage screen already prices against
 * (`isDeepSeekPeakTime`): 01:00-04:00 and 06:00-10:00 UTC, Monday through
 * Friday. That function is the single source; nothing here re-states the hours,
 * and everything is decided in UTC (clocks change on 25 Oct, labels are local).
 *
 * Pure, so the whole schedule is testable with an injected clock.
 */

/** Set to "off" (or 0, false, no, disabled) to turn the whole switch off. */
export const PERSONAL_DEEPSEEK_PEAK_ENV = "PERSONAL_DEEPSEEK_PEAK_SWITCH";

export function deepSeekPeakEnabledByEnv(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !/^(off|0|false|no|disabled)$/i.test(value.trim());
}

/**
 * Tests only: an instant that replaces the clock for the peak decision, so both
 * switch-overs can be driven without waiting for a real window. Epoch
 * milliseconds ("1750000000000") or an ISO instant ("2026-10-15T03:30:00Z").
 * Read on every sweep, so it can be set without a restart of the code path.
 */
export const PERSONAL_DEEPSEEK_PEAK_NOW_ENV = "PERSONAL_DEEPSEEK_PEAK_NOW";

export function parsePeakClockOverride(value: string | undefined): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) {
    const ms = Number(text);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = DateTime.make(text);
  return Option.isNone(parsed) ? null : DateTime.toEpochMillis(parsed.value);
}

/** The clock the peak decision reads: the override when one is set, else the real time. */
export function peakDecisionNowMs(realNowMs: number, overrideMs: number | null): number {
  return overrideMs === null ? realNowMs : overrideMs;
}

/** True while a DeepSeek peak window is open at `atMs`. */
export const isPeakAt = isDeepSeekPeakTime;

/** True when a stored fallback row is the peak switch rather than a usage limit. */
export const isPeakFallback = (state: { readonly reason: string | null }): boolean =>
  state.reason === PERSONAL_FALLBACK_REASON_DEEPSEEK_PEAK;

/**
 * When the peak window open at `atMs` ends, epoch ms; null when it is not peak
 * (a weekend included). The windows are [01:00,04:00) and [06:00,10:00) UTC.
 */
export function deepSeekPeakWindowEndMs(atMs: number): number | null {
  const at = DateTime.make(atMs);
  if (Option.isNone(at)) return null;
  const parts = DateTime.toParts(at.value);
  const utcDay = parts.weekDay; // 0 Sunday .. 6 Saturday
  if (utcDay === 0 || utcDay === 6) return null;
  const endHour =
    parts.hour >= 1 && parts.hour < 4 ? 4 : parts.hour >= 6 && parts.hour < 10 ? 10 : null;
  if (endHour === null) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day, endHour, 0, 0, 0);
}

export interface PeakPlanInput {
  /** The peak clock: the real time, or the test override. */
  readonly atMs: number;
  /** `PERSONAL_DEEPSEEK_PEAK_SWITCH` is on. */
  readonly killSwitchOn: boolean;
  /** The DeepSeek instance's own "during peak hours" setting is on. */
  readonly instanceSettingOn: boolean;
  /** The bot's own (saved) model runs on a DeepSeek instance. */
  readonly homeIsDeepSeek: boolean;
  /** The bot is on a usage-limit fallback: never touched by the peak switch. */
  readonly onUsageLimitFallback: boolean;
  /** The bot is already on a DeepSeek-peak fallback. */
  readonly onPeakFallback: boolean;
}

export type PeakPlan =
  /** Put the bot on the peak model until `untilMs`. */
  | { readonly kind: "switch_on"; readonly untilMs: number }
  /** Take the bot off the peak model. */
  | {
      readonly kind: "switch_off";
      readonly reason: "kill_switch" | "setting_off" | "peak_ended" | "no_longer_deepseek";
    }
  /** The bot is on the peak model and should stay; `untilMs` when the window ends. */
  | { readonly kind: "keep"; readonly untilMs: number | null }
  | {
      readonly kind: "none";
      readonly reason:
        | "on_limit_fallback"
        | "kill_switch"
        | "setting_off"
        | "off_peak"
        | "not_deepseek";
    };

/**
 * What the peak switch should do with one bot on this pass. A bot on a
 * usage-limit fallback is left alone in both directions: that switch owns it
 * until its limit resets, and the peak state is applied on a later pass.
 */
export function planPeakFallback(input: PeakPlanInput): PeakPlan {
  const untilMs = isPeakAt(input.atMs) ? deepSeekPeakWindowEndMs(input.atMs) : null;

  if (input.onPeakFallback) {
    if (!input.killSwitchOn) return { kind: "switch_off", reason: "kill_switch" };
    if (!input.instanceSettingOn) return { kind: "switch_off", reason: "setting_off" };
    if (!input.homeIsDeepSeek) return { kind: "switch_off", reason: "no_longer_deepseek" };
    if (untilMs === null) return { kind: "switch_off", reason: "peak_ended" };
    return { kind: "keep", untilMs };
  }

  if (input.onUsageLimitFallback) return { kind: "none", reason: "on_limit_fallback" };
  if (!input.killSwitchOn) return { kind: "none", reason: "kill_switch" };
  if (!input.instanceSettingOn) return { kind: "none", reason: "setting_off" };
  if (untilMs === null) return { kind: "none", reason: "off_peak" };
  if (!input.homeIsDeepSeek) return { kind: "none", reason: "not_deepseek" };
  return { kind: "switch_on", untilMs };
}
