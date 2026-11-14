import * as DateTime from "effect/DateTime";

import type { OrchestrationSession } from "@t3tools/contracts";

import { isProviderCapacityError } from "../personalModelFallbackPolicy.ts";

/**
 * What a task does when its provider says no: a rate limit, a usage limit, a
 * retry wait, a conversation the provider lost. Pure functions over what the
 * session and the attempt history say, so the task service only has to apply
 * the answer. Nothing here reads a clock or a database.
 */

/** Backoff before each rate-limited re-run; one more rate limit fails the task, unless it is a usage limit. */
export const PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES = [1, 5, 15] as const;

/** A usage limit with no reported reset is tried this often once the backoff is spent. */
export const PERSONAL_TASKS_USAGE_LIMIT_RETRY_MINUTES = 30;

/**
 * The longest window a usage limit spans (a weekly limit). A task still limited
 * this long after its first limited attempt has a problem the reset will not
 * fix, so it fails.
 */
export const PERSONAL_TASKS_USAGE_LIMIT_MAX_WAIT_MS = 7 * 24 * 60 * 60_000;

/** A task runs this long after a reported reset: a window reported as reset can still refuse the first minute. */
export const PERSONAL_TASKS_LIMIT_RESET_GRACE_MS = 60_000;

/**
 * A turn that ends on "No conversation found" is followed by the app's own
 * renewal: a fresh session that sends the same message again. The attempt
 * waits this long for the renewal to start before that error counts as its end.
 */
export const PERSONAL_TASKS_RENEWAL_WAIT_MS = 60_000;

/**
 * A turn lost to a dead provider server is continued by a new run within seconds.
 * The attempt waits this long for that run before the loss counts as its end.
 */
export const PERSONAL_TASKS_SERVER_LOSS_WAIT_MS = 90_000;

/** A provider wait longer than this gives the task's slot back instead of holding it. */
export const PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS = 2 * 60_000;

/**
 * A turn that fails on a limit reports the error first and the limit's details
 * (reset time, provider) on the turn's completion right after (Codex order). An
 * error that reads like a limit, on a turn that has not completed yet, waits this
 * long for those details before the attempt settles on it. The 30 s sweep
 * settles it if they never come.
 */
export const PERSONAL_TASKS_LIMIT_DETAIL_WAIT_MS = 10_000;

const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|\b429\b|\b529\b|overloaded|capacity|try a different model|quota|usage limit|provider.{0,40}unavailable|service unavailable|\b503\b/i;

/** Rate limits and an unreachable provider back off; anything else fails the attempt. */
export const classifyProviderError = (message: string | null): "rate_limited" | "provider_error" =>
  message !== null && RATE_LIMIT_PATTERN.test(message) ? "rate_limited" : "provider_error";

/**
 * The wait the provider reported during this attempt. The session carries the
 * last wait of the thread, so one reported before the attempt started belongs to
 * an earlier attempt (the one that just hit the limit) and says nothing about
 * this one.
 */
export const providerRetryOfAttempt = (
  retry: OrchestrationSession["providerRetry"] | null,
  attemptStartedAtMs: number,
): OrchestrationSession["providerRetry"] => {
  if (retry === undefined || retry === null) return undefined;
  const observedAtMs = Date.parse(retry.observedAt);
  return Number.isFinite(observedAtMs) && observedAtMs < attemptStartedAtMs ? undefined : retry;
};

export interface ProviderWaitPause {
  readonly retry: NonNullable<OrchestrationSession["providerRetry"]>;
  /** The provider's reported next attempt / reset; null = not reported (use the backoff). */
  readonly retryAtMs: number | null;
}

/**
 * Whether a running task turn should stop waiting on its provider. A reported
 * wait (rate limit or retry) pauses when it is more than two minutes out; a
 * rate limit that reports no reset always pauses. Short retries are left to
 * the provider.
 */
export const providerWaitPause = (
  retry: OrchestrationSession["providerRetry"],
  nowMs: number,
): ProviderWaitPause | null => {
  if (retry === undefined) return null;
  const retryAtMs = retry.retryAt === undefined ? Number.NaN : Date.parse(retry.retryAt);
  if (!Number.isFinite(retryAtMs)) {
    return retry.kind === "rate_limited" ? { retry, retryAtMs: null } : null;
  }
  return retryAtMs - nowMs > PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS ? { retry, retryAtMs } : null;
};

/** The sentence a task shows when it gives its slot back to a provider wait. */
export const providerWaitMessage = (pause: ProviderWaitPause): string => {
  const { retry, retryAtMs } = pause;
  const what = retry.kind === "rate_limited" ? "rate limited" : "retrying";
  const detail = retry.reason === undefined ? "" : ` (${retry.reason})`;
  return retryAtMs === null
    ? `The provider is ${what}${detail} and did not report when the limit resets.`
    : `The provider is ${what}${detail}; its next attempt is at ${DateTime.formatIso(DateTime.makeUnsafe(retryAtMs))}.`;
};

/** How many of the newest attempts, counting back from the last, ended on a rate limit. */
export const consecutiveRateLimited = (categories: ReadonlyArray<string | null>): number => {
  let consecutive = 0;
  for (const category of categories.toReversed()) {
    if (category !== "rate_limited") break;
    consecutive += 1;
  }
  return consecutive;
};

/**
 * A rate-limited attempt that needs no guess about the wait: the bot's model
 * fallback took over (run again at once), or the provider reported a reset that
 * is still ahead (run just after it, rather than spending the unreported-limit
 * backoff budget). null means neither: fall through to the backoff.
 */
export type ImmediateRateLimitRetry =
  | { readonly kind: "run_now" }
  | { readonly kind: "at"; readonly availableAtMs: number };

export const immediateRateLimitRetry = (input: {
  readonly fallbackSwitched: boolean;
  readonly reportedResetMs: number | null;
  readonly nowMs: number;
}): ImmediateRateLimitRetry | null => {
  if (input.fallbackSwitched) return { kind: "run_now" };
  if (input.reportedResetMs !== null && input.reportedResetMs > input.nowMs) {
    return {
      kind: "at",
      availableAtMs: input.reportedResetMs + PERSONAL_TASKS_LIMIT_RESET_GRACE_MS,
    };
  }
  return null;
};

/**
 * The wait for the nth consecutive rate limit, or undefined once the budget is
 * spent (fail the task). A usage limit outlasts the short backoff (a 5-hour
 * window is longer than its 21 minutes), so it keeps a slow retry until it has
 * lasted longer than any window could.
 */
export const rateLimitBackoffMinutes = (input: {
  readonly consecutive: number;
  readonly usageLimit: boolean;
  /** How long ago the first attempt of this run of rate limits started. */
  readonly limitedForMs: number;
}): number | undefined => {
  const listed = PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES[input.consecutive - 1];
  if (listed !== undefined || !input.usageLimit) return listed;
  return input.limitedForMs < PERSONAL_TASKS_USAGE_LIMIT_MAX_WAIT_MS
    ? PERSONAL_TASKS_USAGE_LIMIT_RETRY_MINUTES
    : undefined;
};

/** What a task waiting on a usage limit says, next to the time it runs again. */
export const usageLimitWaitMessage = (resetKnown: boolean): string =>
  resetKnown
    ? "Usage limit reached. The task runs again by itself just after the limit resets."
    : "Usage limit reached. The provider did not say when it resets, so the task tries again by itself at the time shown.";

/**
 * What an attempt whose session ended in `error` does next.
 *
 * `wait` leaves the attempt open: the failed resume reports its error before
 * the app's renewal starts the fresh session (the renewal is the same attempt),
 * and a limit's details arrive on the turn's completion right after the error.
 * `renewalWaitSinceMs` is the instant the renewal wait began, to remember; it
 * is absent when the wait is for limit details. `finish` ends the attempt as
 * failed with this category, and the limit the provider reported (if any) and
 * the reset it named.
 */
export type SessionErrorSettlement =
  | { readonly kind: "wait"; readonly renewalWaitSinceMs?: number }
  | {
      readonly kind: "finish";
      /** The renewal wait ran out (or never opened): forget it. */
      readonly clearRenewalWait: boolean;
      readonly category: "rate_limited" | "provider_error";
      readonly limit?: {
        readonly provider: string;
        readonly reason: string | undefined;
        readonly retryAt?: string | undefined;
        /** The provider was at capacity, not out of a usage window. */
        readonly capacity?: boolean;
      };
      /** The reset the provider reported for the limit, when it named one. */
      readonly resetAtMs?: number;
      /** The turn stopped on a usage limit, which a reset ends: the task waits, it does not fail. */
      readonly usageLimit?: true;
    };

export const settleSessionError = (input: {
  readonly lastError: string | null;
  /** The error reads like "No conversation found" (the provider lost the session). */
  readonly lostConversation: boolean;
  /** When this attempt's renewal wait began, if one is open. */
  readonly renewalWaitSinceMs: number | undefined;
  readonly nowMs: number;
  readonly providerRetry: OrchestrationSession["providerRetry"];
  readonly attemptStartedAtMs: number;
  /** The provider that ran the attempt, for a limit it did not report itself. */
  readonly providerName?: string | null | undefined;
  readonly activeTurnId: string | null;
  /** When the session last changed, epoch ms (NaN when unparseable). */
  readonly sessionUpdatedAtMs: number;
  /** The session's latest turn failed on a usage limit; `resetAt` when the provider named it. */
  readonly usageLimit?: { readonly resetAt?: string } | undefined;
}): SessionErrorSettlement => {
  let clearRenewalWait = false;
  if (input.lostConversation || input.renewalWaitSinceMs !== undefined) {
    const since = input.renewalWaitSinceMs ?? input.nowMs;
    if (input.nowMs - since < PERSONAL_TASKS_RENEWAL_WAIT_MS) {
      return { kind: "wait", renewalWaitSinceMs: since };
    }
    clearRenewalWait = true;
  }
  // A turn that failed on a rate limit the adapter recognised waits for the
  // reset it reported (Codex usage limits), not a pattern guess.
  const ownRetry = providerRetryOfAttempt(input.providerRetry, input.attemptStartedAtMs);
  const limit = ownRetry?.kind === "rate_limited" ? ownRetry : undefined;
  const usageLimited = limit !== undefined || input.usageLimit !== undefined;
  // The error comes first and the turn's completion, which carries the limit's
  // details, right after: give them a moment so a limited task gets its
  // fallback or its reported reset instead of a guessed backoff.
  if (
    !usageLimited &&
    input.activeTurnId !== null &&
    classifyProviderError(input.lastError) === "rate_limited" &&
    input.nowMs - input.sessionUpdatedAtMs < PERSONAL_TASKS_LIMIT_DETAIL_WAIT_MS
  ) {
    return { kind: "wait" };
  }
  const resetAt = limit?.retryAt ?? input.usageLimit?.resetAt;
  const resetMs = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  // A capacity/overloaded error spends no window and reports no retry, but it
  // is not a broken turn either: it takes the same fallback path as a limit so
  // the task carries on on the bot's fallback model instead of ending.
  const capacity = !usageLimited && isProviderCapacityError(input.lastError);
  return {
    kind: "finish",
    clearRenewalWait,
    category: usageLimited || capacity ? "rate_limited" : classifyProviderError(input.lastError),
    ...(limit === undefined
      ? capacity
        ? {
            limit: {
              provider: input.providerName ?? "",
              reason: input.lastError ?? undefined,
              capacity: true,
            },
          }
        : {}
      : { limit: { provider: limit.provider, reason: limit.reason, retryAt: limit.retryAt } }),
    ...(Number.isFinite(resetMs) ? { resetAtMs: resetMs } : {}),
    ...(usageLimited ? { usageLimit: true as const } : {}),
  };
};
