import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyFrozenChipOrder,
  clearChipFreeze,
  enterBotChats,
  readChipFreeze,
  rememberChipFreeze,
  RESORT_AFTER_HIDDEN_MS,
  shouldResortOnResume,
  useFrozenChipOrder,
  watchResumeAfterHidden,
} from "./chatChipOrder";
import type { ChatChip } from "./chatChipRows";

const chip = (threadId: string, pinned = false, current = false): ChatChip => ({
  threadId,
  text: `Chat ${threadId}`,
  kind: "chat",
  current,
  state: "idle",
  unread: false,
  pinned,
  label: `Chat ${threadId}`,
});
const ids = (chips: ReadonlyArray<ChatChip>) => chips.map((entry) => entry.threadId);

describe("applyFrozenChipOrder", () => {
  it("takes the fresh order and freezes it the first time", () => {
    const fresh = [chip("a"), chip("b"), chip("c")];
    const { chips, next } = applyFrozenChipOrder(fresh, null);
    expect(ids(chips)).toEqual(["a", "b", "c"]);
    expect(next.ids).toEqual(["a", "b", "c"]);
    expect(next.pinned.get("b")).toBe(false);
  });

  it("keeps the frozen order when the fresh order changes under it (a chat got a new message)", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], null);
    // c was messaged: a fresh sort puts it first.
    const again = applyFrozenChipOrder([chip("c"), chip("a"), chip("b")], next);
    expect(ids(again.chips)).toEqual(["a", "b", "c"]);
    expect(again.next.ids).toEqual(["a", "b", "c"]);
  });

  it("never moves the open chat when its own message makes it the newest", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b"), chip("c", false, true)], null);
    const again = applyFrozenChipOrder([chip("c", false, true), chip("a"), chip("b")], next);
    expect(ids(again.chips)).toEqual(["a", "b", "c"]);
  });

  it("puts a new chat where a fresh sort puts it: just before the first known chip after it", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], null);
    // "+": the new chat is the newest, so fresh has it first.
    const first = applyFrozenChipOrder([chip("n"), chip("c"), chip("a"), chip("b")], next);
    expect(ids(first.chips)).toEqual(["n", "a", "b", "c"]);
    // A new chat that sorts in the middle of the fresh order goes before the first known chip after it.
    const middle = applyFrozenChipOrder([chip("c"), chip("a"), chip("n"), chip("b")], next);
    expect(ids(middle.chips)).toEqual(["a", "n", "b", "c"]);
  });

  it("puts a new chat first among the unpinned chats, below the pinned ones", () => {
    const { next } = applyFrozenChipOrder([chip("p", true), chip("a"), chip("b")], null);
    const again = applyFrozenChipOrder([chip("p", true), chip("n"), chip("b"), chip("a")], next);
    expect(ids(again.chips)).toEqual(["p", "n", "a", "b"]);
  });

  it("puts a newly pinned chat first among the pinned chats when none is newer", () => {
    const { next } = applyFrozenChipOrder([chip("p", true), chip("a"), chip("b")], null);
    // Pin b, and b is newer than p.
    const again = applyFrozenChipOrder([chip("b", true), chip("p", true), chip("a")], next);
    expect(ids(again.chips)).toEqual(["b", "p", "a"]);
    // Pin a, older than p: it follows p.
    const older = applyFrozenChipOrder([chip("p", true), chip("a", true), chip("b")], next);
    expect(ids(older.chips)).toEqual(["p", "a", "b"]);
  });

  it("puts a newcomer last when no known chip follows it", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b")], null);
    const again = applyFrozenChipOrder([chip("a"), chip("b"), chip("old")], next);
    expect(ids(again.chips)).toEqual(["a", "b", "old"]);
  });

  it("keeps several newcomers in their fresh order at the same spot", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b")], null);
    const again = applyFrozenChipOrder([chip("n1"), chip("n2"), chip("b"), chip("a")], next);
    expect(ids(again.chips)).toEqual(["n1", "n2", "a", "b"]);
  });

  it("closes the gap when a chat leaves (archived, snoozed or deleted)", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], null);
    const again = applyFrozenChipOrder([chip("a"), chip("c")], next);
    expect(ids(again.chips)).toEqual(["a", "c"]);
    expect(again.next.ids).toEqual(["a", "c"]);
  });

  it("puts a woken snooze at its recency spot, not where it left", () => {
    const { next } = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], null);
    const asleep = applyFrozenChipOrder([chip("a"), chip("c")], next);
    // b wakes with a new message and sorts first in the fresh order.
    const woken = applyFrozenChipOrder([chip("b"), chip("a"), chip("c")], asleep.next);
    expect(ids(woken.chips)).toEqual(["b", "a", "c"]);
  });

  it("moves a chip into the pinned group when it is pinned, and back out when it is unpinned", () => {
    const start = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], null);
    // Pin c: fresh is pinned first.
    const pinned = applyFrozenChipOrder([chip("c", true), chip("a"), chip("b")], start.next);
    expect(ids(pinned.chips)).toEqual(["c", "a", "b"]);
    expect(pinned.next.pinned.get("c")).toBe(true);
    // Other chips keep their frozen place while one of them is messaged.
    const messaged = applyFrozenChipOrder([chip("c", true), chip("b"), chip("a")], pinned.next);
    expect(ids(messaged.chips)).toEqual(["c", "a", "b"]);
    // Unpin c: it is unknown again and goes where the fresh sort puts it (last here).
    const unpinned = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], messaged.next);
    expect(ids(unpinned.chips)).toEqual(["a", "b", "c"]);
    expect(unpinned.next.pinned.get("c")).toBe(false);
  });

  it("keeps pinned chips ahead of the rest whatever the freeze remembers", () => {
    const start = applyFrozenChipOrder(
      [chip("p1", true), chip("p2", true), chip("a"), chip("b")],
      null,
    );
    // Pin b and unpin p1 at once; a is messaged.
    const fresh = [chip("b", true), chip("p2", true), chip("a"), chip("p1")];
    const { chips } = applyFrozenChipOrder(fresh, start.next);
    const pinnedFlags = chips.map((entry) => entry.pinned);
    expect(pinnedFlags).toEqual([...pinnedFlags].sort((x, y) => Number(y) - Number(x)));
    expect(new Set(ids(chips))).toEqual(new Set(["b", "p2", "a", "p1"]));
  });

  it("is a fixed point: applying the result again changes nothing", () => {
    const start = applyFrozenChipOrder([chip("a"), chip("b"), chip("c")], null);
    const first = applyFrozenChipOrder([chip("c"), chip("n"), chip("a"), chip("b")], start.next);
    const second = applyFrozenChipOrder([chip("c"), chip("n"), chip("a"), chip("b")], first.next);
    expect(ids(second.chips)).toEqual(ids(first.chips));
  });
});

describe("the freeze, kept per bot", () => {
  beforeEach(() => clearChipFreeze());

  it("is kept through a chat switch, whichever order the old screen leaves and the new one enters", async () => {
    rememberChipFreeze("bot-1", applyFrozenChipOrder([chip("a")], null).next);
    // The old screen's cleanup runs first, then the new screen's setup, in one commit.
    const first = enterBotChats("bot-1");
    first();
    const second = enterBotChats("bot-1");
    await Promise.resolve();
    expect(readChipFreeze("bot-1")).not.toBeNull();
    // Or the new one is already counted before the old one leaves.
    const third = enterBotChats("bot-1");
    second();
    await Promise.resolve();
    expect(readChipFreeze("bot-1")).not.toBeNull();
    third();
    await Promise.resolve();
    expect(readChipFreeze("bot-1")).toBeNull();
  });

  it("clears the freeze of the bot that was left, and only that bot", async () => {
    const freeze = applyFrozenChipOrder([chip("a")], null).next;
    rememberChipFreeze("bot-1", freeze);
    rememberChipFreeze("bot-2", freeze);
    const leave1 = enterBotChats("bot-1");
    const leave2 = enterBotChats("bot-2");
    leave1();
    await Promise.resolve();
    expect(readChipFreeze("bot-1")).toBeNull();
    expect(readChipFreeze("bot-2")).not.toBeNull();
    leave2();
    await Promise.resolve();
    expect(readChipFreeze("bot-2")).toBeNull();
  });

  it("a second leave of the same entry does nothing", async () => {
    rememberChipFreeze("bot-1", applyFrozenChipOrder([chip("a")], null).next);
    const leave = enterBotChats("bot-1");
    const stay = enterBotChats("bot-1");
    leave();
    leave();
    await Promise.resolve();
    expect(readChipFreeze("bot-1")).not.toBeNull();
    stay();
  });
});

describe("the 60 second return", () => {
  it("re-sorts at 60 s or more hidden, not under", () => {
    expect(RESORT_AFTER_HIDDEN_MS).toBe(60_000);
    expect(shouldResortOnResume(1_000, 1_000 + 59_999)).toBe(false);
    expect(shouldResortOnResume(1_000, 1_000 + 60_000)).toBe(true);
    expect(shouldResortOnResume(1_000, 1_000 + 3_600_000)).toBe(true);
    expect(shouldResortOnResume(null, 99_999_999)).toBe(false);
  });

  describe("watching the page", () => {
    let visibility: "visible" | "hidden";
    const listeners = new Set<() => void>();
    let clock = 0;
    beforeEach(() => {
      visibility = "visible";
      listeners.clear();
      clock = 1_000_000;
      vi.stubGlobal("document", {
        get visibilityState() {
          return visibility;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      });
    });
    afterEach(() => vi.unstubAllGlobals());
    const change = (next: "visible" | "hidden", advanceMs: number) => {
      clock += advanceMs;
      visibility = next;
      for (const listener of [...listeners]) listener();
    };

    it("fires only when the page shows again after a minute or more", () => {
      const onResort = vi.fn();
      const stop = watchResumeAfterHidden(onResort, () => clock);
      change("hidden", 0);
      change("visible", 59_000);
      expect(onResort).not.toHaveBeenCalled();
      change("hidden", 5_000);
      change("visible", 60_000);
      expect(onResort).toHaveBeenCalledTimes(1);
      // A second visible event without hiding in between does nothing.
      change("visible", 120_000);
      expect(onResort).toHaveBeenCalledTimes(1);
      stop();
      change("hidden", 0);
      change("visible", 120_000);
      expect(onResort).toHaveBeenCalledTimes(1);
    });

    it("counts from the first hidden event, not the last", () => {
      const onResort = vi.fn();
      watchResumeAfterHidden(onResort, () => clock);
      change("hidden", 0);
      change("hidden", 40_000);
      change("visible", 30_000);
      expect(onResort).toHaveBeenCalledTimes(1);
    });
  });
});

describe("useFrozenChipOrder", () => {
  let renderer: ReactTestRenderer | undefined;
  let visibility: "visible" | "hidden";
  const listeners = new Set<() => void>();
  let result: { chips: ReadonlyArray<ChatChip> | null; resortEpoch: number } | null = null;

  function Probe({ botId, chips }: { botId: string; chips: ReadonlyArray<ChatChip> | null }) {
    result = useFrozenChipOrder(botId, chips);
    return null;
  }
  async function show(botId: string, chips: ReadonlyArray<ChatChip> | null) {
    await act(async () => {
      if (renderer === undefined) renderer = create(<Probe botId={botId} chips={chips} />);
      else renderer.update(<Probe botId={botId} chips={chips} />);
    });
  }
  const resultIds = () => ids(result!.chips ?? []);

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    visibility = "visible";
    listeners.clear();
    clearChipFreeze();
    vi.stubGlobal("document", {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    });
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    result = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("holds the order while the screen stays, and takes a fresh one on the next entry", async () => {
    await show("bot-1", [chip("a"), chip("b"), chip("c")]);
    expect(resultIds()).toEqual(["a", "b", "c"]);
    // c is messaged and a new chat appears while he stays: nothing moves.
    await show("bot-1", [chip("n"), chip("c"), chip("a"), chip("b")]);
    expect(resultIds()).toEqual(["n", "a", "b", "c"]);
    await show("bot-1", [chip("c"), chip("n"), chip("a"), chip("b")]);
    expect(resultIds()).toEqual(["n", "a", "b", "c"]);

    // Back to Bots, then into the bot again: re-sorted.
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await Promise.resolve();
    expect(readChipFreeze("bot-1")).toBeNull();
    await show("bot-1", [chip("c"), chip("n"), chip("a"), chip("b")]);
    expect(resultIds()).toEqual(["c", "n", "a", "b"]);
  });

  it("re-sorts when the app returns after 60 s, and says so for centring; not under 60 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    await show("bot-1", [chip("a"), chip("b")]);
    const epoch = result!.resortEpoch;
    const reordered = [chip("b"), chip("a")];
    await show("bot-1", reordered);
    expect(resultIds()).toEqual(["a", "b"]);

    visibility = "hidden";
    await act(async () => {
      for (const listener of [...listeners]) listener();
    });
    vi.setSystemTime(10_000_000 + 59_000);
    visibility = "visible";
    await act(async () => {
      for (const listener of [...listeners]) listener();
    });
    expect(resultIds()).toEqual(["a", "b"]);
    expect(result!.resortEpoch).toBe(epoch);

    visibility = "hidden";
    await act(async () => {
      for (const listener of [...listeners]) listener();
    });
    vi.setSystemTime(10_000_000 + 59_000 + 61_000);
    visibility = "visible";
    await act(async () => {
      for (const listener of [...listeners]) listener();
    });
    expect(resultIds()).toEqual(["b", "a"]);
    expect(result!.resortEpoch).toBe(epoch + 1);
  });

  it("keeps one bot's order apart from another's", async () => {
    await show("bot-1", [chip("a"), chip("b")]);
    await show("bot-2", [chip("x"), chip("y")]);
    await show("bot-2", [chip("y"), chip("x")]);
    expect(resultIds()).toEqual(["x", "y"]);
    expect(readChipFreeze("bot-1")).toBeNull();
  });

  it("returns null until the chips are known", async () => {
    await show("bot-1", null);
    expect(result!.chips).toBeNull();
  });
});
