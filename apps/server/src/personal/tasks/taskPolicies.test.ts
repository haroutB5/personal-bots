import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  BACKGROUND_WAIT_PROVIDER,
  PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS,
  PERSONAL_TASK_BACKGROUND_WAIT_MS,
  heldReplyTexts,
  isWaitingOnBackground,
  newBackgroundWait,
  stepBackgroundWait,
  type BackgroundWait,
} from "./taskBackgroundPolicy.ts";
import {
  PERSONAL_TASKS_LIMIT_DETAIL_WAIT_MS,
  PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS,
  PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES,
  PERSONAL_TASKS_RENEWAL_WAIT_MS,
  classifyProviderError,
  consecutiveRateLimited,
  immediateRateLimitRetry,
  providerRetryOfAttempt,
  providerWaitMessage,
  providerWaitPause,
  rateLimitBackoffMinutes,
  settleSessionError,
} from "./taskLimitPolicy.ts";
import {
  BACKGROUND_FOLLOW_UP_MARKER,
  PERSONAL_TASK_RESULT_MAX_CHARS,
  TASK_SUMMARY_RESULT_PREVIEW_CHARS,
  backgroundCapNote,
  composeTaskReplies,
  toTaskSummary,
  withNote,
  withoutWaitingMarker,
} from "./taskResultPolicy.ts";
import {
  isTerminal,
  isWaitingForUser,
  sessionIsAlive,
  sessionIsBusy,
} from "./taskSessionPolicy.ts";
import {
  delegationContinuationText,
  notesContinuationText,
  openingTurnHeader,
  openingTurnText,
  reopenNote,
  sourceLabel,
  steerText,
  taskSections,
} from "./taskTurnPolicy.ts";

const NOW = Date.parse("2026-10-07T10:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const retry = (
  overrides: Partial<NonNullable<Parameters<typeof providerRetryOfAttempt>[0]>> = {},
) =>
  ({
    kind: "rate_limited",
    provider: "codex",
    observedAt: "2026-10-07T09:59:00.000Z",
    ...overrides,
  }) as NonNullable<Parameters<typeof providerRetryOfAttempt>[0]>;

describe("limit policy", () => {
  it("reads rate limits and an unreachable provider as rate limited, the rest as provider errors", () => {
    for (const message of [
      "429 Too Many Requests",
      "Rate limit exceeded",
      "model is overloaded",
      "You have hit your usage limit",
      "Service Unavailable (503)",
    ]) {
      expect(classifyProviderError(message), message).toBe("rate_limited");
    }
    expect(classifyProviderError("boom")).toBe("provider_error");
    expect(classifyProviderError(null)).toBe("provider_error");
  });

  it("ignores a provider wait reported before the attempt started", () => {
    const started = NOW - 30_000;
    expect(providerRetryOfAttempt(undefined, started)).toBeUndefined();
    expect(
      providerRetryOfAttempt(retry({ observedAt: iso(NOW - 60_000) }), started),
    ).toBeUndefined();
    const own = retry({ observedAt: iso(NOW - 10_000) });
    expect(providerRetryOfAttempt(own, started)).toBe(own);
    // An unreadable time cannot be proven old: it counts.
    const unknown = retry({ observedAt: "later" });
    expect(providerRetryOfAttempt(unknown, started)).toBe(unknown);
  });

  it("pauses on a wait longer than two minutes, or a rate limit with no reset, and not on a short retry", () => {
    expect(providerWaitPause(undefined, NOW)).toBeNull();
    const far = retry({ retryAt: iso(NOW + PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS + 1) });
    expect(providerWaitPause(far, NOW)?.retryAtMs).toBe(
      NOW + PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS + 1,
    );
    const edge = retry({ retryAt: iso(NOW + PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS) });
    expect(providerWaitPause(edge, NOW)).toBeNull();
    expect(providerWaitPause(retry(), NOW)).toEqual({ retry: retry(), retryAtMs: null });
    expect(providerWaitPause({ ...retry(), kind: "retrying" } as never, NOW)).toBeNull();
  });

  it("words the pause, with or without a reset time", () => {
    expect(providerWaitMessage({ retry: retry(), retryAtMs: null })).toBe(
      "The provider is rate limited and did not report when the limit resets.",
    );
    expect(providerWaitMessage({ retry: retry({ reason: "weekly limit" }), retryAtMs: NOW })).toBe(
      "The provider is rate limited (weekly limit); its next attempt is at 2026-10-07T10:00:00.000Z.",
    );
  });

  it("counts the rate limits at the end of the attempt history", () => {
    expect(consecutiveRateLimited([])).toBe(0);
    expect(consecutiveRateLimited(["provider_error", "rate_limited", "rate_limited"])).toBe(2);
    expect(consecutiveRateLimited(["rate_limited", "interrupted", "rate_limited"])).toBe(1);
    expect(consecutiveRateLimited([null, "rate_limited"])).toBe(1);
  });

  it("backs off 1, 5 and 15 minutes and then gives up", () => {
    expect(PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES).toEqual([1, 5, 15]);
    expect([1, 2, 3].map(rateLimitBackoffMinutes)).toEqual([1, 5, 15]);
    expect(rateLimitBackoffMinutes(4)).toBeUndefined();
    expect(rateLimitBackoffMinutes(0)).toBeUndefined();
  });

  it("runs at once after a model fallback, uses a reset still ahead, and otherwise defers to the backoff", () => {
    expect(
      immediateRateLimitRetry({ fallbackSwitched: true, reportedResetMs: NOW + 9e6, nowMs: NOW }),
    ).toEqual({ kind: "run_now" });
    expect(
      immediateRateLimitRetry({ fallbackSwitched: false, reportedResetMs: NOW + 1, nowMs: NOW }),
    ).toEqual({ kind: "at", availableAtMs: NOW + 1 });
    expect(
      immediateRateLimitRetry({ fallbackSwitched: false, reportedResetMs: NOW, nowMs: NOW }),
    ).toBeNull();
    expect(
      immediateRateLimitRetry({ fallbackSwitched: false, reportedResetMs: null, nowMs: NOW }),
    ).toBeNull();
  });

  describe("settleSessionError", () => {
    const base = {
      lastError: "boom",
      lostConversation: false,
      renewalWaitSinceMs: undefined,
      nowMs: NOW,
      providerRetry: undefined,
      attemptStartedAtMs: NOW - 60_000,
      activeTurnId: null,
      sessionUpdatedAtMs: NOW - 1_000,
    } as const;

    it("fails a plain error as a provider error", () => {
      expect(settleSessionError(base)).toEqual({
        kind: "finish",
        clearRenewalWait: false,
        category: "provider_error",
      });
    });

    it("waits for a lost conversation's renewal, remembering when the wait began", () => {
      expect(settleSessionError({ ...base, lostConversation: true })).toEqual({
        kind: "wait",
        renewalWaitSinceMs: NOW,
      });
      // The follow-on error while the wait is open belongs to the same wait.
      expect(settleSessionError({ ...base, renewalWaitSinceMs: NOW - 10_000, nowMs: NOW })).toEqual(
        { kind: "wait", renewalWaitSinceMs: NOW - 10_000 },
      );
    });

    it("counts the error once the renewal wait is over, and clears the wait", () => {
      const out = settleSessionError({
        ...base,
        lostConversation: true,
        renewalWaitSinceMs: NOW - PERSONAL_TASKS_RENEWAL_WAIT_MS,
      });
      expect(out).toEqual({ kind: "finish", clearRenewalWait: true, category: "provider_error" });
    });

    it("gives a limit-looking error on a turn still open a moment for the limit's details", () => {
      const limited = {
        ...base,
        lastError: "429 rate limit",
        activeTurnId: "turn-1",
        sessionUpdatedAtMs: NOW - 1_000,
      };
      expect(settleSessionError(limited)).toEqual({ kind: "wait" });
      expect(
        settleSessionError({
          ...limited,
          sessionUpdatedAtMs: NOW - PERSONAL_TASKS_LIMIT_DETAIL_WAIT_MS,
        }),
      ).toEqual({ kind: "finish", clearRenewalWait: false, category: "rate_limited" });
      // No open turn: no details to wait for.
      expect(settleSessionError({ ...limited, activeTurnId: null })).toMatchObject({
        kind: "finish",
        category: "rate_limited",
      });
    });

    it("takes the limit and reset the provider reported during this attempt", () => {
      const resetAt = iso(NOW + 3_600_000);
      const out = settleSessionError({
        ...base,
        activeTurnId: "turn-1",
        providerRetry: retry({ reason: "5h window", retryAt: resetAt }),
      });
      expect(out).toEqual({
        kind: "finish",
        clearRenewalWait: false,
        category: "rate_limited",
        limit: { provider: "codex", reason: "5h window", retryAt: resetAt },
        resetAtMs: NOW + 3_600_000,
      });
    });

    it("ignores a limit reported before this attempt began", () => {
      const out = settleSessionError({
        ...base,
        providerRetry: retry({ observedAt: iso(NOW - 120_000) }),
      });
      expect(out).toMatchObject({ kind: "finish", category: "provider_error" });
      expect(out).not.toHaveProperty("limit");
    });

    it("a limit with no reset time has no reset", () => {
      const out = settleSessionError({ ...base, providerRetry: retry() });
      expect(out).toMatchObject({ kind: "finish", category: "rate_limited" });
      expect(out).not.toHaveProperty("resetAtMs");
    });
  });
});

describe("result policy", () => {
  it("leaves one reply alone and puts later replies after a marker", () => {
    expect(composeTaskReplies([])).toBe("");
    expect(composeTaskReplies(["  ", ""])).toBe("");
    expect(composeTaskReplies(["only"])).toBe("only");
    expect(composeTaskReplies(["first", "second", "third"])).toBe(
      `first\n\n${BACKGROUND_FOLLOW_UP_MARKER}\n\nsecond\n\n${BACKGROUND_FOLLOW_UP_MARKER}\n\nthird`,
    );
  });

  it("drops the oldest follow-ups first, never the first reply, and says how many", () => {
    const big = "x".repeat(PERSONAL_TASK_RESULT_MAX_CHARS / 2);
    const out = composeTaskReplies(["first", `a${big}`, `b${big}`, "last"]);
    expect(out.startsWith("first")).toBe(true);
    expect(out).toContain("earlier follow-up");
    expect(out.endsWith("last")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(PERSONAL_TASK_RESULT_MAX_CHARS + 200);
  });

  it("cuts the single newest follow-up when it alone is too long", () => {
    const out = composeTaskReplies(["first", "y".repeat(PERSONAL_TASK_RESULT_MAX_CHARS * 2)]);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(PERSONAL_TASK_RESULT_MAX_CHARS + 5);
  });

  it("adds a note on its own paragraph, and never an empty one", () => {
    expect(withNote("a", "")).toBe("a");
    expect(withNote("", "n")).toBe("n");
    expect(withNote("a", "n")).toBe("a\n\nn");
  });

  it("names the minutes of the background cap in the note", () => {
    expect(backgroundCapNote(1)).toContain("a background command");
    expect(backgroundCapNote(3)).toContain("3 background commands");
    expect(backgroundCapNote(1)).toContain(`${PERSONAL_TASK_BACKGROUND_WAIT_MS / 60_000} minutes`);
  });

  it("drops the waiting mark only", () => {
    expect(withoutWaitingMarker(null)).toBeNull();
    const plain = { summary: "s" };
    expect(withoutWaitingMarker(plain)).toBe(plain);
    expect(withoutWaitingMarker({ summary: "s", waitingOnBackgroundSince: "t" })).toEqual({
      summary: "s",
    });
  });

  it("summarises a task for lists: no long text, a clipped result", () => {
    const task = {
      objective: "o",
      acceptanceCriteria: "a",
      expectedOutput: "e",
      result: { summary: "z".repeat(TASK_SUMMARY_RESULT_PREVIEW_CHARS + 50) },
    } as never;
    const summary = toTaskSummary(task) as unknown as {
      objective: string;
      result: { summary: string };
      detailOmitted: boolean;
    };
    expect(summary.objective).toBe("");
    expect(summary.detailOmitted).toBe(true);
    expect(summary.result.summary).toBe(`${"z".repeat(TASK_SUMMARY_RESULT_PREVIEW_CHARS)}…`);
    expect(
      (toTaskSummary({ ...(task as object), result: null } as never) as { result: unknown }).result,
    ).toBeNull();
  });
});

describe("session policy", () => {
  const session = (status: string) => ({ status }) as never;
  it("tells a busy session, a live one and a finished task apart", () => {
    expect(sessionIsBusy(session("running"))).toBe(true);
    expect(sessionIsBusy(session("starting"))).toBe(true);
    expect(sessionIsBusy(session("ready"))).toBe(false);
    expect(sessionIsBusy(null)).toBe(false);
    expect(sessionIsAlive(session("ready"))).toBe(true);
    expect(sessionIsAlive(session("stopped"))).toBe(false);
    expect(sessionIsAlive(session("error"))).toBe(false);
    expect(sessionIsAlive(undefined)).toBe(false);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isWaitingForUser("waiting_for_user")).toBe(true);
    expect(isWaitingForUser("waiting_for_browser")).toBe(true);
    expect(isWaitingForUser("waiting_for_agent")).toBe(false);
  });
});

describe("turn policy", () => {
  const task = {
    taskId: "t1",
    title: "Title",
    objective: "Do it",
    acceptanceCriteria: "",
    expectedOutput: "Done",
    source: "user",
  } as never;

  it("labels a task by where it came from", () => {
    expect(sourceLabel({ source: "user" }, null)).toBe("[Task from you]");
    expect(sourceLabel({ source: "routine" }, null)).toBe("[Routine task]");
    expect(sourceLabel({ source: "delegation" }, "Nova")).toBe("[Delegated task from Nova]");
    expect(sourceLabel({ source: "delegation" }, null)).toBe("[Delegated task from another bot]");
  });

  it("lays the brief out section by section and skips what is empty", () => {
    expect(taskSections(task, null)).toEqual([
      "Task id: t1",
      "Title: Title",
      "Objective:\nDo it",
      "Expected output:\nDone",
    ]);
    expect(
      taskSections(task, {
        title: "T",
        context: "ctx",
        constraints: "no",
        targetBot: "b",
      } as never),
    ).toEqual([
      "Task id: t1",
      "Title: Title",
      "Objective:\nDo it",
      "Context:\nctx",
      "Constraints:\nno",
      "Expected output:\nDone",
    ]);
  });

  it("opens a task, and a retry says which attempt it is", () => {
    expect(openingTurnHeader("[Task from you]", 1)).toBe("[Task from you]");
    expect(openingTurnHeader("[Task from you]", 3)).toBe("[Task from you] Retry, attempt 3.");
    expect(openingTurnText({ header: "H", sections: ["a", "b"], notes: [] })).toBe("H\n\na\n\nb");
    expect(openingTurnText({ header: "H", sections: ["a"], notes: ["n1", "n2"] })).toBe(
      "H\n\na\n\nUpdates since this task was handed over:\n\nn1\n\nn2",
    );
  });

  it("continues with delegated results, and says what is still running", () => {
    expect(
      delegationContinuationText({
        results: ["### A (completed)\nok"],
        stillRunningTitles: [],
        notes: ["note"],
        sections: ["s"],
      }),
    ).toBe(
      "[Task continuation] Your delegated tasks have finished. Their results:\n\n### A (completed)\nok\n\nnote\n\nContinue the task below with these results and give your final answer.\n\ns",
    );
    const partial = delegationContinuationText({
      results: ["r"],
      stillRunningTitles: ["B", "C"],
      notes: [],
      sections: ["s"],
    });
    expect(partial).toContain("These delegated tasks have finished.");
    expect(partial).toContain("Still running: B, C.");
    expect(partial).toContain("Do not give a final answer yet");
  });

  it("continues with updates, seeding a fresh session with the work record", () => {
    expect(notesContinuationText({ notes: ["n"], freshRecord: null, sections: ["s"] })).toBe(
      "[Task continuation]\n\nn\n\nContinue the task below.\n\ns",
    );
    const fresh = notesContinuationText({ notes: ["n"], freshRecord: "RECORD", sections: ["s"] });
    expect(fresh).toContain("start a fresh session");
    expect(fresh).toContain("\n\nRECORD\n\nContinue the task below.");
  });

  it("words a reopened task by how it ended", () => {
    expect(reopenNote("completed")).toContain("had finished and has been reopened");
    expect(reopenNote("failed")).toContain("had ended (failed)");
  });

  it("keeps a steer's own prefix, and adds one otherwise", () => {
    expect(steerText("CTO", "Update from CTO: go")).toBe("Update from CTO: go");
    expect(steerText("CTO", "  go  ")).toBe("Update from CTO: go");
    expect(steerText("  ", "go")).toBe("Update from your delegator: go");
  });
});

describe("background policy", () => {
  const key = "task:1";
  const input = (overrides: Partial<Parameters<typeof stepBackgroundWait>[1]> = {}) => ({
    pending: ["bg-1"],
    sessionUpdatedAt: iso(NOW),
    nowMs: NOW,
    last: { messageId: "m1", text: "Started the build." },
    ...overrides,
  });

  it("only Claude waits", () => {
    expect(BACKGROUND_WAIT_PROVIDER).toBe("claudeAgent");
  });

  it("a task that never left work running ends as it always has", () => {
    const step = stepBackgroundWait(newBackgroundWait(key), input({ pending: [] }));
    expect(step).toMatchObject({ kind: "finish", capped: false });
    expect(isWaitingOnBackground(step.state, key)).toBe(false);
  });

  it("holds the reply of a turn that left work running and waits", () => {
    const step = stepBackgroundWait(newBackgroundWait(key), input());
    expect(step).toMatchObject({ kind: "wait", started: true, publishPreview: true });
    expect(step.state.pendingReadyAt).toBe(iso(NOW));
    expect(step.state.waitingSince).toBe(iso(NOW));
    expect(step.state.replies).toEqual([{ messageId: "m1", text: "Started the build." }]);
    expect(isWaitingOnBackground(step.state, key)).toBe(true);
    expect(isWaitingOnBackground(step.state, "task:2")).toBe(false);
  });

  it("does not hold an empty or an already held reply, and says it started only once", () => {
    const first = stepBackgroundWait(newBackgroundWait(key), input());
    const again = stepBackgroundWait(first.state, input({ nowMs: NOW + 1_000 }));
    expect(again).toMatchObject({ kind: "wait", started: false, publishPreview: false });
    expect(again.state.replies).toHaveLength(1);
    const blank = stepBackgroundWait(
      newBackgroundWait(key),
      input({ last: { messageId: "m2", text: "  " } }),
    );
    expect(blank).toMatchObject({ kind: "wait", publishPreview: false });
    expect(blank.state.replies).toEqual([]);
  });

  it("closes with a note once nothing has run for the whole wait", () => {
    const first = stepBackgroundWait(newBackgroundWait(key), input());
    const late = stepBackgroundWait(
      first.state,
      input({ nowMs: NOW + PERSONAL_TASK_BACKGROUND_WAIT_MS, last: undefined }),
    );
    expect(late).toMatchObject({ kind: "finish", capped: true });
  });

  it("when the work ends, waits for the turn that reports it, then lets the latest reply stand", () => {
    const waiting = stepBackgroundWait(newBackgroundWait(key), input());
    const sameTurn = stepBackgroundWait(
      waiting.state,
      input({ pending: [], nowMs: NOW + 5_000, sessionUpdatedAt: waiting.state.pendingReadyAt! }),
    );
    expect(sameTurn).toMatchObject({ kind: "wait" });
    expect(sameTurn.state.clearedAtMs).toBe(NOW + 5_000);
    const stillSame = stepBackgroundWait(
      sameTurn.state,
      input({
        pending: [],
        nowMs: NOW + 5_000 + PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS,
        sessionUpdatedAt: waiting.state.pendingReadyAt!,
      }),
    );
    expect(stillSame).toMatchObject({ kind: "finish", capped: false });
    // A newer turn after the one that left the work: its reply is the result.
    const newer = stepBackgroundWait(
      waiting.state,
      input({ pending: [], sessionUpdatedAt: iso(NOW + 60_000) }),
    );
    expect(newer).toMatchObject({ kind: "finish", capped: false });
  });

  it("the work coming back clears the follow-up clock", () => {
    const waiting = stepBackgroundWait(newBackgroundWait(key), input());
    const cleared = stepBackgroundWait(
      waiting.state,
      input({ pending: [], nowMs: NOW + 2_000, sessionUpdatedAt: waiting.state.pendingReadyAt! }),
    );
    const back = stepBackgroundWait(cleared.state, input({ nowMs: NOW + 3_000, last: undefined }));
    expect(back.state.clearedAtMs).toBeNull();
  });

  it("composes the result from the held replies and the newest one", () => {
    const state: BackgroundWait = {
      ...newBackgroundWait(key),
      replies: [{ messageId: "m1", text: "one" }],
    };
    expect(heldReplyTexts(state, key, { messageId: "m2", text: "two" })).toEqual(["one", "two"]);
    expect(heldReplyTexts(state, key, { messageId: "m1", text: "one" })).toEqual(["one"]);
    expect(heldReplyTexts(state, "task:other", { messageId: "m2", text: "two" })).toEqual(["two"]);
    expect(heldReplyTexts(undefined, key, undefined)).toEqual([]);
  });

  it("keeps the input state untouched", () => {
    const before = newBackgroundWait(key);
    stepBackgroundWait(before, input());
    expect(before).toEqual(newBackgroundWait(key));
  });
});
