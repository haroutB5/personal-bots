import {
  PersonalBotId,
  ThreadId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type PersonalBrowserStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "~/session-logic";

import {
  buildConversationItems,
  conversationStateLabel,
  deriveConversationState,
  formatDayDivider,
  friendlyTurnError,
  resolveConversationHeaderName,
} from "./conversationModel";

describe("friendlyTurnError", () => {
  it("turns a usage limit into a plain sentence with the reset time", () => {
    expect(
      friendlyTurnError("You've hit your session limit · resets 10:10pm (Europe/London)"),
    ).toEqual({
      message: "Usage limit reached. It resets at 10:10pm.",
      detail: "You've hit your session limit · resets 10:10pm (Europe/London)",
    });
    expect(friendlyTurnError("API Error: 429 rate_limit_error").message).toBe(
      "Usage limit reached. Try again later.",
    );
  });

  it("explains a closed session and never shows the stack trace", () => {
    const raw =
      "ProviderAdapterSessionClosedError: claudeAgent adapter thread is closed: 7dc30102 at toSessionError (file:///C:/Users/Ht/.personal-bots/releases/x/dist/bin.mjs:120773:44) at toRequestError$1 (file:///C:/x.mjs:1:2)\n    at sendTurn (file:///C:/x.mjs:3:4)";
    const friendly = friendlyTurnError(raw);
    expect(friendly.message).toBe("This chat's session ended. Send a message to start it again.");
    expect(friendly.detail).toBe(
      "ProviderAdapterSessionClosedError: claudeAgent adapter thread is closed: 7dc30102",
    );
    expect(friendly.detail).not.toContain("file:///");
  });

  it("covers sign-in, timeouts and network failures", () => {
    expect(friendlyTurnError("Error: Not logged in · Please run /login").message).toBe(
      "The provider isn't signed in on your computer.",
    );
    expect(friendlyTurnError("Request timed out after 120000ms").message).toBe(
      "The reply took too long and was stopped. Try again.",
    );
    expect(friendlyTurnError("fetch failed: getaddrinfo ENOTFOUND api.anthropic.com").message).toBe(
      "Couldn't reach the provider. Check your computer's internet connection.",
    );
  });

  it("falls back to a generic sentence and keeps a short detail line", () => {
    const friendly = friendlyTurnError(`Error: something odd happened ${"x".repeat(400)}`);
    expect(friendly.message).toBe("The last reply failed. Send your message again.");
    expect(friendly.detail?.length).toBeLessThanOrEqual(201);
    expect(friendlyTurnError("The last turn failed.")).toEqual({
      message: "The last reply failed. Send your message again.",
      detail: null,
    });
  });
});

const session = (status: OrchestrationSession["status"]) =>
  ({ status }) as unknown as OrchestrationSession;
const turn = (state: OrchestrationLatestTurn["state"]) =>
  ({ state }) as unknown as OrchestrationLatestTurn;

describe("deriveConversationState", () => {
  const none = { pendingApprovals: [], pendingUserInputs: [] };

  it("is idle without a session", () => {
    expect(deriveConversationState({ session: null, latestTurn: null, ...none })).toBe("idle");
  });

  it("is working while a turn or session runs", () => {
    expect(deriveConversationState({ session: null, latestTurn: turn("running"), ...none })).toBe(
      "working",
    );
    expect(
      deriveConversationState({ session: session("starting"), latestTurn: null, ...none }),
    ).toBe("working");
  });

  it("waits for the user over everything else", () => {
    expect(
      deriveConversationState({
        session: session("running"),
        latestTurn: turn("running"),
        pendingApprovals: [{ requestId: "r1" } as never],
        pendingUserInputs: [],
      }),
    ).toBe("waiting");
  });

  it("puts browser help above every other conversation state", () => {
    const browserStatus: PersonalBrowserStatus = {
      state: "connected",
      detail: null,
      lockedByPid: null,
      controller: { _tag: "None" },
      generation: 1,
      page: null,
      helpRequest: {
        threadId: ThreadId.make("thread-a"),
        botId: PersonalBotId.make("bot-a"),
        botName: "Assistant",
        reason: "CAPTCHA on example.com",
        requestedAt: "2026-09-15T10:00:00.000Z",
      },
      viewers: 0,
    };
    expect(
      deriveConversationState({
        session: session("running"),
        latestTurn: turn("running"),
        pendingApprovals: [{ requestId: "r1" } as never],
        pendingUserInputs: [],
        browserStatus,
        threadId: "thread-a",
      }),
    ).toBe("needs_help");
    expect(
      deriveConversationState({
        session: null,
        latestTurn: null,
        ...none,
        browserStatus,
        threadId: "thread-b",
      }),
    ).toBe("idle");
  });

  it("reports errors from the session or the last turn", () => {
    expect(deriveConversationState({ session: session("error"), latestTurn: null, ...none })).toBe(
      "error",
    );
    expect(
      deriveConversationState({ session: session("ready"), latestTurn: turn("error"), ...none }),
    ).toBe("error");
    expect(
      deriveConversationState({
        session: session("ready"),
        latestTurn: turn("completed"),
        ...none,
      }),
    ).toBe("idle");
  });
});

describe("provider waits", () => {
  const none = { pendingApprovals: [], pendingUserInputs: [] };
  const waiting = (
    status: OrchestrationSession["status"],
    kind: "rate_limited" | "retrying",
    retryAt?: string,
  ) =>
    ({
      status,
      providerRetry: {
        kind,
        provider: "claudeAgent",
        observedAt: "2026-09-13T03:47:16.087Z",
        ...(retryAt === undefined ? {} : { retryAt }),
      },
    }) as unknown as OrchestrationSession;
  // Sunday 13 Sep 2026, 05:00 in London (BST).
  const now = new Date("2026-09-13T04:00:00.000Z");

  it("says rate limited instead of working, with the reported retry in London time", () => {
    const limited = waiting("running", "rate_limited", "2026-09-13T09:47:16.087Z");
    const state = deriveConversationState({
      session: limited,
      latestTurn: turn("running"),
      ...none,
    });
    expect(state).toBe("rate_limited");
    expect(conversationStateLabel(state, limited, now)).toBe("Rate limited · retry ~10:47");
  });

  it("never invents a reset time", () => {
    const limited = waiting("running", "rate_limited");
    expect(conversationStateLabel("rate_limited", limited, now)).toBe(
      "Rate limited · reset not reported",
    );
  });

  it("names the day when the retry is not today", () => {
    const limited = waiting("running", "rate_limited", "2026-09-13T23:30:00.000Z");
    expect(conversationStateLabel("rate_limited", limited, now)).toBe(
      "Rate limited · retry ~Mon 00:30",
    );
  });

  it("keeps the rate limit on a turn that failed on it; other waits end with the turn", () => {
    expect(
      deriveConversationState({
        session: waiting("error", "rate_limited", "2026-09-13T09:47:16.087Z"),
        latestTurn: turn("error"),
        ...none,
      }),
    ).toBe("rate_limited");
    expect(
      deriveConversationState({
        session: waiting("error", "retrying", "2026-09-13T09:47:16.087Z"),
        latestTurn: null,
        ...none,
      }),
    ).toBe("error");
    expect(
      deriveConversationState({
        session: waiting("ready", "rate_limited"),
        latestTurn: turn("completed"),
        ...none,
      }),
    ).toBe("idle");
  });

  it("shows a pending transport retry and drops the time once it has passed", () => {
    const retrying = waiting("running", "retrying", "2026-09-13T04:02:00.000Z");
    const state = deriveConversationState({ session: retrying, latestTurn: null, ...none });
    expect(state).toBe("retrying");
    expect(conversationStateLabel(state, retrying, now)).toBe("Retrying · next ~05:02");
    expect(conversationStateLabel(state, retrying, new Date("2026-09-13T04:05:00.000Z"))).toBe(
      "Retrying",
    );
  });

  it("still asks the user first", () => {
    expect(
      deriveConversationState({
        session: waiting("running", "rate_limited"),
        latestTurn: null,
        pendingApprovals: [{ requestId: "r1" } as never],
        pendingUserInputs: [],
      }),
    ).toBe("waiting");
  });
});

describe("resolveConversationHeaderName", () => {
  it("is a skeleton until the bots list loads, never the thread title", () => {
    expect(resolveConversationHeaderName({ botName: null, botsLoaded: false })).toEqual({
      status: "loading",
    });
  });

  it("names the bot once it is known", () => {
    expect(resolveConversationHeaderName({ botName: "Assistant", botsLoaded: true })).toEqual({
      status: "ready",
      name: "Assistant",
    });
  });

  it("falls back to a neutral name for a bot that no longer exists", () => {
    expect(resolveConversationHeaderName({ botName: null, botsLoaded: true })).toEqual({
      status: "ready",
      name: "Chat",
    });
  });
});

describe("formatDayDivider", () => {
  const now = new Date("2026-09-13T20:40:00.000Z"); // 21:40 BST

  it("uses Europe/London wall time", () => {
    expect(formatDayDivider(new Date("2026-09-13T20:38:00.000Z"), now)).toBe("Today, 21:38");
    expect(formatDayDivider(new Date("2026-09-12T08:05:00.000Z"), now)).toBe("Yesterday, 09:05");
    expect(formatDayDivider(new Date("2026-09-01T13:00:00.000Z"), now)).toBe("1 Sep, 14:00");
    expect(formatDayDivider(new Date("2025-12-24T13:00:00.000Z"), now)).toBe("24 Dec 2025, 13:00");
  });

  it("rolls the day at London midnight, not UTC midnight", () => {
    // 23:30 UTC on the 12th is 00:30 BST on the 13th.
    expect(formatDayDivider(new Date("2026-09-12T23:30:00.000Z"), now)).toBe("Today, 00:30");
  });
});

const message = (id: string, role: "user" | "assistant" | "system", createdAt: string) =>
  ({
    id,
    kind: "message",
    createdAt,
    message: { id, role, text: id, createdAt, streaming: false },
  }) as unknown as TimelineEntry;

const work = (id: string, createdAt: string) =>
  ({
    id,
    kind: "work",
    createdAt,
    entry: { id, createdAt, label: id, tone: "tool" },
  }) as unknown as TimelineEntry;

describe("buildConversationItems", () => {
  it("folds consecutive work into one group and skips system messages", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-13T20:38:00.000Z"),
      message("s1", "system", "2026-09-13T20:38:01.000Z"),
      work("w1", "2026-09-13T20:38:02.000Z"),
      work("w2", "2026-09-13T20:38:03.000Z"),
      message("a1", "assistant", "2026-09-13T20:38:04.000Z"),
      work("w3", "2026-09-13T20:38:05.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "work",
      "message",
      "work",
    ]);
    const firstWork = items[2];
    expect(firstWork?.kind === "work" ? firstWork.entries.map((entry) => entry.id) : []).toEqual([
      "w1",
      "w2",
    ]);
  });

  it("starts a divider on a new day or after an hour of silence", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-12T22:50:00.000Z"), // 23:50 BST on the 12th
      message("u2", "user", "2026-09-12T23:10:00.000Z"), // 00:10 BST on the 13th
      message("u3", "user", "2026-09-12T23:40:00.000Z"),
      message("u4", "user", "2026-09-13T01:00:00.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "divider",
      "message",
      "message",
      "divider",
      "message",
    ]);
  });
});
