import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  MessageId,
  PersonalBot,
  ThreadId,
  type ModelSelection,
  type OrchestrationSession,
  type OrchestrationSessionProviderRetry,
  type PersonalBotThread,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "~/types";

import { motionForSummary } from "./avatarMotion";
import { BOT_ERROR_LABEL, botStatus, buildBotSummaries, isThreadErrored } from "./botSummaries";
import {
  autoRetryNotice,
  conversationStateLabel,
  deriveConversationState,
  failedTurnError,
  friendlyTurnError,
  providerFriendlyLabel,
  turnErrorNotice,
} from "./conversationModel";
import { pinnedBotBadge } from "./PinnedStrip";
import { buildRetryTurnInput, findRetryTarget } from "./retryFailedTurn";

const renewal = (provider: string): OrchestrationSessionProviderRetry =>
  ({
    kind: "retrying",
    auto: "pending",
    attempt: 1,
    maxAttempts: 1,
    reason: "session_renewed",
    provider,
    observedAt: "2026-09-30T10:00:00.000Z",
  }) as OrchestrationSessionProviderRetry;

const session = (overrides: Partial<OrchestrationSession>): OrchestrationSession =>
  ({
    threadId: "thread-1",
    status: "ready",
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  }) as OrchestrationSession;

const derive = (value: OrchestrationSession | null) =>
  deriveConversationState({
    session: value,
    latestTurn: null,
    pendingApprovals: [],
    pendingUserInputs: [],
  });

describe("failed turn state", () => {
  it("stays Error while the session is in error, and clears on the next good turn", () => {
    const failed = session({ status: "error", lastError: "Claude Code process exited" });
    expect(derive(failed)).toBe("error");
    expect(conversationStateLabel("error", failed, new Date())).toBe("Error");
    // The server moves running -> ready with lastError null on success.
    const recovered = session({ status: "ready", lastError: null });
    expect(derive(recovered)).toBe("idle");
    expect(
      turnErrorNotice({ state: "idle", session: recovered, lastMessageTurnStarted: true }),
    ).toBeNull();
  });

  it("reads a pending session renewal as Retrying with a neutral notice, never Error", () => {
    const renewing = session({ status: "starting", providerRetry: renewal("claudeAgent") });
    const state = derive(renewing);
    expect(state).toBe("retrying");
    const notice = turnErrorNotice({ state, session: renewing, lastMessageTurnStarted: false });
    expect(notice).toMatchObject({
      message: "The old Claude session for this chat has ended. Retrying on a new session…",
      tone: "info",
      canRetry: false,
    });
  });

  it("goes to Error with the real reason once the renewed retry also fails", () => {
    const failed = session({
      status: "error",
      lastError: "Error: Not logged in · Please run /login",
    });
    const state = derive(failed);
    expect(state).toBe("error");
    expect(turnErrorNotice({ state, session: failed, lastMessageTurnStarted: true })).toMatchObject(
      {
        message: "The provider isn't signed in on your computer.",
        tone: "danger",
        canRetry: true,
      },
    );
  });

  it("says Couldn't send when the message never got a turn", () => {
    const failed = session({ status: "error", lastError: "spawn claude ENOENT" });
    const notice = turnErrorNotice({
      state: "error",
      session: failed,
      lastMessageTurnStarted: false,
    });
    expect(notice?.message).toBe("Couldn't send: spawn claude ENOENT");
    expect(notice?.canRetry).toBe(true);
    expect(
      failedTurnError({ raw: "Request timed out after 120000ms", turnStarted: false }),
    ).toEqual({
      message: "Couldn't send: The reply took too long and was stopped. Try again.",
      detail: "Request timed out after 120000ms",
    });
    expect(failedTurnError({ raw: "The last turn failed.", turnStarted: false }).message).toBe(
      "Couldn't send: the bot couldn't start a reply. Try again.",
    );
  });

  it("offers no Retry when the last user message is not the owner's", () => {
    const failed = session({ status: "error", lastError: "boom" });
    expect(
      turnErrorNotice({ state: "error", session: failed, lastMessageTurnStarted: null })?.canRetry,
    ).toBe(false);
  });

  it("never shows secrets from the provider's line", () => {
    const friendly = friendlyTurnError(
      "Error: 401 invalid x-api-key sk-ant-api03-abcdefghijklmnop Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    );
    expect(friendly.detail).not.toContain("sk-ant-api03-abcdefghijklmnop");
    expect(friendly.detail).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(friendly.detail).toContain("[hidden]");
  });
});

describe("autoRetryNotice for a renewed session", () => {
  it("names the old session's provider", () => {
    expect(autoRetryNotice(renewal("claudeAgent"))).toBe(
      "The old Claude session for this chat has ended. Retrying on a new session…",
    );
    expect(autoRetryNotice(renewal("codex"))).toBe(
      "The old Codex session for this chat has ended. Retrying on a new session…",
    );
  });

  it("falls back to plain words for a provider it cannot name", () => {
    expect(providerFriendlyLabel("somethingNew")).toBeNull();
    expect(autoRetryNotice(renewal("somethingNew"))).toBe(
      "This chat's old session has ended. Retrying on a new session…",
    );
  });
});

const attachment = {
  type: "image",
  id: "att-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 1234,
  previewUrl: "blob:local-preview",
};

const message = (overrides: Partial<ChatMessage>): ChatMessage =>
  ({
    id: MessageId.make("msg-1"),
    role: "user",
    text: "Summarise this",
    attachments: [attachment],
    turnId: null,
    streaming: false,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  }) as unknown as ChatMessage;

const threadFields = {
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus" } as unknown as ModelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

describe("Retry for a failed message", () => {
  const fresh = MessageId.make("msg-new");
  const build = (target: NonNullable<ReturnType<typeof findRetryTarget>>) =>
    buildRetryTurnInput({
      threadId: ThreadId.make("thread-1"),
      thread: threadFields,
      botModelSelection: null,
      target,
      freshMessageId: fresh,
      createdAt: "2026-09-30T10:05:00.000Z",
    });

  it("re-requests the turn under the same id when the message never got one", () => {
    const target = findRetryTarget([message({ turnId: null })]);
    expect(target?.turnStarted).toBe(false);
    const input = build(target!);
    expect(input.message.messageId).toBe("msg-1");
    expect(input.message.text).toBe("Summarise this");
    // Carried as sent, minus the browser-only preview URL.
    expect(input.message.attachments).toEqual([
      { type: "image", id: "att-1", name: "shot.png", mimeType: "image/png", sizeBytes: 1234 },
    ]);
  });

  it("sends a new id when the message's turn started and failed", () => {
    const target = findRetryTarget([
      message({ id: MessageId.make("old"), turnId: null }),
      message({ turnId: "turn-1" as ChatMessage["turnId"] }),
    ]);
    expect(target?.turnStarted).toBe(true);
    const input = build(target!);
    expect(input.message.messageId).toBe("msg-new");
    expect(input.message.attachments).toHaveLength(1);
    expect(input.message.attachments[0]).not.toHaveProperty("previewUrl");
  });

  it("sends the bot's model whatever provider it is on, the thread's only while the bot is unknown", () => {
    const target = findRetryTarget([message({})])!;
    const same = { instanceId: "claudeAgent", model: "claude-sonnet" } as unknown as ModelSelection;
    const other = { instanceId: "codex", model: "gpt" } as unknown as ModelSelection;
    const input = (bot: ModelSelection | null) =>
      buildRetryTurnInput({
        threadId: ThreadId.make("thread-1"),
        thread: threadFields,
        botModelSelection: bot,
        target,
        freshMessageId: fresh,
        createdAt: "2026-09-30T10:05:00.000Z",
      });
    expect(input(same).modelSelection).toBe(same);
    // A thread copy older than a provider switch must not beat the bot's.
    expect(input(other).modelSelection).toBe(other);
    expect(input(null).modelSelection).toBe(threadFields.modelSelection);
  });

  it("finds nothing to retry when the last user message is not the owner's", () => {
    expect(findRetryTarget([])).toBeNull();
    const assistantOnly = [message({ role: "assistant" as ChatMessage["role"] })];
    expect(findRetryTarget(assistantOnly)).toBeNull();
  });
});

const decodeBot = Schema.decodeUnknownSync(PersonalBot);

const shell = (id: string, overrides: Record<string, unknown> = {}): EnvironmentThreadShell =>
  ({
    id,
    title: `Thread ${id}`,
    updatedAt: "2026-09-30T09:00:00.000Z",
    createdAt: "2026-09-30T09:00:00.000Z",
    latestUserMessageAt: null,
    archivedAt: null,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

describe("Bots list and pinned tile for a chat whose reply failed", () => {
  const bots = [
    decodeBot({
      botId: "assistant",
      name: "Assistant",
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: "codex", model: "some-model" },
      enabled: true,
      sortOrder: 0,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    }),
  ];
  const links = [
    { botId: "assistant", threadId: "t1", createdAt: "2026-09-01T10:00:00.000Z", archivedAt: null },
  ] as unknown as PersonalBotThread[];
  const providers = [
    {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
    },
  ] as unknown as ServerProvider[];
  const now = Date.parse("2026-09-30T10:00:00.000Z");
  const summaryFor = (value: OrchestrationSession | null) =>
    buildBotSummaries({ bots, links, shells: [shell("t1", { session: value })], providers })[0]!;

  it("labels the row Couldn't reply and badges the tile", () => {
    const summary = summaryFor(session({ status: "error", lastError: "boom" }));
    expect(summary.erroredThread?.id).toBe("t1");
    expect(botStatus(summary, now)).toEqual({ label: BOT_ERROR_LABEL, tone: "review" });
    expect(BOT_ERROR_LABEL).toBe("Couldn't reply");
    // The tile's screen-reader label is the row's status whenever it is badged.
    expect(pinnedBotBadge(summary, now)).toBe("attention");
    expect(motionForSummary(summary)).toBe("blocked");
  });

  it("ranks below working, a rate limit and the needs-you states", () => {
    const summary = summaryFor(session({ status: "error", lastError: "boom" }));
    expect(botStatus({ ...summary, live: true }, now).label).toBe("Working");
    expect(botStatus({ ...summary, hasPendingApprovals: true }, now).label).toBe("Needs approval");
    expect(botStatus({ ...summary, needsBrowserHelp: true }, now).label).toBe("Needs your help");
  });

  it("is not an error while the server renews the session, nor after a good turn", () => {
    expect(
      isThreadErrored(
        shell("t1", {
          session: session({ status: "starting", providerRetry: renewal("claudeAgent") }),
        }),
      ),
    ).toBe(false);
    const recovered = summaryFor(session({ status: "ready" }));
    expect(recovered.erroredThread).toBeNull();
    expect(botStatus(recovered, now).label).not.toBe(BOT_ERROR_LABEL);
  });

  it("an older chat that failed does not pin the row once a newer chat exists", () => {
    const twoLinks = [
      ...links,
      {
        botId: "assistant",
        threadId: "t2",
        createdAt: "2026-09-02T10:00:00.000Z",
        archivedAt: null,
      },
    ] as unknown as PersonalBotThread[];
    const summary = buildBotSummaries({
      bots,
      links: twoLinks,
      shells: [
        shell("t1", {
          session: session({ status: "error", lastError: "boom" }),
          createdAt: "2026-09-01T10:00:00.000Z",
          latestUserMessageAt: "2026-09-01T10:00:00.000Z",
        }),
        shell("t2", {
          session: session({ status: "ready" }),
          createdAt: "2026-09-30T09:00:00.000Z",
          latestUserMessageAt: "2026-09-30T09:00:00.000Z",
        }),
      ],
      providers,
    })[0]!;
    expect(summary.erroredThread).toBeNull();
    expect(botStatus(summary, now).label).not.toBe(BOT_ERROR_LABEL);
  });
});
