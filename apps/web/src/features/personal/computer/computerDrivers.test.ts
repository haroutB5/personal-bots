import type { PersonalBrowserStatus, PersonalDesktopStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  browserDriver,
  buildQueue,
  desktopDriver,
  driverLine,
  headerSubline,
  type SourceDriver,
} from "./computerDrivers";
import type { ComputerActivityEvent } from "./computerContract";

const NOW = Date.parse("2026-10-26T10:10:00.000Z");

function browserStatus(overrides: Record<string, unknown> = {}): PersonalBrowserStatus {
  return {
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
  } as PersonalBrowserStatus;
}

function desktopStatus(overrides: Record<string, unknown> = {}): PersonalDesktopStatus {
  return {
    available: true,
    holder: null,
    waiting: [],
    lastStop: null,
    stopHotkey: "Super+Shift+F12",
    ...overrides,
  } as PersonalDesktopStatus;
}

const agent = {
  _tag: "Agent",
  threadId: "t1",
  botId: "b1",
  botName: "Assistant",
} as const;

function step(minutesAgo: number, summary: string, over: Partial<ComputerActivityEvent> = {}) {
  return {
    id: `${summary}-${minutesAgo}`,
    source: "browser",
    kind: "click",
    summary,
    status: "succeeded",
    at: new Date(NOW - minutesAgo * 60_000).toISOString(),
    threadId: "t1",
    botName: "Assistant",
    botId: "b1",
    point: null,
    chars: null,
    ...over,
  } as ComputerActivityEvent;
}

describe("drivers", () => {
  it("reads the browser lease holder as using Brave", () => {
    const driver = browserDriver(
      browserStatus({ controller: agent }),
      [step(3, "Clicked Buy")],
      false,
    );
    expect(driver).toMatchObject({ state: "using", botName: "Assistant", threadId: "t1" });
    expect(driver.since).toBe(NOW - 3 * 60_000);
  });

  it("keeps the last bot as idle after the lease lapses", () => {
    const driver = browserDriver(
      browserStatus({ lastAgent: { threadId: "t1", botId: "b1" } }),
      [step(2, "Clicked Buy")],
      false,
    );
    expect(driver).toMatchObject({ state: "idle", botName: "Assistant" });
    expect(browserDriver(browserStatus({ state: "offline" }), [], false).state).toBe("none");
    expect(browserDriver(browserStatus({ controller: agent }), [], true).state).toBe("you");
  });

  it("reads the desktop holder", () => {
    const holder = {
      threadId: "t2",
      botId: "b2",
      botName: "Researcher",
      since: new Date(NOW - 5 * 60_000).toISOString(),
      lastActionAt: new Date(NOW).toISOString(),
    };
    expect(desktopDriver(desktopStatus({ holder }), false)).toMatchObject({
      state: "using",
      botName: "Researcher",
      since: NOW - 5 * 60_000,
    });
    expect(desktopDriver(desktopStatus({ holder: { ...holder, kind: "user" } }), false).state).toBe(
      "you",
    );
    expect(desktopDriver(desktopStatus({ available: false }), false).state).toBe("none");
  });
});

describe("buildQueue", () => {
  it("lists the desktop line then the browser line, once each", () => {
    const queue = buildQueue({
      browser: browserStatus({ waiting: [{ threadId: "t9", botId: "b9", botName: "Nine" }] }),
      desktop: desktopStatus({
        waiting: [
          { threadId: "t3", botId: "b3", botName: "Three" },
          { threadId: "t3", botId: "b3", botName: "Three" },
        ],
      }),
      paused: null,
    });
    expect(queue.next.map((entry) => [entry.botName, entry.source])).toEqual([
      ["Three", "desktop"],
      ["Nine", "browser"],
    ]);
  });

  it("puts the bot you paused first", () => {
    const paused: SourceDriver = {
      source: "desktop",
      state: "using",
      botId: "b2",
      botName: "Researcher",
      threadId: "t2",
      since: null,
    };
    expect(buildQueue({ browser: null, desktop: null, paused }).paused).toMatchObject({
      botName: "Researcher",
      source: "desktop",
    });
  });

  it("tolerates malformed waiting entries", () => {
    expect(
      buildQueue({
        browser: browserStatus({ waiting: [{ nope: true }, 5, null] }),
        desktop: null,
        paused: null,
      }).next,
    ).toEqual([]);
  });
});

describe("headerSubline", () => {
  const using: SourceDriver = {
    source: "browser",
    state: "using",
    botId: "b1",
    botName: "Assistant",
    threadId: "t1",
    since: null,
  };
  const none = (source: "browser" | "desktop"): SourceDriver => ({
    source,
    state: "none",
    botId: null,
    botName: null,
    threadId: null,
    since: null,
  });
  const base = {
    shown: "browser" as const,
    reachable: true,
    browser: browserStatus(),
    browserDriver: using,
    desktopDriver: none("desktop"),
    youControl: false,
    otherDevice: false,
    connecting: false,
  };

  it("follows the spec table", () => {
    expect(headerSubline(base)).toEqual({ text: "Assistant is using Brave", tone: "live" });
    expect(
      headerSubline({ ...base, shown: "desktop", desktopDriver: { ...using, source: "desktop" } }),
    ).toEqual({ text: "Assistant is using the desktop", tone: "live" });
    expect(headerSubline({ ...base, browserDriver: { ...using, state: "idle" } })).toEqual({
      text: "Assistant left Brave open",
      tone: "idle",
    });
    expect(headerSubline({ ...base, youControl: true }).tone).toBe("control");
    expect(headerSubline({ ...base, otherDevice: true }).text).toBe(
      "You're controlling it from another device",
    );
    expect(headerSubline({ ...base, browserDriver: none("browser") }).text).toBe(
      "Nobody is using it",
    );
    expect(headerSubline({ ...base, reachable: false }).text).toBe("Laptop offline");
  });

  it("puts a help request or sensitive pause above everything else", () => {
    const help = {
      threadId: "t1",
      botId: "b1",
      botName: "Assistant",
      reason: "CAPTCHA",
      requestedAt: "2026-10-26T10:00:00.000Z",
    };
    expect(headerSubline({ ...base, browser: browserStatus({ helpRequest: help }) })).toEqual({
      text: "Assistant needs your help",
      tone: "review",
    });
    expect(
      headerSubline({
        ...base,
        browser: browserStatus({
          helpRequest: help,
          egressPause: { threadId: "t1", botId: "b1", botName: "Assistant", destination: "x.com" },
        }),
      }).text,
    ).toBe("Assistant is waiting for your OK");
  });
});

describe("driverLine", () => {
  const driver = browserDriver(
    browserStatus({ controller: agent }),
    [step(3, "Clicked Buy")],
    false,
  );
  it("joins place, time and the latest step", () => {
    expect(driverLine({ driver, events: [step(3, "Clicked Buy")], now: NOW })).toBe(
      "Using Brave · 3 min · clicked Buy",
    );
  });

  it("counts down how long an idle Brave stays open", () => {
    const idle = browserDriver(
      browserStatus({ lastAgent: { threadId: "t1", botId: "b1" } }),
      [step(3, "Clicked Buy")],
      false,
    );
    expect(driverLine({ driver: idle, events: [step(3, "Clicked Buy")], now: NOW })).toBe(
      "Idle · Brave stays open for 7 min",
    );
    expect(driverLine({ driver: idle, events: [], now: NOW })).toBe("Idle · Brave stays open");
  });
});
