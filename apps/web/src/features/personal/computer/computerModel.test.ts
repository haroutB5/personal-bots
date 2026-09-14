import {
  PERSONAL_BROWSER_FILES_ROUTE_PREFIX,
  PERSONAL_BROWSER_STREAM_PATH,
  PersonalBotId,
  ThreadId,
  type PersonalBrowserActivityEvent,
  type PersonalBrowserStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeAgentLine,
  backToChatTarget,
  computerIsActiveForChat,
  computerPanelDetail,
  describeComputerState,
  EMPTY_COMPUTER_FEED,
  formatActivityTime,
  mapViewportPoint,
  PERSONAL_BROWSER_ROUTE_BASE,
  reduceComputerFeed,
} from "./computerModel";

const status = (overrides: Partial<PersonalBrowserStatus> = {}): PersonalBrowserStatus => ({
  state: "connected",
  detail: null,
  lockedByPid: null,
  controller: { _tag: "None" },
  generation: 1,
  page: null,
  viewers: 0,
  ...overrides,
});

const event = (id: string): PersonalBrowserActivityEvent => ({
  id,
  kind: "navigate",
  summary: `Opened ${id}`,
  status: "succeeded",
  at: "2026-09-13T20:40:00.000Z",
  threadId: ThreadId.make("thread-a"),
  botName: "Developer",
});

describe("computer feed", () => {
  it("replaces history with the Recent backlog, then appends live events once", () => {
    const withRecent = reduceComputerFeed(EMPTY_COMPUTER_FEED, {
      _tag: "Recent",
      events: [event("a"), event("b")],
    });
    const withLive = reduceComputerFeed(withRecent, { _tag: "Activity", event: event("c") });
    const duplicate = reduceComputerFeed(withLive, { _tag: "Activity", event: event("c") });
    expect(duplicate.events.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(reduceComputerFeed(duplicate, { _tag: "Status", status: status() }).status?.state).toBe(
      "connected",
    );
  });

  it("names the bot only while an agent lease is live", () => {
    expect(activeAgentLine(status())).toBeNull();
    expect(
      activeAgentLine(status({ controller: { _tag: "Human", self: true, connected: true } })),
    ).toBeNull();
    expect(
      activeAgentLine(
        status({
          controller: {
            _tag: "Agent",
            threadId: ThreadId.make("t"),
            botId: null,
            botName: "Developer",
          },
        }),
      ),
    ).toBe("Developer is using the browser");
  });

  it("targets the leased bot's chat for Back to chat, else falls back", () => {
    expect(backToChatTarget(null)).toBeNull();
    expect(backToChatTarget(status())).toBeNull();
    expect(
      backToChatTarget(status({ controller: { _tag: "Human", self: true, connected: true } })),
    ).toBeNull();
    expect(
      backToChatTarget(
        status({
          controller: {
            _tag: "Agent",
            threadId: ThreadId.make("thread-a"),
            botId: null,
            botName: "Developer",
          },
        }),
      ),
    ).toBeNull();
    expect(
      backToChatTarget(
        status({
          controller: {
            _tag: "Agent",
            threadId: ThreadId.make("thread-a"),
            botId: PersonalBotId.make("bot-1"),
            botName: "Developer",
          },
        }),
      ),
    ).toEqual({ botId: "bot-1", threadId: "thread-a" });
  });

  it("only activates a chat panel for the exact leased bot and thread", () => {
    const leased = status({
      controller: {
        _tag: "Agent",
        threadId: ThreadId.make("thread-a"),
        botId: PersonalBotId.make("bot-1"),
        botName: "Developer",
      },
    });
    expect(computerIsActiveForChat(leased, { botId: "bot-1", threadId: "thread-a" })).toBe(true);
    expect(computerIsActiveForChat(leased, { botId: "bot-2", threadId: "thread-a" })).toBe(false);
    expect(computerIsActiveForChat(leased, { botId: "bot-1", threadId: "thread-b" })).toBe(false);
    expect(computerIsActiveForChat(status(), { botId: "bot-1", threadId: "thread-a" })).toBe(false);
  });

  it("shows the current page title in the compact bar only for a live viewport", () => {
    expect(
      computerPanelDetail(
        status({ page: { title: "T3 Code", url: "https://t3.codes" } }),
        "Connected",
      ),
    ).toBe("T3 Code");
    expect(
      computerPanelDetail(
        status({ state: "starting", page: { title: "Old page", url: "https://example.com" } }),
        "Starting browser",
      ),
    ).toBe("Starting browser");
  });

  it("separates an unreachable laptop from browser states", () => {
    expect(
      describeComputerState({ status: status(), reachable: false, loading: false }).label,
    ).toBe("Laptop offline");
    expect(
      describeComputerState({
        status: status({ state: "locked" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({ label: "Browser profile locked", tone: "problem" });
    expect(describeComputerState({ status: null, reachable: true, loading: true }).label).toBe(
      "Connecting",
    );
  });
});

describe("viewport input mapping", () => {
  it("maps the displayed frame onto remote CSS pixels regardless of device scale", () => {
    const rect = { left: 20, top: 100, width: 350, height: 700 };
    const meta = { width: 390, height: 780, deviceScaleFactor: 3 };
    expect(mapViewportPoint({ clientX: 195, clientY: 450, rect, meta })).toEqual({
      x: 195,
      y: 390,
    });
    expect(mapViewportPoint({ clientX: -50, clientY: 2000, rect, meta })).toEqual({ x: 0, y: 780 });
    expect(
      mapViewportPoint({ clientX: 1, clientY: 1, rect: { ...rect, width: 0 }, meta }),
    ).toBeNull();
  });

  it("builds the same routes the server serves", () => {
    expect(`${PERSONAL_BROWSER_ROUTE_BASE}/stream`).toBe(PERSONAL_BROWSER_STREAM_PATH);
    expect(`${PERSONAL_BROWSER_ROUTE_BASE}/files`).toBe(PERSONAL_BROWSER_FILES_ROUTE_PREFIX);
  });

  it("shows activity times in Europe/London", () => {
    expect(formatActivityTime("2026-09-13T20:40:00.000Z")).toBe("21:40");
    expect(formatActivityTime("not a date")).toBe("");
  });
});
