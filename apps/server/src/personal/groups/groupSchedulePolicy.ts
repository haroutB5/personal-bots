import { windowMsFor } from "./groupShared.ts";

/**
 * Which round speaks next and what a throttled member costs the round. Pure
 * functions over a round's own fields; the group service reads the clock and
 * the tables and applies the answer. The loop protection and the budget
 * themselves are in groupRoundPolicy.ts.
 */

export type NextRound<Round> =
  | { readonly kind: "busy" }
  | { readonly kind: "none" }
  | { readonly kind: "round"; readonly round: Round };

/**
 * The round to run next. While `concurrency` members are speaking, nothing
 * starts (the slot is disjoint from the task system's own five). Otherwise
 * the first round that is running and not waiting on a provider's reset.
 * `availableAtMsOf` says when a round may speak again, epoch ms; null = now.
 */
export const nextRound = <Round extends { readonly status: string; readonly activeBotId: unknown }>(
  live: ReadonlyArray<Round>,
  availableAtMsOf: (round: Round) => number | null,
  nowMs: number,
  concurrency: number,
): NextRound<Round> => {
  const speaking = live.filter((round) => round.activeBotId !== null).length;
  if (speaking >= concurrency) return { kind: "busy" };
  const round = live.find((entry) => {
    if (entry.status !== "running") return false;
    const availableAtMs = availableAtMsOf(entry);
    return availableAtMs === null || availableAtMs <= nowMs;
  });
  return round === undefined ? { kind: "none" } : { kind: "round", round };
};

/** What the transcript says when two members only answer each other. */
export const loopEndedText = (latest: string, previous: string) =>
  `${latest} and ${previous} were replying to each other, so the round ended.`;

/** What the transcript says when a round used its budget. */
export const pausedBudgetText = (granted: number) =>
  `Paused after ${String(granted)} replies. Continue to give the group another ${String(granted)}.`;

/** What the owner is told when a round's final verdict could not finish on a rate limit. */
export const verdictThrottledText = (willRetry: boolean) =>
  willRetry
    ? "The final verdict could not finish because its bot was rate limited. The contributions are still available; it will try again after the reset."
    : "The final verdict could not finish because its bot was rate limited. The contributions are still available; send a follow-up to try again.";

export const memberDroppedText = (name: string) =>
  `${name} is still rate limited, so it is out of this round.`;

export const memberSkippedText = (name: string) =>
  `${name} is rate limited, so the group moved on.`;

/**
 * What a rate-limited member does to its round. A member that fails twice in
 * a row is out of the round; one of several addressees is skipped and the
 * round carries on; the only addressee parks the round until the reported
 * reset (or a short backoff when none was reported). The turn produced
 * nothing, so the budget it took is given back: the group's "six replies" has
 * to mean six replies.
 */
export type ThrottleDecision =
  | { readonly kind: "drop"; readonly budgetRemaining: number }
  | { readonly kind: "skip"; readonly budgetRemaining: number }
  | {
      readonly kind: "park";
      readonly budgetRemaining: number;
      readonly availableAtMs: number;
      /** A usage limit resets hours later; the round gets a new window from then. */
      readonly deadlineAtMs: number;
    };

export const decideThrottle = (input: {
  /** Consecutive throttles of this member in this round, this one included. */
  readonly count: number;
  readonly maxConsecutive: number;
  readonly queueLength: number;
  readonly budgetRemaining: number;
  readonly retryAtMs: number | null;
  readonly unreportedBackoffMs: number;
  readonly nowMs: number;
  readonly roundDeadlineMs: number;
  /** A final verdict turn is still to come after this member. */
  readonly verdictPending: boolean;
}): ThrottleDecision => {
  const budgetRemaining = input.budgetRemaining + 1;
  if (input.count >= input.maxConsecutive) return { kind: "drop", budgetRemaining };
  if (input.queueLength > 0) return { kind: "skip", budgetRemaining };
  const availableAtMs =
    input.retryAtMs === null ? input.nowMs + input.unreportedBackoffMs : input.retryAtMs;
  const windowEndMs = availableAtMs + windowMsFor(1 + (input.verdictPending ? 1 : 0));
  return {
    kind: "park",
    budgetRemaining,
    availableAtMs,
    deadlineAtMs: windowEndMs > input.roundDeadlineMs ? windowEndMs : input.roundDeadlineMs,
  };
};
