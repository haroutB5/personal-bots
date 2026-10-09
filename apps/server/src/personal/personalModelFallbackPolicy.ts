import type { ModelSelection, ServerProvider, ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * When a bot that hit its provider's usage limit moves to its fallback model,
 * and when it moves back. Pure, so every rule is testable without a clock, a
 * database or a provider; `PersonalModelFallbackService` applies it.
 */

/** Set to "off" (or 0, false, no, disabled) to turn the whole feature off. */
export const PERSONAL_MODEL_FALLBACK_ENV = "PERSONAL_MODEL_FALLBACK";

export function modelFallbackEnabledByEnv(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !/^(off|0|false|no|disabled)$/i.test(value.trim());
}

/** A usage window at or above this has no room left. */
export const FALLBACK_LIMITED_PERCENT = 99;
/** Added to a reset before the bot goes back: a window reported as reset can still refuse the first second. */
export const FALLBACK_SWITCH_BACK_GRACE_MS = 15_000;
/** How often a switch-back is looked for. */
export const FALLBACK_SWEEP_MS = 30_000;
/** With no reset time reported, the home provider is re-checked this often. */
export const FALLBACK_RECHECK_MS = 10 * 60_000;
/** With no reset time and no usage readings at all, the bot goes back after this long (a 5-hour window). */
export const FALLBACK_DEFAULT_HOLD_MS = 5 * 60 * 60_000;
/** A reset further out than this (beyond a weekly window) is not believed. */
export const FALLBACK_MAX_RESET_MS = 8 * 24 * 60 * 60_000;
/** After a switch back, a limit hit within this time is not switched again (no ping-pong). */
export const FALLBACK_RESWITCH_COOLDOWN_MS = 60_000;
/** Only recent, successful readings can override a future recorded reset. */
export const FALLBACK_RECOVERY_FRESH_MS = 2 * 60_000;

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";

export function modelFamily(model: string): ModelFamily {
  const id = model.toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("fable")) return "fable";
  return "other";
}

/**
 * Which pool a limit belongs to, from the reason the provider gave. Claude
 * reports a weekly window per model family (`seven_day_opus`), which another
 * family on the same account does not share; everything else is one shared pool.
 */
export function limitPool(reason: string | null | undefined): "opus" | "sonnet" | "shared" {
  if (reason === undefined || reason === null) return "shared";
  const text = reason.toLowerCase();
  if (text.includes("opus")) return "opus";
  if (text.includes("sonnet")) return "sonnet";
  return "shared";
}

/** A usage window counts for a model when it is not another model family's own window. */
export function windowAppliesToModel(windowId: string, model: string): boolean {
  const pool = limitPool(windowId);
  if (pool === "shared") return true;
  return modelFamily(model) === pool;
}

export interface UsageRoom {
  /** False when a window that applies is spent. */
  readonly room: boolean;
  /** Whether the provider reported any window at all (false: nothing to go on). */
  readonly known: boolean;
  /** The latest reset among the spent windows that report one, epoch ms. */
  readonly resetsAtMs: number | null;
}

/** Room left on a provider for a model, from its latest usage readings. */
export function usageRoom(
  usage: ServerProviderUsageLimits | undefined,
  model: string,
  nowMs: number,
): UsageRoom {
  if (usage === undefined || usage.unavailable !== undefined || usage.windows.length === 0) {
    return { room: true, known: false, resetsAtMs: null };
  }
  let resetsAtMs: number | null = null;
  let spent = false;
  for (const window of usage.windows) {
    if (!windowAppliesToModel(window.id, model)) continue;
    if (window.usedPercent < FALLBACK_LIMITED_PERCENT) continue;
    const resets = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    // A spent window whose reset has passed is a lagging reading, not a limit.
    if (Number.isFinite(resets) && resets <= nowMs) continue;
    spent = true;
    if (Number.isFinite(resets)) resetsAtMs = Math.max(resetsAtMs ?? 0, resets);
  }
  return { room: !spent, known: true, resetsAtMs };
}

export type FallbackDecision =
  | { readonly kind: "switch"; readonly resetAtMs: number | null }
  | {
      readonly kind: "none";
      readonly reason:
        | "kill_switch"
        | "disabled"
        | "already_on_fallback"
        | "same_model"
        | "same_pool"
        | "fallback_unavailable"
        | "fallback_limited";
    };

export interface FallbackDecisionInput {
  readonly killSwitchOn: boolean;
  readonly botFallbackEnabled: boolean;
  /** The bot's saved model: the provider that hit the limit. */
  readonly home: ModelSelection;
  readonly fallback: ModelSelection;
  /** The bot is already running on its fallback. */
  readonly onFallback: boolean;
  /** Why the provider said it stopped (`providerRetry.reason`), when it did. */
  readonly reason: string | null | undefined;
  /** When the provider said the limit resets, epoch ms. */
  readonly retryAtMs: number | null;
  readonly nowMs: number;
  /** The snapshot of the fallback's provider instance; undefined when it is not configured. */
  readonly fallbackProvider: Pick<ServerProvider, "enabled" | "usageLimits"> | undefined;
  /** The fallback's provider is installed, signed in and ready to run turns. */
  readonly fallbackProviderReady: boolean;
  /** The snapshot of the provider that hit the limit, for the reset time. */
  readonly homeProvider: Pick<ServerProvider, "usageLimits"> | undefined;
}

/**
 * Whether a limit hit moves the bot to its fallback. It only does when the
 * fallback has room: a fallback on the same provider and pool shares the
 * limit, and a fallback whose own usage readings are spent would just hit the
 * wall again; both leave the bot waiting for the reset, as before.
 */
export function decideFallback(input: FallbackDecisionInput): FallbackDecision {
  if (!input.killSwitchOn) return { kind: "none", reason: "kill_switch" };
  if (!input.botFallbackEnabled) return { kind: "none", reason: "disabled" };
  if (input.onFallback) return { kind: "none", reason: "already_on_fallback" };
  if (
    input.home.instanceId === input.fallback.instanceId &&
    input.home.model === input.fallback.model
  ) {
    return { kind: "none", reason: "same_model" };
  }
  if (input.home.instanceId === input.fallback.instanceId) {
    // One provider, one account: the fallback shares the home limit unless the
    // provider split it by model family and the fallback is another family.
    const pool = limitPool(input.reason);
    if (pool === "shared" || modelFamily(input.fallback.model) === pool) {
      return { kind: "none", reason: "same_pool" };
    }
  }
  if (
    input.fallbackProvider === undefined ||
    !input.fallbackProvider.enabled ||
    !input.fallbackProviderReady
  ) {
    return { kind: "none", reason: "fallback_unavailable" };
  }
  if (!usageRoom(input.fallbackProvider.usageLimits, input.fallback.model, input.nowMs).room) {
    return { kind: "none", reason: "fallback_limited" };
  }
  return { kind: "switch", resetAtMs: resetTimeOf(input) };
}

/**
 * When the limit that stopped the bot resets: the provider's own reported
 * reset, else the latest spent window in its usage readings, else unknown.
 * A time in the past or further out than a week is not believed.
 */
export function resetTimeOf(input: {
  readonly retryAtMs: number | null;
  readonly home: ModelSelection;
  readonly homeProvider: Pick<ServerProvider, "usageLimits"> | undefined;
  readonly nowMs: number;
}): number | null {
  const believable = (ms: number | null): number | null =>
    ms !== null &&
    Number.isFinite(ms) &&
    ms > input.nowMs - 60_000 &&
    ms - input.nowMs <= FALLBACK_MAX_RESET_MS
      ? ms
      : null;
  const reported = believable(input.retryAtMs);
  if (reported !== null) return reported;
  const readings = usageRoom(input.homeProvider?.usageLimits, input.home.model, input.nowMs);
  return readings.room ? null : believable(readings.resetsAtMs);
}

export type SwitchBackDecision =
  | { readonly kind: "wait" }
  /** The reset moved: remember the later time. */
  | { readonly kind: "extend"; readonly resetAtMs: number }
  | {
      readonly kind: "back";
      readonly reason: "recovered" | "reset" | "recheck" | "hold_over" | "disabled";
    };

export interface SwitchBackInput {
  readonly killSwitchOn: boolean;
  readonly botFallbackEnabled: boolean;
  readonly nowMs: number;
  readonly startedAtMs: number;
  /** The reset time stored with the switch, epoch ms; null when none was reported. */
  readonly resetAtMs: number | null;
  readonly home: ModelSelection;
  /** The home provider's latest usage readings (re-read just before this call when due). */
  readonly homeProvider: Pick<ServerProvider, "usageLimits"> | undefined;
  /** No turn of the bot is running and no task is running for it. */
  readonly idle: boolean;
  /** Service verifies that this is still the original, ready provider instance. */
  readonly recoveryProviderReady?: boolean;
  readonly limitReason?: string | null;
}

export function primaryUsageRecovered(input: SwitchBackInput): boolean {
  const usage = input.homeProvider?.usageLimits;
  if (
    !input.recoveryProviderReady ||
    usage === undefined ||
    usage.unavailable ||
    usage.refreshFailed
  ) {
    return false;
  }
  const checked = Date.parse(usage.checkedAt);
  if (
    !Number.isFinite(checked) ||
    checked <= input.startedAtMs ||
    checked > input.nowMs ||
    input.nowMs - checked > FALLBACK_RECOVERY_FRESH_MS ||
    input.nowMs - input.startedAtMs < FALLBACK_SWITCH_BACK_GRACE_MS
  )
    return false;
  const windows = usage.windows.filter((window) =>
    windowAppliesToModel(window.id, input.home.model),
  );
  // A sparse update for another pool is not proof that the exhausted pool recovered.
  return (
    windows.some((window) => limitPool(window.id) === limitPool(input.limitReason)) &&
    windows.every(
      (window) =>
        Number.isFinite(window.usedPercent) && window.usedPercent < FALLBACK_LIMITED_PERCENT,
    )
  );
}

/**
 * Whether a bot on its fallback goes back to its own model. Only when idle:
 * a bot never changes model in the middle of a turn. A stored reset that has
 * passed is checked against the provider's readings once more (a window can
 * report a later reset than the first hit did), and a reset that was never
 * reported is found by re-checking the readings, with a long hold as the last
 * resort when the provider reports nothing at all.
 */
export function decideSwitchBack(input: SwitchBackInput): SwitchBackDecision {
  const off = !input.killSwitchOn || !input.botFallbackEnabled;
  if (off) return input.idle ? { kind: "back", reason: "disabled" } : { kind: "wait" };

  if (primaryUsageRecovered(input)) {
    return input.idle ? { kind: "back", reason: "recovered" } : { kind: "wait" };
  }

  const readings = usageRoom(input.homeProvider?.usageLimits, input.home.model, input.nowMs);
  if (input.resetAtMs !== null) {
    if (input.nowMs < input.resetAtMs + FALLBACK_SWITCH_BACK_GRACE_MS) return { kind: "wait" };
    // The reported reset has passed; the provider still says it is spent.
    if (readings.known && !readings.room) {
      return readings.resetsAtMs !== null && readings.resetsAtMs > input.resetAtMs
        ? { kind: "extend", resetAtMs: readings.resetsAtMs }
        : { kind: "wait" };
    }
    return input.idle ? { kind: "back", reason: "reset" } : { kind: "wait" };
  }

  if (readings.known) {
    if (!readings.room) {
      return readings.resetsAtMs !== null
        ? { kind: "extend", resetAtMs: readings.resetsAtMs }
        : { kind: "wait" };
    }
    if (input.nowMs - input.startedAtMs < FALLBACK_RECHECK_MS) return { kind: "wait" };
    return input.idle ? { kind: "back", reason: "recheck" } : { kind: "wait" };
  }
  // Nothing reported: hold for a full 5-hour window, then try the home model again.
  if (input.nowMs - input.startedAtMs < FALLBACK_DEFAULT_HOLD_MS) return { kind: "wait" };
  return input.idle ? { kind: "back", reason: "hold_over" } : { kind: "wait" };
}

/** "Sonnet 5.5 · H": the model's short label for the muted line, from its id and effort. */
export function fallbackModelLabel(model: ModelSelection): string {
  const id = model.model;
  const effort =
    model.options?.find((option) => option.id === "effort" || option.id === "reasoningEffort")
      ?.value ?? null;
  const family = modelFamily(id);
  const version = /(\d+(?:[.-]\d+)*)/.exec(id)?.[1]?.replace(/-/g, ".") ?? "";
  const name =
    family === "other"
      ? id
      : `${family[0]!.toUpperCase()}${family.slice(1)}${version === "" ? "" : ` ${version}`}`;
  const letter =
    typeof effort === "string" && effort.length > 0 ? ` · ${effort[0]!.toUpperCase()}` : "";
  return `${name}${letter}`;
}
