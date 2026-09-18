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
  canCloseBrowser,
  closeBrowserConfirmMessage,
  computerIsActiveForChat,
  computerPanelDetail,
  describeComputerState,
  EMPTY_COMPUTER_FEED,
  fitFrame,
  formatActivityTime,
  mapViewportPoint,
  PERSONAL_BROWSER_ROUTE_BASE,
  planViewportRequest,
  reduceComputerFeed,
} from "./computerModel";

const status = (overrides: Partial<PersonalBrowserStatus> = {}): PersonalBrowserStatus => ({
  state: "connected",
  detail: null,
  lockedByPid: null,
  controller: { _tag: "None" },
  generation: 1,
  page: null,
  helpRequest: null,
  lastAgent: null,
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

  it("labels running, idle-lease and help states honestly", () => {
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
        true,
      ),
    ).toBe("Developer is using the browser");
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
    ).toBe("Developer left the browser open");
    expect(
      activeAgentLine(
        status({
          helpRequest: {
            threadId: ThreadId.make("t"),
            botId: PersonalBotId.make("bot-1"),
            botName: "Developer",
            reason: "CAPTCHA on example.com",
            requestedAt: "2026-09-15T10:00:00.000Z",
          },
        }),
      ),
    ).toBe("Needs your help: CAPTCHA on example.com");
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

  // QA v1.10.0 BUG-4: green dot beside "left the browser open" under an Idle header.
  it("reads idle when the lease holder's turn has ended, live while someone works", () => {
    const agent = status({
      controller: {
        _tag: "Agent",
        threadId: ThreadId.make("thread-a"),
        botId: PersonalBotId.make("bot-1"),
        botName: "Developer",
      },
    });
    const tone = (input: PersonalBrowserStatus, agentTurnRunning?: boolean) =>
      describeComputerState({
        status: input,
        reachable: true,
        loading: false,
        ...(agentTurnRunning === undefined ? {} : { agentTurnRunning }),
      }).tone;
    expect(tone(agent, false)).toBe("idle");
    expect(tone(status(), false)).toBe("idle");
    expect(tone(agent, true)).toBe("live");
    expect(
      tone(status({ controller: { _tag: "Human", self: true, connected: true } }), false),
    ).toBe("live");
    // A caller that cannot tell keeps the old reading.
    expect(tone(agent)).toBe("live");
  });
});

describe("full-screen frame fit", () => {
  it("letterboxes a laptop frame into a portrait phone box without stretching it", () => {
    const fitted = fitFrame({ width: 390, height: 640 }, 1280 / 720);
    expect(fitted).toEqual({ width: 390, height: 219 });
    // Uniform scale: the fitted box keeps the frame's ratio.
    expect(Math.abs(fitted!.width / fitted!.height - 1280 / 720)).toBeLessThan(0.01);
  });

  it("pillarboxes a tall frame and fills exactly when the server applied the phone's box", () => {
    expect(fitFrame({ width: 390, height: 640 }, 390 / 844)).toEqual({ width: 295, height: 640 });
    expect(fitFrame({ width: 390, height: 640 }, 390 / 640)).toEqual({ width: 390, height: 640 });
    expect(fitFrame({ width: 393, height: 659 }, 393 / 659)).toEqual({ width: 393, height: 659 });
  });

  it("fits nothing before the box is measured", () => {
    expect(fitFrame({ width: 0, height: 640 }, 1)).toBeNull();
    expect(fitFrame({ width: 390, height: 640 }, Number.NaN)).toBeNull();
  });
});

describe("phone viewport requests", () => {
  const socket = { id: "socket-1" };
  const box = { width: 390.4, height: 639.6 };

  it("sends the first box on a socket at once, rounded to CSS pixels", () => {
    expect(planViewportRequest({ box, client: socket, sent: null })).toEqual({
      width: 390,
      height: 640,
      key: "390x640",
      immediate: true,
    });
  });

  it("sends nothing for an unchanged box and debounces a changed one", () => {
    const sent = { client: socket, key: "390x640" };
    expect(planViewportRequest({ box, client: socket, sent })).toBeNull();
    expect(planViewportRequest({ box: { width: 390, height: 360 }, client: socket, sent })).toEqual(
      { width: 390, height: 360, key: "390x360", immediate: false },
    );
  });

  it("resends at once on a new socket, since the server dropped the old one's viewport", () => {
    const sent = { client: socket, key: "390x640" };
    expect(planViewportRequest({ box, client: { id: "socket-2" }, sent })?.immediate).toBe(true);
  });

  it("waits for both a measured box and an open socket", () => {
    expect(planViewportRequest({ box: null, client: socket, sent: null })).toBeNull();
    expect(planViewportRequest({ box, client: null, sent: null })).toBeNull();
    expect(
      planViewportRequest({ box: { width: 0, height: 0 }, client: socket, sent: null }),
    ).toBeNull();
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

describe("closing the browser", () => {
  it("only offers a close while there is a session to close", () => {
    expect(canCloseBrowser(null)).toBe(false);
    expect(canCloseBrowser(status({ state: "offline" }))).toBe(false);
    for (const state of [
      "connected",
      "starting",
      "waiting_for_login",
      "crashed",
      "locked",
    ] as const)
      expect(canCloseBrowser(status({ state }))).toBe(true);
  });

  it("confirms only when a bot is mid-task, and names it", () => {
    expect(closeBrowserConfirmMessage(status())).toBeNull();
    expect(
      closeBrowserConfirmMessage(
        status({ controller: { _tag: "Human", self: true, connected: true } }),
      ),
    ).toBeNull();

    const agent = closeBrowserConfirmMessage(
      status({
        controller: {
          _tag: "Agent",
          threadId: ThreadId.make("thread-a"),
          botId: PersonalBotId.make("bot-1"),
          botName: "Developer",
        },
      }),
      true,
    );
    expect(agent).toContain("Developer is using the browser");
    expect(
      closeBrowserConfirmMessage(
        status({
          controller: {
            _tag: "Agent",
            threadId: ThreadId.make("thread-a"),
            botId: PersonalBotId.make("bot-1"),
            botName: "Developer",
          },
        }),
      ),
    ).toContain("Developer left the browser open");

    // An unnamed bot still earns the prompt: the interruption is the point.
    expect(
      closeBrowserConfirmMessage(
        status({
          controller: {
            _tag: "Agent",
            threadId: ThreadId.make("thread-a"),
            botId: PersonalBotId.make("bot-1"),
            botName: null,
          },
        }),
        true,
      ),
    ).toContain("A bot is using the browser");
  });

  // QA v1.10.0 BUG-3: "…can't be submitted.. Close it anyway?"
  it("names a pending help request instead of quoting its punctuated reason", () => {
    const helpRequest = {
      threadId: ThreadId.make("thread-a"),
      botId: PersonalBotId.make("bot-1"),
      botName: "Assistant",
      reason: "The reCAPTCHA can't be submitted.",
      requestedAt: "2026-09-15T13:47:32.000Z",
    };
    const agent = {
      _tag: "Agent" as const,
      threadId: ThreadId.make("thread-a"),
      botId: PersonalBotId.make("bot-1"),
      botName: "Assistant",
    };
    const withLease = closeBrowserConfirmMessage(status({ controller: agent, helpRequest }));
    expect(withLease).toMatch(/^Assistant is waiting for your help\. Close it anyway\?\n/);
    expect(withLease).not.toContain("..");
    // The request outlives the agent lease's TTL, and closing still ends it.
    expect(closeBrowserConfirmMessage(status({ helpRequest }))).toContain(
      "Assistant is waiting for your help",
    );
    // The user already helping in control closes without a prompt.
    expect(
      closeBrowserConfirmMessage(
        status({ controller: { _tag: "Human", self: true, connected: true }, helpRequest }),
      ),
    ).toBeNull();
  });
});
