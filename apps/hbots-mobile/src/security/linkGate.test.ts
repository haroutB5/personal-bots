import { describe, expect, it, vi } from "vite-plus/test";

import { parseDeepLink } from "../nav/routes";
import { createLinkGate, HELD_LINK_TTL_MS } from "./linkGate";

/** The real links each entry point sends, with the screen each one opens. */
const ENTRY_POINTS = [
  { name: "bot new-chat link", link: "hbots://bot/1c3b7c87?new=1", opens: "botNewChat" },
  { name: "Quick Settings tile", link: "hbots://bot/cto?new=1", opens: "botNewChat" },
  { name: "launcher shortcut", link: "hbots://bot/cto?new=1", opens: "botNewChat" },
  { name: "stop link", link: "hbots://stop", opens: "stop" },
  { name: "share sheet", link: "hbots://share/abc123", opens: "share" },
  { name: "Ask hbots text selection", link: "hbots://share/def456", opens: "share" },
  { name: "notification tap", link: "hbots://chat/bot-1/t1", opens: "chat" },
] as const;

describe("entry points are the links the gate holds", () => {
  it.each(ENTRY_POINTS)("$name opens the $opens screen", ({ link, opens }) => {
    const stack = parseDeepLink(link)?.stack ?? [];
    expect(stack.at(-1)?.kind).toBe(opens);
  });
});

describe("link gate", () => {
  it.each(ENTRY_POINTS)("does nothing for a $name while locked", ({ link }) => {
    const act = vi.fn();
    const gate = createLinkGate(act);
    gate.setCovered(true);

    gate.receive(link);

    expect(act).not.toHaveBeenCalled();
    expect(gate.held()).toBe(link);
  });

  it.each(ENTRY_POINTS)("acts on a $name once, after the unlock", ({ link }) => {
    const act = vi.fn();
    const gate = createLinkGate(act);
    gate.setCovered(true);
    gate.receive(link);

    gate.setCovered(false);
    gate.setCovered(false);

    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith(link);
    expect(gate.held()).toBeNull();
  });

  it("holds links that arrive before the lock setting is read", () => {
    const act = vi.fn();
    const gate = createLinkGate(act);

    gate.receive("hbots://bot/cto?new=1");

    expect(act).not.toHaveBeenCalled();
  });

  it("acts at once when the lock is off", () => {
    const act = vi.fn();
    const gate = createLinkGate(act);
    gate.setCovered(false);

    gate.receive("hbots://bot/cto?new=1");

    expect(act).toHaveBeenCalledTimes(1);
  });

  it("keeps only the newest link, so two taps make one chat", () => {
    const act = vi.fn();
    const gate = createLinkGate(act);
    gate.setCovered(true);
    gate.receive("hbots://bot/cto?new=1");
    gate.receive("hbots://bot/cto?new=1");
    gate.receive("hbots://stop");

    gate.setCovered(false);

    expect(act).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith("hbots://stop");
  });

  it("drops a link that waited too long for the unlock", () => {
    let now = 0;
    const act = vi.fn();
    const gate = createLinkGate(act, () => now);
    gate.setCovered(true);
    gate.receive("hbots://bot/cto?new=1");

    now += HELD_LINK_TTL_MS + 1;
    gate.setCovered(false);

    expect(act).not.toHaveBeenCalled();
  });

  it("does not replay a released link when the app locks and unlocks again", () => {
    const act = vi.fn();
    const gate = createLinkGate(act);
    gate.setCovered(true);
    gate.receive("hbots://bot/cto?new=1");
    gate.setCovered(false);
    gate.setCovered(true);
    gate.setCovered(false);

    expect(act).toHaveBeenCalledTimes(1);
  });
});

describe("a held link that is never acted on", () => {
  const SHARE = "hbots://share/abc12345";

  it("is dropped when a newer link replaces it", () => {
    const drop = vi.fn();
    const gate = createLinkGate(vi.fn(), Date.now, HELD_LINK_TTL_MS, drop);
    gate.setCovered(true);
    gate.receive(SHARE);
    gate.receive("hbots://bot/cto?new=1");

    expect(drop).toHaveBeenCalledExactlyOnceWith(SHARE);
  });

  it("is dropped when it expired before the unlock", () => {
    let clock = 0;
    const drop = vi.fn();
    const act = vi.fn();
    const gate = createLinkGate(act, () => clock, HELD_LINK_TTL_MS, drop);
    gate.setCovered(true);
    gate.receive(SHARE);
    clock = HELD_LINK_TTL_MS + 1;
    gate.setCovered(false);

    expect(act).not.toHaveBeenCalled();
    expect(drop).toHaveBeenCalledExactlyOnceWith(SHARE);
  });

  it("is dropped when the app goes away while it waits", () => {
    const drop = vi.fn();
    const gate = createLinkGate(vi.fn(), Date.now, HELD_LINK_TTL_MS, drop);
    gate.setCovered(true);
    gate.receive(SHARE);
    gate.dispose();

    expect(drop).toHaveBeenCalledExactlyOnceWith(SHARE);
    expect(gate.held()).toBeNull();
  });

  it("is not dropped when it was acted on", () => {
    const drop = vi.fn();
    const gate = createLinkGate(vi.fn(), Date.now, HELD_LINK_TTL_MS, drop);
    gate.setCovered(true);
    gate.receive(SHARE);
    gate.setCovered(false);
    gate.dispose();

    expect(drop).not.toHaveBeenCalled();
  });
});

describe("the owner of the gate re-renders", () => {
  it("acts with the latest handler, not the first", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const gate = createLinkGate(first);
    gate.setCovered(true);
    gate.receive("hbots://stop");
    gate.setAct(latest);
    gate.setCovered(false);

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledExactlyOnceWith("hbots://stop");
  });
});
