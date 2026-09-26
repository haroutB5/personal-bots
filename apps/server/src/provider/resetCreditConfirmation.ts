/**
 * After a reset credit is redeemed the provider's usage endpoint can take a
 * few seconds to reflect it. A re-probe inside that gap reads the old windows,
 * and a cached probe then pins them (seen live on 2026-09-26: Claude showed
 * Weekly 100% for minutes while Anthropic already reported 0%). This module
 * decides whether a read reflects the reset and re-reads until it does.
 *
 * @module provider/resetCreditConfirmation
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** Provider reset times jitter by fractions of a second between reads. */
const RESET_MOVED_MS = 60_000;

/** Waits before each re-read while the redeem call is still open. */
export const RESET_CONFIRM_DELAYS: ReadonlyArray<Duration.Input> = [0, "2 seconds", "5 seconds"];

/** Background re-reads after the redeem answered, if the provider still lagged. */
export const RESET_FOLLOW_UP_DELAYS: ReadonlyArray<Duration.Input> = [
  "30 seconds",
  "90 seconds",
  "3 minutes",
];

export const RESET_LAGGING_WARNING =
  "Reset applied. The provider's usage figures have not caught up yet; they will update on their own in a few minutes.";

export const RESET_UNCONFIRMED_WARNING =
  "Reset applied, but the new limits could not be read. Refresh to check.";

/**
 * True when `after` shows the reset: some window that was published before
 * the redeem is now lower, or opened a new period. A read with no windows,
 * or a failed read, proves nothing.
 */
export function usageReflectsReset(
  before: ServerProviderUsageLimits | undefined,
  after: ServerProviderUsageLimits | undefined,
): boolean {
  if (after === undefined || after.unavailable !== undefined || after.windows.length === 0) {
    return false;
  }
  const previous = before?.unavailable === undefined ? (before?.windows ?? []) : [];
  if (previous.length === 0) return true;
  const byId = new Map(after.windows.map((window) => [window.id, window] as const));
  return previous.some((old) => {
    const next = byId.get(old.id);
    if (next === undefined) return false;
    if (next.usedPercent < old.usedPercent) return true;
    if (old.resetsAt === undefined || next.resetsAt === undefined) return false;
    return Math.abs(Date.parse(next.resetsAt) - Date.parse(old.resetsAt)) > RESET_MOVED_MS;
  });
}

export type ResetConfirmation = "confirmed" | "lagging" | "unconfirmed";

/**
 * Re-read (`reprobe` must bypass any usage cache) after each delay until the
 * limits reflect the reset. `lagging` means the provider answered with the
 * pre-redeem windows every time; `unconfirmed` means no read succeeded.
 */
export const confirmUsageAfterReset = <E, R>(input: {
  readonly before: ServerProviderUsageLimits | undefined;
  readonly reprobe: Effect.Effect<ServerProviderUsageLimits | undefined, E, R>;
  readonly delays?: ReadonlyArray<Duration.Input>;
}): Effect.Effect<ResetConfirmation, E, R> =>
  Effect.gen(function* () {
    let answered = false;
    for (const delay of input.delays ?? RESET_CONFIRM_DELAYS) {
      if (Duration.toMillis(Duration.fromInputUnsafe(delay)) > 0) yield* Effect.sleep(delay);
      const after = yield* input.reprobe;
      if (usageReflectsReset(input.before, after)) return "confirmed";
      if (after !== undefined && after.unavailable === undefined) answered = true;
    }
    return answered ? "lagging" : "unconfirmed";
  });
