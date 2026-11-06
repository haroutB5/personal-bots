import {
  PersonalBotId,
  ThreadId,
  type PersonalBrowserFile,
  type PersonalBrowserStatus,
  type PersonalDesktopStatus,
} from "@t3tools/contracts";
import type { ComputerActivityEvent } from "@hbots/personal-client/computer/computerContract";
import type { DriverState, SourceDriver } from "@hbots/personal-client/computer/computerDrivers";
import { describe, expect, it } from "vite-plus/test";

import {
  activeEgressPause,
  activitySheetTitle,
  browserEvents,
  browserStage,
  browserToolbar,
  computerActions,
  computerDotTone,
  computerHeader,
  desktopEvents,
  desktopQueue,
  formatFileRow,
  liveViewMode,
  pageAddressLabel,
} from "./computerScreenModel";

const thread = ThreadId.make("thread-1");
const otherThread = ThreadId.make("thread-2");
const bot = PersonalBotId.make("bot-ada");

function browserStatus(overrides: Partial<PersonalBrowserStatus> = {}): PersonalBrowserStatus {
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
  };
}

function desktopStatus(overrides: Partial<PersonalDesktopStatus> = {}): PersonalDesktopStatus {
  return {
    available: true,
    holder: null,
    waiting: [],
    lastStop: null,
    stopHotkey: "",
    ...overrides,
  };
}

function driver(
  source: "browser" | "desktop",
  state: DriverState,
  overrides: Partial<SourceDriver> = {},
): SourceDriver {
  return {
    source,
    state,
    botId: null,
    botName: null,
    threadId: null,
    since: null,
    ...overrides,
  };
}

const adaUsingBrowser = driver("browser", "using", {
  botId: "bot-ada",
  botName: "Ada",
  threadId: "thread-1",
});

const nobody = driver("browser", "none");

function event(
  overrides: Partial<ComputerActivityEvent> & Pick<ComputerActivityEvent, "id">,
): ComputerActivityEvent {
  return {
    source: "browser",
    kind: "click",
    summary: "Clicked Buy",
    status: "succeeded",
    at: "2026-11-06T10:00:00.000Z",
    threadId: "thread-1",
    botName: "Ada",
    botId: "bot-ada",
    point: null,
    chars: null,
    ...overrides,
  };
}

describe("browserStage", () => {
  it("reads an unreachable environment as offline", () => {
    expect(browserStage({ status: browserStatus(), reachable: false, loading: false })).toEqual({
      kind: "offline",
      message:
        "The laptop is offline. The browser keeps running there and reappears when it reconnects.",
    });
  });

  it("is connecting before the first status arrives, then offline", () => {
    expect(browserStage({ status: null, reachable: true, loading: true })).toEqual({
      kind: "connecting",
      message: "Connecting to the laptop.",
    });
    expect(browserStage({ status: null, reachable: true, loading: false })).toEqual({
      kind: "offline",
      message:
        "The laptop is offline. The browser keeps running there and reappears when it reconnects.",
    });
  });

  it("is starting while Brave launches", () => {
    expect(
      browserStage({
        status: browserStatus({ state: "starting" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({ kind: "starting", message: "Starting Brave on the laptop." });
  });

  it("names the pid that holds the Brave profile when the server sends one", () => {
    expect(
      browserStage({
        status: browserStatus({ state: "locked", lockedByPid: 4312 }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({
      kind: "locked",
      message:
        "Brave's profile is in use by another window (pid 4312). Close it on the laptop, then take control to retry.",
    });
    expect(
      browserStage({
        status: browserStatus({ state: "locked" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({
      kind: "locked",
      message:
        "Brave's profile is in use by another window. Close it on the laptop, then take control to retry.",
    });
  });

  it("shows the crash detail, or says Brave stopped when there is none", () => {
    expect(
      browserStage({
        status: browserStatus({ state: "crashed", detail: "GPU process died" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({
      kind: "crashed",
      message: "GPU process died Take control to restart it.",
    });
    expect(
      browserStage({
        status: browserStatus({ state: "crashed" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({
      kind: "crashed",
      message: "Brave stopped. Take control to restart it.",
    });
  });

  it("offers to open the browser when it is not running", () => {
    expect(
      browserStage({
        status: browserStatus({ state: "offline" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({
      kind: "idle",
      message:
        "The browser is not running. It starts when a bot needs it, or when you take control.",
      canOpen: true,
    });
  });

  it("is live for a connected page and for a login wait", () => {
    expect(browserStage({ status: browserStatus(), reachable: true, loading: false })).toEqual({
      kind: "live",
    });
    expect(
      browserStage({
        status: browserStatus({ state: "waiting_for_login" }),
        reachable: true,
        loading: false,
      }),
    ).toEqual({ kind: "live" });
  });
});

describe("computerHeader", () => {
  const base = {
    shown: "browser" as const,
    reachable: true,
    loading: false,
    status: browserStatus(),
    desktop: desktopStatus(),
    browserDriver: nobody,
    desktopDriver: driver("desktop", "none"),
    youControl: false,
    otherDevice: false,
  };

  it("is Laptop offline before anything else", () => {
    expect(computerHeader({ ...base, reachable: false, youControl: true })).toEqual({
      text: "Laptop offline",
      tone: "idle",
    });
  });

  it("names the bot using the shown source", () => {
    expect(computerHeader({ ...base, browserDriver: adaUsingBrowser })).toEqual({
      text: "Ada is using Brave",
      tone: "live",
    });
    expect(
      computerHeader({
        ...base,
        shown: "desktop",
        browserDriver: adaUsingBrowser,
        desktopDriver: driver("desktop", "using", { botName: "Ada" }),
      }),
    ).toEqual({ text: "Ada is using the desktop", tone: "live" });
  });

  it("puts your control and another device's control ahead of the driver", () => {
    expect(computerHeader({ ...base, youControl: true })).toEqual({
      text: "You're in control",
      tone: "control",
    });
    expect(computerHeader({ ...base, otherDevice: true })).toEqual({
      text: "You're controlling it from another device",
      tone: "control",
    });
  });

  it("reports starting, crashed and locked browser states", () => {
    expect(computerHeader({ ...base, status: browserStatus({ state: "starting" }) })).toEqual({
      text: "Starting Brave…",
      tone: "pending",
    });
    expect(computerHeader({ ...base, status: browserStatus({ state: "crashed" }) })).toEqual({
      text: "Brave crashed",
      tone: "problem",
    });
    expect(computerHeader({ ...base, status: browserStatus({ state: "locked" }) })).toEqual({
      text: "Brave profile locked",
      tone: "problem",
    });
  });

  it("asks for help before it names the driver", () => {
    expect(
      computerHeader({
        ...base,
        status: browserStatus({
          helpRequest: {
            threadId: thread,
            botId: bot,
            botName: "Ada",
            reason: "A CAPTCHA is blocking the page.",
            requestedAt: "2026-11-06T10:00:00.000Z",
          },
        }),
        browserDriver: adaUsingBrowser,
      }),
    ).toEqual({ text: "Ada needs your help", tone: "review" });
  });
});

describe("computerDotTone", () => {
  it("mirrors the browser's own state", () => {
    expect(computerDotTone({ reachable: false, status: browserStatus(), loading: false })).toBe(
      "idle",
    );
    expect(computerDotTone({ reachable: true, status: null, loading: true })).toBe("pending");
    expect(
      computerDotTone({
        reachable: true,
        status: browserStatus({ state: "crashed" }),
        loading: false,
      }),
    ).toBe("problem");
    expect(computerDotTone({ reachable: true, status: browserStatus(), loading: false })).toBe(
      "live",
    );
  });
});

describe("browserToolbar", () => {
  it("shows the page title, its secure scheme and every page action", () => {
    expect(
      browserToolbar({
        status: browserStatus({
          page: { url: "https://example.com/a", title: "Example" },
        }),
        ready: true,
        inControl: true,
        reachable: true,
      }),
    ).toEqual({
      address: "https://example.com/a",
      addressLabel: "Example",
      secure: true,
      editable: true,
      canReload: true,
      canClose: true,
      canForward: true,
      canEscape: true,
    });
  });

  it("keeps the address read-only without control or a socket", () => {
    const status = browserStatus({
      page: { url: "https://example.com/a", title: "Example" },
    });
    expect(
      browserToolbar({ status, ready: false, inControl: true, reachable: true }),
    ).toMatchObject({ editable: false, canReload: false, canForward: false, canEscape: false });
    expect(
      browserToolbar({ status, ready: true, inControl: false, reachable: true }),
    ).toMatchObject({ editable: false, canReload: true });
  });

  it("falls back to the host, and refuses a scheme that is not http", () => {
    expect(
      browserToolbar({
        status: browserStatus({ page: { url: "https://news.example.com/x", title: "  " } }),
        ready: true,
        inControl: false,
        reachable: true,
      }),
    ).toMatchObject({ address: "https://news.example.com/x", addressLabel: "news.example.com" });
    expect(
      browserToolbar({
        status: browserStatus({ page: { url: "chrome-error://chromewebdata/", title: "Oops" } }),
        ready: true,
        inControl: false,
        reachable: true,
      }),
    ).toMatchObject({
      address: "",
      addressLabel: "This page didn't load",
      secure: false,
      canReload: true,
    });
  });

  it("has nothing to act on without a page", () => {
    expect(
      browserToolbar({
        status: browserStatus(),
        ready: true,
        inControl: true,
        reachable: true,
      }),
    ).toEqual({
      address: "",
      addressLabel: "No page open",
      secure: false,
      editable: true,
      canReload: false,
      canClose: true,
      canForward: false,
      canEscape: false,
    });
  });

  it("cannot close a browser on an unreachable laptop", () => {
    expect(
      browserToolbar({
        status: browserStatus(),
        ready: true,
        inControl: false,
        reachable: false,
      }).canClose,
    ).toBe(false);
  });
});

describe("pageAddressLabel", () => {
  it("says what happened instead of showing an internal error URL", () => {
    expect(pageAddressLabel(null)).toBe("No page open");
    expect(
      pageAddressLabel(browserStatus({ page: { url: "chrome-error://x", title: "Error" } })),
    ).toBe("This page didn't load");
  });
});

describe("computerActions", () => {
  const base = {
    shown: "browser" as const,
    reachable: true,
    status: browserStatus(),
    desktop: desktopStatus(),
    driver: driver("browser", "idle", { botName: "Ada", threadId: "thread-1" }),
    youShown: false,
    taking: false,
    helpOpen: false,
  };

  it("offers Take control and the close label for an idle browser", () => {
    expect(computerActions(base)).toEqual({
      canTake: true,
      takeDisabled: false,
      canHandBack: false,
      stopLabel: "Close browser",
      canStop: true,
    });
  });

  it("offers Hand back and no stop while you hold control", () => {
    expect(computerActions({ ...base, youShown: true, driver: driver("browser", "you") })).toEqual({
      canTake: false,
      takeDisabled: false,
      canHandBack: true,
      stopLabel: null,
      canStop: false,
    });
  });

  it("names the bot a stop would stop", () => {
    expect(computerActions({ ...base, driver: adaUsingBrowser })).toMatchObject({
      canStop: true,
      stopLabel: "Stop Ada",
    });
  });

  it("disables Take control while a take is in flight or the laptop is offline", () => {
    expect(computerActions({ ...base, taking: true })).toMatchObject({
      canTake: false,
      takeDisabled: true,
    });
    expect(computerActions({ ...base, reachable: false })).toMatchObject({
      takeDisabled: true,
    });
    expect(computerActions({ ...base, status: null })).toMatchObject({ takeDisabled: true });
  });

  it("disables Take control on the desktop when the server cannot drive one", () => {
    expect(
      computerActions({
        ...base,
        shown: "desktop",
        driver: driver("desktop", "none"),
        desktop: desktopStatus({ available: false }),
      }),
    ).toMatchObject({ takeDisabled: true, canStop: false, stopLabel: null });
  });
});

describe("desktopQueue", () => {
  it("puts the paused driver first and the waiting bots in line", () => {
    const queue = desktopQueue({
      browser: browserStatus({
        waiting: [{ threadId: "thread-2", botId: "bot-bea", botName: "Bea" }],
      }),
      desktop: desktopStatus({
        waiting: [{ threadId: "thread-3", botId: "bot-cle", botName: "Cle" }],
      }),
      paused: adaUsingBrowser,
    });
    expect(queue.paused).toEqual({
      threadId: "thread-1",
      botId: "bot-ada",
      botName: "Ada",
      source: "browser",
    });
    expect(queue.next).toEqual([
      { threadId: "thread-3", botId: "bot-cle", botName: "Cle", source: "desktop" },
      { threadId: "thread-2", botId: "bot-bea", botName: "Bea", source: "browser" },
    ]);
  });
});

describe("liveViewMode", () => {
  it("is live only with a reachable viewport", () => {
    expect(liveViewMode({ status: browserStatus(), reachable: true })).toBe("live");
    expect(
      liveViewMode({ status: browserStatus({ state: "waiting_for_login" }), reachable: true }),
    ).toBe("live");
    expect(liveViewMode({ status: browserStatus({ state: "starting" }), reachable: true })).toBe(
      "placeholder",
    );
    expect(liveViewMode({ status: browserStatus(), reachable: false })).toBe("placeholder");
  });
});

describe("activeEgressPause", () => {
  const pause: PersonalBrowserStatus["egressPause"] = {
    threadId: thread,
    botId: bot,
    botName: "Ada",
    sources: ["Gmail"],
    destination: "slack.com",
    requestedAt: "2026-11-06T10:00:00.000Z",
  };

  it("shows the pause for its own thread", () => {
    expect(activeEgressPause(browserStatus({ egressPause: pause }))).toEqual({
      threadId: "thread-1",
      botId: "bot-ada",
      botName: "Ada",
      sources: "Gmail",
      destination: "slack.com",
      requestedAt: "2026-11-06T10:00:00.000Z",
    });
  });

  it("hides it while another thread's help card is active", () => {
    expect(
      activeEgressPause(
        browserStatus({
          egressPause: pause,
          helpRequest: {
            threadId: otherThread,
            botId: bot,
            botName: "Bea",
            reason: "A CAPTCHA is blocking the page.",
            requestedAt: "2026-11-06T10:00:00.000Z",
          },
        }),
      ),
    ).toBeNull();
  });

  it("shows a sensitive help request as the pause when the server sends no pause", () => {
    expect(
      activeEgressPause(
        browserStatus({
          helpRequest: {
            threadId: thread,
            botId: bot,
            botName: "Ada",
            reason: "Sensitive site",
            requestedAt: "2026-11-06T10:00:00.000Z",
            kind: "sensitive",
            sources: ["Chase"],
            destination: "example.com",
          },
        }),
      ),
    ).toMatchObject({ sources: "Chase", destination: "example.com" });
  });

  it("is null when nothing is paused", () => {
    expect(activeEgressPause(browserStatus())).toBeNull();
    expect(activeEgressPause(null)).toBeNull();
  });
});

describe("activity helpers", () => {
  const browser = event({ id: "browser-1" });
  const desktop = event({ id: "desktop-1", source: "desktop", summary: "Clicked Save" });

  it("splits the two timelines", () => {
    expect(browserEvents([browser, desktop]).map((row) => row.id)).toEqual(["browser-1"]);
    expect(desktopEvents([browser, desktop]).map((row) => row.id)).toEqual(["desktop-1"]);
  });

  it("names the activity sheet the way the web does", () => {
    expect(activitySheetTitle()).toEqual({
      title: "Recent activity",
      subtitle: "Browser and desktop, newest first",
    });
  });

  it("formats a file row with its size and kind", () => {
    const file: PersonalBrowserFile = {
      id: "file-1",
      name: "shot.png",
      kind: "screenshot",
      sizeBytes: 1536,
      modifiedAt: "2026-11-06T10:00:00.000Z",
    };
    expect(formatFileRow(file)).toEqual({
      title: "shot.png",
      detail: "2 KB · screenshot",
    });
  });
});
