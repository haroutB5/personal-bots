import {
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PersonalBotId,
  ThreadId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationSessionProviderRetry,
  type PersonalBrowserStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "~/session-logic";

import {
  autoRetryNotice,
  buildConversationItems,
  contextBadgeLabel,
  conversationStateLabel,
  deriveConversationState,
  formatDayDivider,
  friendlyTurnError,
  placeQuestionCards,
  placeSecretRequestCards,
  providerWaitState,
  resolveConversationHeaderName,
} from "./conversationModel";
import type { QuestionCardItem } from "./questionCards";
import type { SecretRequestCardItem } from "./secretRequestCards";

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

  it("names the provider-side fault that ended the owner's audit run", () => {
    const raw = "Error from provider (Console): Upstream request failed: Endpoint is unavailable.";
    const friendly = friendlyTurnError(raw);
    expect(friendly.message).toBe("The provider's service didn't answer. Try again in a moment.");
    expect(friendly.detail).toBe(raw);
  });
});

const providerRetry = (
  auto: "pending" | "exhausted" | undefined,
  attempt = 1,
  maxAttempts = 2,
): OrchestrationSessionProviderRetry =>
  ({
    kind: "retrying",
    attempt,
    maxAttempts,
    provider: "opencode",
    observedAt: "2026-09-17T10:00:00.000Z",
    ...(auto === undefined ? {} : { auto }),
  }) as OrchestrationSessionProviderRetry;

describe("autoRetryNotice", () => {
  it("says nothing when no automatic retry is in play", () => {
    expect(autoRetryNotice(null)).toBeNull();
    expect(autoRetryNotice(undefined)).toBeNull();
    // A provider's own wait is not ours to narrate.
    expect(autoRetryNotice(providerRetry(undefined))).toBeNull();
  });

  it("counts the attempt while one is pending", () => {
    expect(autoRetryNotice(providerRetry("pending", 1))).toBe(
      "That reply failed. Trying again (1 of 2).",
    );
    expect(autoRetryNotice(providerRetry("pending", 2))).toBe(
      "That reply failed. Trying again (2 of 2).",
    );
  });

  it("admits it gave up rather than pretending it is still trying", () => {
    const message = autoRetryNotice(providerRetry("exhausted", 2));
    expect(message).toBe(
      "That reply failed, and 2 automatic retries didn't help. Send your message again.",
    );
    expect(message).not.toContain("Trying again");
  });
});

describe("providerWaitState with a server-driven retry", () => {
  const failedSession = (auto: "pending" | "exhausted"): OrchestrationSession =>
    ({ status: "error", providerRetry: providerRetry(auto) }) as unknown as OrchestrationSession;

  it("reads a pending retry as retrying even though the turn already ended", () => {
    // The wait is on a clock the server holds; the session sits in `error`.
    expect(providerWaitState(failedSession("pending"))).toBe("retrying");
    expect(
      deriveConversationState({
        session: failedSession("pending"),
        latestTurn: null,
        pendingApprovals: [],
        pendingUserInputs: [],
      }),
    ).toBe("retrying");
  });

  it("goes back to plain error once the attempts are spent", () => {
    expect(providerWaitState(failedSession("exhausted"))).toBeNull();
    expect(
      deriveConversationState({
        session: failedSession("exhausted"),
        latestTurn: null,
        pendingApprovals: [],
        pendingUserInputs: [],
      }),
    ).toBe("error");
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
      lastAgent: null,
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

const message = (
  id: string,
  role: "user" | "assistant" | "system" | "reasoning",
  createdAt: string,
) =>
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
  it("hides every work row by default, keeping what was said", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-13T20:38:00.000Z"),
      work("w1", "2026-09-13T20:38:02.000Z"),
      work("w2", "2026-09-13T20:38:03.000Z"),
      message("a1", "assistant", "2026-09-13T20:38:04.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["divider", "message", "message"]);
  });

  it("does not open a gap divider across the work it hid", () => {
    // An hour of hidden steps is not an hour of silence: the reply belongs to
    // the same turn as the question that started it.
    const items = buildConversationItems([
      message("u1", "user", "2026-09-13T10:00:00.000Z"),
      work("w1", "2026-09-13T10:30:00.000Z"),
      work("w2", "2026-09-13T11:20:00.000Z"),
      message("a1", "assistant", "2026-09-13T11:25:00.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["divider", "message", "message"]);
  });

  it("never shows checkpoint steps in a bot chat", () => {
    const checkpointFailure = {
      id: "cp",
      kind: "work",
      createdAt: "2026-09-13T20:38:05.000Z",
      entry: {
        id: "cp",
        createdAt: "2026-09-13T20:38:05.000Z",
        label: "VCS process timed out in GitVcsDriver.isInsideWorkTree",
        tone: "error",
        sourceActivityKind: "checkpoint.capture.failed",
      },
    } as unknown as TimelineEntry;
    const items = buildConversationItems(
      [
        message("u1", "user", "2026-09-13T20:38:00.000Z"),
        checkpointFailure,
        work("w1", "2026-09-13T20:38:06.000Z"),
      ],
      { showToolSteps: true },
    );
    const workItems = items.filter((item) => item.kind === "work");
    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toMatchObject({ entries: [expect.objectContaining({ id: "w1" })] });
  });

  it("keeps a provider's thinking trace out of the chat", () => {
    const items = buildConversationItems(
      [
        message("u1", "user", "2026-09-13T20:38:00.000Z"),
        message("r1", "reasoning", "2026-09-13T20:38:01.000Z"),
        message("a1", "assistant", "2026-09-13T20:38:04.000Z"),
      ],
      { showToolSteps: true },
    );
    expect(items.map((item) => item.kind)).toEqual(["divider", "message", "message"]);
    expect(items.some((item) => item.kind === "message" && item.message.role === "reasoning")).toBe(
      false,
    );
  });

  it("folds consecutive work into one group and skips system messages", () => {
    const items = buildConversationItems(
      [
        message("u1", "user", "2026-09-13T20:38:00.000Z"),
        message("s1", "system", "2026-09-13T20:38:01.000Z"),
        work("w1", "2026-09-13T20:38:02.000Z"),
        work("w2", "2026-09-13T20:38:03.000Z"),
        message("a1", "assistant", "2026-09-13T20:38:04.000Z"),
        work("w3", "2026-09-13T20:38:05.000Z"),
      ],
      { showToolSteps: true },
    );
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

const question = (id: string, createdAt: string, kind: "pending" | "answered" | "closed") =>
  (kind === "pending"
    ? {
        kind,
        requestId: id,
        createdAt,
        request: { requestId: id, createdAt, questions: [], dismissible: true },
      }
    : kind === "answered"
      ? { kind, requestId: id, createdAt, questions: [], answers: { scope: "tests" } }
      : { kind, requestId: id, createdAt, questions: [] }) as unknown as QuestionCardItem;

const secret = (id: string, createdAt: string, kind: "pending" | "provided") =>
  (kind === "pending"
    ? { kind, requestId: id, createdAtMs: Date.parse(createdAt), request: { requestId: id } }
    : {
        kind,
        requestId: id,
        createdAtMs: Date.parse(createdAt),
        name: "GITHUB_TOKEN",
        label: "GitHub token",
      }) as unknown as SecretRequestCardItem;

describe("placeQuestionCards", () => {
  it("keeps what the bot said after an answer below the card it answered", () => {
    // The bug: the card was rendered after the whole list, so every later
    // paragraph from the bot appeared above the question it had asked.
    const items = buildConversationItems([
      message("u1", "user", "2026-09-16T10:00:00.000Z"),
      message("a1", "assistant", "2026-09-16T10:00:10.000Z"),
      message("a2", "assistant", "2026-09-16T10:01:30.000Z"),
    ]);
    const placed = placeQuestionCards(items, [
      question("req-1", "2026-09-16T10:00:20.000Z", "answered"),
    ]);
    expect(placed.map((item) => item.id)).toEqual([
      "divider:2026-09-16T10:00:00.000Z",
      "u1",
      "a1",
      "question:req-1",
      "a2",
    ]);
  });

  it("leaves a question still waiting for an answer at the end of the chat", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-16T10:00:00.000Z"),
      message("a1", "assistant", "2026-09-16T10:00:10.000Z"),
      message("a2", "assistant", "2026-09-16T10:00:40.000Z"),
    ]);
    // Asked mid-turn, before `a2`: a bot that keeps working must not bury it.
    const placed = placeQuestionCards(items, [
      question("req-1", "2026-09-16T10:00:20.000Z", "pending"),
    ]);
    expect(placed.at(-1)?.id).toBe("question:req-1");
  });

  it("orders cards by id when their timestamps tie, and never moves a divider", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-16T10:00:00.000Z"),
      message("a1", "assistant", "2026-09-16T12:00:00.000Z"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["divider", "message", "divider", "message"]);
    const cards = [
      question("req-b", "2026-09-16T10:00:05.000Z", "closed"),
      question("req-a", "2026-09-16T10:00:05.000Z", "answered"),
    ];
    const placed = placeQuestionCards(items, cards);
    expect(placed.map((item) => item.id)).toEqual([
      "divider:2026-09-16T10:00:00.000Z",
      "u1",
      "question:req-a",
      "question:req-b",
      "divider:2026-09-16T12:00:00.000Z",
      "a1",
    ]);
    // Same cards, opposite order in: same transcript out.
    expect(placeQuestionCards(items, cards.toReversed()).map((item) => item.id)).toEqual(
      placed.map((item) => item.id),
    );
  });

  it("puts a question older than every loaded row first", () => {
    const items = buildConversationItems([message("a1", "assistant", "2026-09-16T10:00:00.000Z")]);
    expect(
      placeQuestionCards(items, [question("req-1", "2026-09-15T09:00:00.000Z", "answered")]).map(
        (item) => item.id,
      ),
    ).toEqual(["question:req-1", "divider:2026-09-16T10:00:00.000Z", "a1"]);
  });
});

describe("placeSecretRequestCards", () => {
  it("settles an answered secret into the flow and keeps an open one last", () => {
    const items = buildConversationItems([
      message("u1", "user", "2026-09-16T10:00:00.000Z"),
      message("a1", "assistant", "2026-09-16T10:00:10.000Z"),
      message("a2", "assistant", "2026-09-16T10:00:40.000Z"),
    ]);
    const placed = placeSecretRequestCards(items, [
      secret("secret-1", "2026-09-16T10:00:20.000Z", "provided"),
      secret("secret-2", "2026-09-16T10:00:30.000Z", "pending"),
    ]);
    expect(placed.map((item) => item.id)).toEqual([
      "divider:2026-09-16T10:00:00.000Z",
      "u1",
      "a1",
      "secret:secret-1",
      "a2",
      "secret:secret-2",
    ]);
  });
});

describe("contextBadgeLabel", () => {
  it("shows the size at every weight, not only a heavy chat", () => {
    expect(contextBadgeLabel(12_000)).toBe("12k");
    expect(contextBadgeLabel(120_000)).toBe("120k");
    expect(contextBadgeLabel(612_000)).toBe("612k");
    expect(contextBadgeLabel(1_200_000)).toBe("1.2m");
  });

  it("shows nothing before the chat has reported a size", () => {
    expect(contextBadgeLabel(null)).toBeNull();
    expect(contextBadgeLabel(undefined)).toBeNull();
    expect(contextBadgeLabel(0)).toBeNull();
    expect(contextBadgeLabel(Number.NaN)).toBeNull();
  });
});

/**
 * A group transcript is the same build, told to read the speaker markers.
 * Everything a bot chat renders is unchanged, because `groups` is off there.
 */
describe("buildConversationItems in a group", () => {
  const spoken = (
    id: string,
    createdAt: string,
    speaker: Record<string, unknown>,
    role = "assistant",
  ) =>
    ({
      id,
      kind: "message",
      createdAt,
      message: {
        id,
        role,
        text: id,
        createdAt,
        streaming: false,
        context: {
          records: [
            {
              kind: PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
              payload: { groupId: "g-1", seq: 1, roundId: "r-1", speaker },
            },
          ],
        },
      },
    }) as unknown as TimelineEntry;

  const ada = { kind: "bot", botId: "bot-ada", name: "Ada" };
  const grace = { kind: "bot", botId: "bot-grace", name: "Grace" };

  it("gives each marked message its speaker and collapses a run of the same one", () => {
    const items = buildConversationItems(
      [
        message("u1", "user", "2026-09-19T10:00:00.000Z"),
        spoken("a1", "2026-09-19T10:00:05.000Z", ada),
        spoken("a2", "2026-09-19T10:00:06.000Z", ada),
        spoken("g1", "2026-09-19T10:00:07.000Z", grace),
      ],
      { groups: true },
    );
    expect(items.map((item) => item.kind)).toEqual([
      "divider",
      "message",
      "group-message",
      "group-message",
      "group-message",
    ]);
    const speakers = items.flatMap((item) =>
      item.kind === "group-message" ? [[item.speaker.name, item.showSpeaker] as const] : [],
    );
    expect(speakers).toEqual([
      ["Ada", true],
      ["Ada", false],
      ["Grace", true],
    ]);
  });

  it("re-introduces a speaker after the owner interrupts, and after a gap", () => {
    const items = buildConversationItems(
      [
        spoken("a1", "2026-09-19T10:00:00.000Z", ada),
        message("u1", "user", "2026-09-19T10:00:10.000Z"),
        spoken("a2", "2026-09-19T10:00:20.000Z", ada),
        // Over an hour later: a new divider, so the run starts again.
        spoken("a3", "2026-09-19T12:00:00.000Z", ada),
      ],
      { groups: true },
    );
    expect(
      items.flatMap((item) => (item.kind === "group-message" ? [item.showSpeaker] : [])),
    ).toEqual([true, true, true]);
  });

  it("renders a system row for the service's own messages", () => {
    const items = buildConversationItems(
      [spoken("s1", "2026-09-19T10:00:00.000Z", { kind: "system", event: "member-added" }, "user")],
      { groups: true },
    );
    const system = items.find((item) => item.kind === "group-system");
    expect(system).toBeDefined();
    expect(system!.kind === "group-system" ? system!.event : null).toBe("member-added");
  });

  it("leaves a bot chat exactly as it was: no marker is read without `groups`", () => {
    const items = buildConversationItems([spoken("a1", "2026-09-19T10:00:00.000Z", ada)]);
    expect(items.map((item) => item.kind)).toEqual(["divider", "message"]);
  });
});
