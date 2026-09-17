import type { OrchestrationSession } from "@t3tools/contracts";
import { classifyTurnFailure, isTransientTurnFailureKind } from "@t3tools/shared/turnFailure";

/**
 * Waits before each automatic attempt. Two attempts only, and the gap grows so
 * a provider that is coming back up gets a second chance well after the first.
 *
 * The cap is the whole safety story: every attempt re-runs a real turn against
 * a real model, so a provider that is properly down must cost at most two extra
 * runs, not a loop.
 */
export const PERSONAL_TURN_RETRY_DELAYS_MS = [5_000, 30_000] as const;

export const PERSONAL_TURN_RETRY_MAX_ATTEMPTS = PERSONAL_TURN_RETRY_DELAYS_MS.length;

/** What the reactor knows about the turn currently on a thread. */
export interface TrackedTurn {
  /**
   * The turn was started by a personal task or routine, not by the owner
   * typing. Those have their own attempt/backoff ledger in
   * PersonalTaskService, so retrying here would run the work twice.
   */
  readonly taskDriven: boolean;
  /** Automatic attempts already spent on this turn. */
  readonly attempts: number;
}

export type TurnRetrySkipReason =
  | "session_not_failed"
  /** The turn is still running, or a new one already started. */
  | "turn_still_active"
  | "no_error_text"
  /** A refusal, a limit, or a stop: running it again cannot help. */
  | "not_transient"
  /** The provider itself reported a rate-limit wait. */
  | "provider_rate_limited"
  /** Our own marker came back round the event loop. */
  | "already_marked"
  /** No turn of ours is on this thread (fresh process, or never saw it start). */
  | "turn_not_tracked"
  | "task_driven";

export type TurnRetryDecision =
  | { readonly kind: "retry"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "exhausted" }
  | { readonly kind: "skip"; readonly reason: TurnRetrySkipReason };

/**
 * Whether a failed session should have its turn run again, and after how long.
 *
 * Every "no" is named rather than collapsed into a boolean so the reactor can
 * log which gate stopped it; a retry that silently never fires and a retry that
 * fires when it must not are both expensive, and both are otherwise invisible.
 */
export function decideTurnRetry(input: {
  readonly session: Pick<
    OrchestrationSession,
    "status" | "lastError" | "activeTurnId" | "providerRetry"
  >;
  readonly tracked: TrackedTurn | null;
}): TurnRetryDecision {
  const { session, tracked } = input;
  if (session.status !== "error") return { kind: "skip", reason: "session_not_failed" };
  if (session.activeTurnId !== null) return { kind: "skip", reason: "turn_still_active" };
  if (session.providerRetry?.auto !== undefined) {
    return { kind: "skip", reason: "already_marked" };
  }
  if (session.providerRetry?.kind === "rate_limited") {
    return { kind: "skip", reason: "provider_rate_limited" };
  }
  const lastError = session.lastError;
  if (lastError === null || lastError.trim().length === 0) {
    return { kind: "skip", reason: "no_error_text" };
  }
  if (!isTransientTurnFailureKind(classifyTurnFailure(lastError))) {
    return { kind: "skip", reason: "not_transient" };
  }
  // No tracked turn means this process never saw the owner's message go out:
  // a restart, or a turn some other path started. Fail closed rather than
  // spend a model run on a turn whose origin we cannot vouch for.
  if (tracked === null) return { kind: "skip", reason: "turn_not_tracked" };
  if (tracked.taskDriven) return { kind: "skip", reason: "task_driven" };
  const delayMs = PERSONAL_TURN_RETRY_DELAYS_MS[tracked.attempts];
  if (delayMs === undefined) return { kind: "exhausted" };
  return { kind: "retry", attempt: tracked.attempts + 1, delayMs };
}
