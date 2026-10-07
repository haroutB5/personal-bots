import { describe, expect, it } from "@effect/vitest";

import {
  decideThrottle,
  loopEndedText,
  memberDroppedText,
  memberSkippedText,
  nextRound,
  pausedBudgetText,
  verdictThrottledText,
} from "./groupSchedulePolicy.ts";
import { windowMsFor } from "./groupShared.ts";

interface Round {
  readonly id: string;
  readonly status: string;
  readonly activeBotId: string | null;
  readonly availableAtMs: number | null;
}
const round = (id: string, overrides: Partial<Round> = {}): Round => ({
  id,
  status: "running",
  activeBotId: null,
  availableAtMs: null,
  ...overrides,
});
const pick = (live: ReadonlyArray<Round>, nowMs = 1_000, concurrency = 1) =>
  nextRound(live, (entry) => entry.availableAtMs, nowMs, concurrency);

describe("nextRound", () => {
  it("takes the first running round that is free to speak", () => {
    expect(pick([round("a"), round("b")])).toEqual({ kind: "round", round: round("a") });
  });

  it("starts nothing while a member is speaking", () => {
    expect(pick([round("a"), round("b", { activeBotId: "bot" })])).toEqual({ kind: "busy" });
    // A second slot would let the next round start.
    expect(pick([round("a"), round("b", { activeBotId: "bot" })], 1_000, 2).kind).toBe("round");
  });

  it("skips rounds that are not running or still wait for a provider's reset", () => {
    const waiting = round("w", { status: "waiting_provider", availableAtMs: 500 });
    const later = round("l", { availableAtMs: 2_000 });
    const due = round("d", { availableAtMs: 1_000 });
    expect(pick([waiting, later, due])).toEqual({ kind: "round", round: due });
    expect(pick([waiting, later])).toEqual({ kind: "none" });
    expect(pick([])).toEqual({ kind: "none" });
  });
});

describe("round texts", () => {
  it("says what happened to the round", () => {
    expect(loopEndedText("Nova", "Atlas")).toBe(
      "Nova and Atlas were replying to each other, so the round ended.",
    );
    expect(pausedBudgetText(6)).toBe(
      "Paused after 6 replies. Continue to give the group another 6.",
    );
    expect(memberDroppedText("Nova")).toBe(
      "Nova is still rate limited, so it is out of this round.",
    );
    expect(memberSkippedText("Nova")).toBe("Nova is rate limited, so the group moved on.");
    expect(verdictThrottledText(true)).toContain("will try again after the reset");
    expect(verdictThrottledText(false)).toContain("send a follow-up to try again");
  });
});

describe("decideThrottle", () => {
  const base = {
    count: 1,
    maxConsecutive: 2,
    queueLength: 0,
    budgetRemaining: 3,
    retryAtMs: null,
    unreportedBackoffMs: 60_000,
    nowMs: 10_000,
    roundDeadlineMs: 20_000,
    verdictPending: false,
  } as const;

  it("gives the turn's budget back whatever happens", () => {
    for (const input of [base, { ...base, count: 2 }, { ...base, queueLength: 2 }]) {
      expect(decideThrottle(input).budgetRemaining).toBe(4);
    }
  });

  it("drops a member that is throttled twice in a row", () => {
    expect(decideThrottle({ ...base, count: 2, queueLength: 3 })).toEqual({
      kind: "drop",
      budgetRemaining: 4,
    });
  });

  it("skips one of several addressees and carries on", () => {
    expect(decideThrottle({ ...base, queueLength: 1 })).toEqual({
      kind: "skip",
      budgetRemaining: 4,
    });
  });

  it("parks the round on the only addressee until the reported reset, with a new window", () => {
    expect(decideThrottle({ ...base, retryAtMs: 3_600_000 })).toEqual({
      kind: "park",
      budgetRemaining: 4,
      availableAtMs: 3_600_000,
      deadlineAtMs: 3_600_000 + windowMsFor(1),
    });
    // A pending verdict turn needs room for itself too.
    expect(decideThrottle({ ...base, retryAtMs: 3_600_000, verdictPending: true })).toMatchObject({
      deadlineAtMs: 3_600_000 + windowMsFor(2),
    });
  });

  it("uses the short backoff when no reset was reported, and never shortens the round's clock", () => {
    expect(decideThrottle({ ...base, roundDeadlineMs: 99_999_999 })).toMatchObject({
      kind: "park",
      availableAtMs: 70_000,
      deadlineAtMs: 99_999_999,
    });
  });
});
