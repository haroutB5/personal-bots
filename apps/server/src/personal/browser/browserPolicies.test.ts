import { describe, expect, it } from "@effect/vitest";

import {
  helpEndsOnAgentSwitch,
  latestOpenTab,
  resolveTabForRequest,
  tabsInCookieScope,
} from "./browserTabPolicy.ts";
import { stepControlWatch, stepIdleTicks, type ControlWatchState } from "./browserControlPolicy.ts";

interface Page {
  readonly url: string;
  readonly open: boolean;
}
interface Tab {
  readonly tabId: string;
  readonly threadId: string;
  readonly page: Page;
}
const page = (url: string, open = true): Page => ({ url, open });
const tab = (tabId: string, threadId: string, p: Page = page("https://a.example/")): Tab => ({
  tabId,
  threadId,
  page: p,
});
const isOpen = (p: Page) => p.open;

describe("tab policy", () => {
  it("picks the newest open tab a thread has", () => {
    const tabs = [tab("1", "t1"), tab("2", "t2"), tab("3", "t1"), tab("4", "t1", page("x", false))];
    expect(latestOpenTab(tabs, "t1", isOpen)?.tabId).toBe("3");
    expect(latestOpenTab(tabs, "t2", isOpen)?.tabId).toBe("2");
    expect(latestOpenTab(tabs, "nobody", isOpen)).toBeUndefined();
    expect(latestOpenTab([], "t1", isOpen)).toBeUndefined();
  });

  describe("resolveTabForRequest", () => {
    const tabs = [tab("1", "t1"), tab("2", "t2"), tab("3", "t1", page("gone", false))];
    const byId = new Map(tabs.map((entry) => [entry.tabId, entry]));
    const resolve = (request: { tabId?: string; tabIdExplicit?: boolean; threadId: string }) =>
      resolveTabForRequest({ tabsById: byId, request, isOpen })?.tabId;

    it("uses the named tab when it is the caller's and open", () => {
      expect(resolve({ tabId: "1", tabIdExplicit: true, threadId: "t1" })).toBe("1");
    });
    it("never hands out another thread's tab", () => {
      expect(resolve({ tabId: "2", tabIdExplicit: true, threadId: "t1" })).toBeUndefined();
      // An inherited id falls back to the caller's own newest tab.
      expect(resolve({ tabId: "2", threadId: "t1" })).toBe("1");
    });
    it("an explicit tab that is gone stays an error; an inherited one falls back", () => {
      expect(resolve({ tabId: "3", tabIdExplicit: true, threadId: "t1" })).toBeUndefined();
      expect(resolve({ tabId: "3", threadId: "t1" })).toBe("1");
      expect(resolve({ tabId: "99", threadId: "t1" })).toBe("1");
    });
    it("with no id, the thread's newest open tab", () => {
      expect(resolve({ threadId: "t2" })).toBe("2");
      expect(resolve({ threadId: "none" })).toBeUndefined();
    });
  });

  it("closes every other tab that can see the login's cookies, of any thread", () => {
    const keep = tab("keep", "t1", page("https://bank.example/login"));
    const tabs = [
      keep,
      tab("same", "t2", page("https://bank.example/accounts")),
      tab("sub", "t3", page("https://app.bank.example/")),
      tab("other", "t1", page("https://news.example/")),
      tab("blank", "t1", page("about:blank")),
      tab("closed", "t1", page("https://bank.example/old", false)),
    ];
    const doomed = tabsInCookieScope({
      tabs,
      except: keep,
      isOpen,
      urlOf: (p) => p.url,
      covers: (url) => url.includes("bank.example"),
    });
    expect(doomed.map((entry) => entry.tabId)).toEqual(["same", "sub"]);
  });

  it("a help request ends only when a different chat takes the browser", () => {
    expect(helpEndsOnAgentSwitch(null, "t1")).toBe(false);
    expect(helpEndsOnAgentSwitch("t1", "t1")).toBe(false);
    expect(helpEndsOnAgentSwitch("t1", "t2")).toBe(true);
  });
});

describe("control watch", () => {
  const fresh: ControlWatchState = { viewerSeen: false, absentSince: null };
  const step = (overrides: Partial<Parameters<typeof stepControlWatch>[0]> = {}) =>
    stepControlWatch({
      graceMs: 60_000,
      ownerType: "human",
      ownerId: "phone",
      viewerSessionIds: [],
      helpOpen: false,
      state: { viewerSeen: true, absentSince: null },
      now: () => 100_000,
      ...overrides,
    });

  it("does nothing when nobody human holds control, or the grace is off", () => {
    expect(step({ ownerType: "agent" })).toEqual({
      state: { viewerSeen: true, absentSince: null },
      action: "none",
    });
    expect(step({ ownerId: null }).action).toBe("none");
    expect(
      step({ graceMs: 0, state: { viewerSeen: true, absentSince: 5 } }).state.absentSince,
    ).toBeNull();
  });

  it("sees the controlling device's live view and resets the absence", () => {
    const out = step({
      viewerSessionIds: ["other", "phone"],
      state: { viewerSeen: false, absentSince: 5 },
    });
    expect(out).toEqual({ state: { viewerSeen: true, absentSince: null }, action: "none" });
  });

  it("never hands back a device that never opened a live view, or while help is open", () => {
    expect(step({ state: { viewerSeen: false, absentSince: 5 } })).toEqual({
      state: { viewerSeen: false, absentSince: null },
      action: "none",
    });
    expect(
      step({ helpOpen: true, state: { viewerSeen: true, absentSince: 5 } }).state.absentSince,
    ).toBeNull();
  });

  it("starts the absence clock, then hands back after the grace", () => {
    const first = step();
    expect(first).toEqual({ state: { viewerSeen: true, absentSince: 100_000 }, action: "none" });
    const justBefore = step({ state: first.state, now: () => 159_999 });
    expect(justBefore.action).toBe("none");
    const due = step({ state: first.state, now: () => 160_000 });
    expect(due).toEqual({
      state: { viewerSeen: true, absentSince: 100_000 },
      action: "hand_back",
      absentMs: 60_000,
    });
  });

  it("reads the clock only once it gets that far", () => {
    let reads = 0;
    step({ ownerType: "agent", now: () => ++reads });
    step({ state: fresh, now: () => ++reads });
    expect(reads).toBe(0);
    step({ now: () => ++reads });
    expect(reads).toBe(1);
  });
});

describe("idle ticks", () => {
  it("closes after enough idle checks in a row, and any use starts over", () => {
    let ticks = 0;
    const run = (inUse: boolean, connected = true) => {
      const out = stepIdleTicks({ connected, inUse, ticks, closeAfterTicks: 3 });
      ticks = out.ticks;
      return out.close;
    };
    expect([run(false), run(false)]).toEqual([false, false]);
    expect(run(true)).toBe(false);
    expect(ticks).toBe(0);
    expect([run(false), run(false), run(false)]).toEqual([false, false, true]);
    expect(ticks).toBe(0);
    expect(run(false, false)).toBe(false);
  });
});
