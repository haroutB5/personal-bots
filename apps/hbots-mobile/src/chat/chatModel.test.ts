import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

const at = (iso: string) => DateTime.fromDateUnsafe(new Date(iso));

import {
  buildChatChips,
  chatContextUsage,
  chatSendModelSelection,
  chatHeaderModel,
  contextUsageLabel,
} from "./chatModel";
import { markChatStarted, wasChatStartedHere } from "./useStartChat";

describe("chatHeaderModel", () => {
  it("keeps the bot name from the cached list when the live list is offline", () => {
    const header = chatHeaderModel({
      bot: null,
      shell: null,
      title: "R2 LINK",
      session: null,
      latestTurn: null,
      activities: [],
      providers: [],
      contextUsage: null,
      nowMs: Date.parse("2026-11-04T12:00:00.000Z"),
      fallbackBotName: "Assistant",
    });
    expect(header.botName).toBe("Assistant");
  });

  it("shows the chat's context use with the window size", () => {
    const header = chatHeaderModel({
      bot: null,
      shell: null,
      title: "Hbots",
      session: null,
      latestTurn: null,
      activities: [],
      providers: [],
      contextUsage: { usedTokens: 84_000, maxTokens: 1_000_000 },
      nowMs: Date.parse("2026-11-09T12:00:00.000Z"),
    });
    expect(header.contextBadge).toBe("84k / 1m");
  });

  // 1.67.55: the task chat's header said "Idle" while its task ran gates in the background.
  const backgroundHeader = (session: unknown, latestTurn: unknown, workingInBackground: boolean) =>
    chatHeaderModel({
      bot: null,
      shell: null,
      title: "hbots 1.67.55",
      session: session as never,
      latestTurn: latestTurn as never,
      activities: [],
      providers: [],
      contextUsage: null,
      nowMs: Date.parse("2026-11-23T12:00:00.000Z"),
      workingInBackground,
    });

  it("says Working in background when the chat's task waits on background work", () => {
    const header = backgroundHeader(null, null, true);
    expect(header.stateLabel).toBe("Working in background");
    expect(header.workingInBackground).toBe(true);
    expect(backgroundHeader(null, null, false).stateLabel).toBe("Idle");
  });

  it("says Working once the background job wakes the bot for a live turn", () => {
    const header = backgroundHeader(
      { status: "running", activeTurnId: "t2", updatedAt: "2026-11-23T12:00:00.000Z" },
      { turnId: "t2", state: "running", assistantMessageId: "m2", completedAt: null },
      true,
    );
    expect(header.stateLabel).toBe("Working");
    expect(header.workingInBackground).toBe(false);
  });
});

describe("buildChatChips", () => {
  it("gives a chat just started its chip before the list or its shell arrive", () => {
    const input = {
      botId: "bot-1",
      currentThreadId: "thread-new",
      links: [
        {
          botId: "bot-1",
          threadId: "thread-old",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
        },
      ] as never,
      shells: [{ id: "thread-old", title: "Old chat" }] as never,
    } as const;
    expect(
      buildChatChips({ ...input, startedHere: true }).map((chip) => [
        chip.threadId,
        chip.text,
        chip.current,
      ]),
    ).toEqual([
      ["thread-new", "New chat", true],
      ["thread-old", "Old chat", false],
    ]);
    // A chat opened cold has no chip until its shell arrives.
    expect(buildChatChips(input).map((chip) => chip.threadId)).toEqual(["thread-old"]);
  });

  it("leaves no chip behind when the open chat started here is archived", () => {
    const base = { botId: "bot-1", currentThreadId: "thread-started" } as const;
    const listed = [
      {
        botId: "bot-1",
        threadId: "thread-started",
        createdAt: at("2026-11-13T09:00:00.000Z"),
        archivedAt: null,
      },
    ] as never;
    const chipTexts = (links: never, shells: never) =>
      buildChatChips({
        ...base,
        links,
        shells,
        startedHere: wasChatStartedHere("thread-started", links),
      }).map((chip) => [chip.threadId, chip.text]);

    markChatStarted("thread-started");
    expect(chipTexts([] as never, [] as never)).toEqual([["thread-started", "New chat"]]);
    expect(chipTexts(listed, [{ id: "thread-started", title: "Plan the trip" }] as never)).toEqual([
      ["thread-started", "Plan the trip"],
    ]);
    // Archived: the refreshed list drops its link and the shell stream removes its shell.
    expect(chipTexts([] as never, [] as never)).toEqual([]);
  });

  describe("an archived chat has no chip", () => {
    const open = (threadId: string, minute: number) => ({
      botId: "bot-1",
      threadId,
      createdAt: at(`2026-11-14T16:${minute}:00.000Z`),
      lastActivityAt: at(`2026-11-14T16:${minute}:00.000Z`),
      archivedAt: null,
    });
    const links = [
      open("hbots", 10),
      open("apps", 20),
      // t3_thread_organize archived its thread; the phone's link list is a refresh behind.
      open("sweep", 46),
      { ...open("link-only", 30), archivedAt: at("2026-11-14T16:31:00.000Z") },
    ] as never;
    const shells = [
      { id: "hbots", title: "Hbots" },
      { id: "apps", title: "Apps" },
      {
        id: "sweep",
        title: "PStack stuck-task sweep",
        archivedAt: "2026-11-14T16:46:47.000Z",
        // Its routine run is still queued on the session.
        session: { status: "starting", activeTurnId: null },
      },
      { id: "link-only", title: "Archived from the phone" },
    ] as never;

    it("drops a chat archived on its thread, on its link, or with a run still queued", () => {
      const chips = buildChatChips({ botId: "bot-1", currentThreadId: "hbots", links, shells });
      expect(chips.map((chip) => chip.text)).toEqual(["Apps", "Hbots"]);
    });

    it("keeps the chip of the archived chat open right now, and only while it is open", () => {
      const chips = buildChatChips({ botId: "bot-1", currentThreadId: "sweep", links, shells });
      expect(chips.map((chip) => [chip.threadId, chip.current])).toEqual([
        ["sweep", true],
        ["apps", false],
        ["hbots", false],
      ]);
    });
  });

  it("puts pinned chats first and then newest activity, current chip included", () => {
    const chips = buildChatChips({
      botId: "bot-1",
      currentThreadId: "thread-current",
      links: [
        {
          botId: "bot-1",
          threadId: "thread-old",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
          lastActivityAt: at("2026-11-01T10:00:00.000Z"),
        },
        {
          botId: "bot-1",
          threadId: "thread-pinned",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
          lastActivityAt: at("2026-11-01T09:30:00.000Z"),
          pinnedAt: at("2026-11-02T09:00:00.000Z"),
        },
        {
          botId: "bot-1",
          threadId: "thread-current",
          createdAt: at("2026-11-01T09:00:00.000Z"),
          archivedAt: null,
          lastActivityAt: at("2026-11-03T09:00:00.000Z"),
        },
      ] as never,
      shells: [
        { id: "thread-old", title: "Old chat" },
        { id: "thread-pinned", title: "Pinned chat" },
        { id: "thread-current", title: "Current chat" },
      ] as never,
    });
    expect(chips.map((chip) => chip.threadId)).toEqual([
      "thread-pinned",
      "thread-current",
      "thread-old",
    ]);
    expect(chips.find((chip) => chip.current)?.text).toBe("Current chat");
    expect(chips.find((chip) => chip.threadId === "thread-pinned")?.pinned).toBe(true);
  });
});

describe("chatSendModelSelection", () => {
  it("uses the bot's own model when there is one", () => {
    const bot = {
      modelSelection: { instanceId: "claudeAgent" as never, model: "claude-opus-5-5" },
    };
    expect(
      chatSendModelSelection(bot as never, {
        instanceId: "deepseek" as never,
        model: "deepseek-v4.1",
      }).instanceId,
    ).toBe("claudeAgent");
    expect(
      chatSendModelSelection(null, { instanceId: "deepseek" as never, model: "deepseek-v4.1" })
        .instanceId,
    ).toBe("deepseek");
  });
});

function projection(input: {
  readonly activeProviderThreadId: string | null;
  readonly providerThreads?: ReadonlyArray<unknown>;
  readonly providerTurns?: ReadonlyArray<unknown>;
  readonly visibleTurnItems?: ReadonlyArray<unknown>;
}) {
  return {
    thread: { activeProviderThreadId: input.activeProviderThreadId },
    providerThreads: input.providerThreads ?? [],
    providerTurns: input.providerTurns ?? [],
    visibleTurnItems: input.visibleTurnItems ?? [],
    contextTransfers: [],
  } as never;
}

describe("chatContextUsage", () => {
  it("reads the active provider thread's own report", () => {
    const usage = chatContextUsage(
      projection({
        activeProviderThreadId: "thread-now",
        providerThreads: [
          {
            id: "thread-old",
            contextUsage: { usedTokens: 500_000, maxTokens: 1_000_000 },
            updatedAt: at("2026-11-09T10:00:00.000Z"),
          },
          {
            id: "thread-now",
            contextUsage: { usedTokens: 84_000, maxTokens: 1_000_000 },
            updatedAt: at("2026-11-09T11:00:00.000Z"),
          },
        ],
      }),
    );
    expect(usage).toEqual({ usedTokens: 84_000, maxTokens: 1_000_000 });
    expect(contextUsageLabel(usage)).toBe("84k / 1m");
  });

  it("reads the newest turn before the provider thread reports its own use", () => {
    const usage = chatContextUsage(
      projection({
        activeProviderThreadId: "thread-now",
        providerThreads: [
          { id: "thread-now", contextUsage: null, updatedAt: at("2026-11-09T11:00:00.000Z") },
        ],
        providerTurns: [
          {
            providerThreadId: "thread-now",
            tokenUsage: {
              usedTokens: 40_000,
              maxTokens: 200_000,
              updatedAt: "2026-11-09T10:00:00.000Z",
            },
          },
          {
            providerThreadId: "thread-now",
            tokenUsage: {
              usedTokens: 120_000,
              maxTokens: 200_000,
              updatedAt: "2026-11-09T11:00:00.000Z",
            },
          },
        ],
      }),
    );
    expect(contextUsageLabel(usage)).toBe("120k / 200k");
  });

  it("keeps the number when the window size is unknown", () => {
    expect(contextUsageLabel({ usedTokens: 612_000, maxTokens: null })).toBe("612k");
  });

  it("shows nothing before the chat reports any use", () => {
    expect(chatContextUsage(null)).toBeNull();
    expect(chatContextUsage(projection({ activeProviderThreadId: null }))).toBeNull();
    expect(contextUsageLabel(null)).toBeNull();
  });
});
