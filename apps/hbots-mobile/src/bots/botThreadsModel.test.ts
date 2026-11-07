import { PersonalBotId, type PersonalBot } from "@t3tools/contracts";
import type { BotThreadRow } from "@hbots/personal-client/feed/botThreadRows";
import { NO_CHAT_SEEN } from "@hbots/personal-client/bots/unreadChats";
import { describe, expect, it } from "vite-plus/test";

import {
  activeEmptyText,
  archivedChatCount,
  archivedHeading,
  archivedLoad,
  bulkBarButtons,
  listMenuItems,
  newestRow,
  rowStatus,
  rowSwipeSpec,
  selectionAfterBulk,
  selectionView,
  snoozedHeading,
  startSelection,
  threadsScreenState,
  toggleAllThreads,
  toggleThread,
  turnsBaselineStep,
  turnsSettledKey,
  unreadThreadIds,
  wakeStep,
  workingCount,
  wrapupDisabled,
} from "./botThreadsModel";

interface RowSpec {
  readonly id: string;
  readonly pinned?: boolean;
  readonly running?: boolean;
  readonly approvals?: boolean;
  readonly updatedMs?: number;
  readonly unread?: boolean;
  readonly completedAt?: string;
}

const rowOf = (spec: RowSpec): BotThreadRow =>
  ({
    link: {
      threadId: spec.id,
      botId: "bot-ada",
      archivedAt: null,
      pinnedAt: spec.pinned === true ? "2026-11-01T00:00:00.000Z" : null,
      unread: spec.unread,
      lastReplyAt: spec.unread === true ? new Date("2026-11-02T00:00:00.000Z") : undefined,
    },
    shell: {
      id: spec.id,
      title: `Chat ${spec.id}`,
      archivedAt: null,
      session: spec.running === true ? { status: "running" } : null,
      latestTurn:
        spec.completedAt === undefined
          ? null
          : { state: "completed", completedAt: spec.completedAt },
      hasPendingApprovals: spec.approvals === true,
      hasPendingUserInput: false,
    },
    updatedMs: spec.updatedMs ?? 0,
  }) as unknown as BotThreadRow;

const ada = { botId: PersonalBotId.make("bot-ada"), name: "Ada" } as unknown as PersonalBot;

describe("threadsScreenState", () => {
  it("is loading until the list or an error arrives", () => {
    expect(threadsScreenState("bot-ada", { bots: null, error: null })).toEqual({ kind: "loading" });
  });

  it("is an error when nothing is cached", () => {
    expect(threadsScreenState("bot-ada", { bots: null, error: "offline" })).toEqual({
      kind: "error",
      message: "offline",
    });
  });

  it("is not found when the list loaded without the bot", () => {
    expect(threadsScreenState("bot-zed", { bots: [ada], error: null })).toEqual({
      kind: "notFound",
    });
  });

  it("is ready with the bot, even when a refresh failed", () => {
    expect(threadsScreenState("bot-ada", { bots: [ada], error: "offline" })).toEqual({
      kind: "ready",
      bot: ada,
    });
  });
});

describe("selection", () => {
  const rows = {
    active: [
      rowOf({ id: "a" }),
      rowOf({ id: "b", pinned: true }),
      rowOf({ id: "c", pinned: true }),
    ],
    archived: [rowOf({ id: "x" })],
  };

  it("starts with the pressed chat selected in its section", () => {
    expect(startSelection("active", "a")).toEqual({ section: "active", ids: new Set(["a"]) });
    expect(startSelection("archived", null)).toEqual({ section: "archived", ids: new Set() });
  });

  it("toggles one chat and ignores a toggle outside select mode", () => {
    const selection = startSelection("active", "a");
    expect(toggleThread(selection, "b")?.ids).toEqual(new Set(["a", "b"]));
    expect(toggleThread(toggleThread(selection, "b"), "a")?.ids).toEqual(new Set(["b"]));
    expect(toggleThread(null, "a")).toBeNull();
  });

  it("selects every chat of the section, then none", () => {
    const selection = startSelection("active", "a");
    const all = toggleAllThreads(selection, ["a", "b", "c"]);
    expect(all?.ids).toEqual(new Set(["a", "b", "c"]));
    expect(toggleAllThreads(all, ["a", "b", "c"])?.ids).toEqual(new Set());
    expect(toggleAllThreads(null, ["a"])).toBeNull();
  });

  it("views the held section only", () => {
    const view = selectionView({ section: "active", ids: new Set(["b", "c", "x"]) }, rows);
    expect(view.sectionIds).toEqual(["a", "b", "c"]);
    expect(view.chosen).toEqual(["b", "c"]);
    expect(view.everySelected).toBe(false);
    expect(view.allChosenPinned).toBe(true);
    expect(view.countLabel).toBe("2 selected");
    const archived = selectionView({ section: "archived", ids: new Set(["x"]) }, rows);
    expect(archived.sectionIds).toEqual(["x"]);
    expect(archived.everySelected).toBe(true);
    expect(archived.allChosenPinned).toBe(false);
  });

  it("labels an empty selection Select chats", () => {
    expect(selectionView(startSelection("active", null), rows).countLabel).toBe("Select chats");
  });

  it("leaves select mode when every chat was done, else keeps the refused ones", () => {
    expect(selectionAfterBulk("active", [])).toBeNull();
    expect(selectionAfterBulk("archived", ["x"])).toEqual({
      section: "archived",
      ids: new Set(["x"]),
    });
  });

  it("counts working chats among the chosen", () => {
    const live = [rowOf({ id: "a", running: true }), rowOf({ id: "b" })];
    expect(workingCount(live, ["a", "b"])).toBe(1);
    expect(workingCount(live, ["b"])).toBe(0);
  });
});

describe("bulkBarButtons", () => {
  it("offers the five actions on open chats", () => {
    expect(bulkBarButtons("active", false).map((button) => button.label)).toEqual([
      "Archive",
      "Pin",
      "Snooze",
      "Mark unread",
      "Delete",
    ]);
  });

  it("offers Unpin when every chosen chat is pinned", () => {
    expect(bulkBarButtons("active", true).map((button) => button.action)).toEqual([
      "archive",
      "unpin",
      "snooze",
      "markUnread",
      "delete",
    ]);
  });

  it("offers Unarchive and Delete on archived chats", () => {
    expect(bulkBarButtons("archived", true)).toEqual([
      { action: "unarchive", label: "Unarchive", danger: false },
      { action: "delete", label: "Delete", danger: true },
    ]);
  });
});

describe("listMenuItems", () => {
  it("disables Select chats without open chats and hides archived selection without archives", () => {
    expect(listMenuItems(0, 0)).toEqual([
      { section: "active", label: "Select chats", disabled: true },
    ]);
  });

  it("adds Select archived chats when there are archives", () => {
    expect(listMenuItems(3, 2)).toEqual([
      { section: "active", label: "Select chats", disabled: false },
      { section: "archived", label: "Select archived chats", disabled: false },
    ]);
  });
});

describe("archived chats", () => {
  it("counts from the server when it omits archives from the list", () => {
    expect(archivedChatCount("bot-ada", { "bot-ada": 4 }, 0)).toBe(4);
    expect(archivedChatCount("bot-bea", { "bot-ada": 4 }, 0)).toBe(0);
    expect(archivedChatCount("bot-ada", undefined, 2)).toBe(2);
  });

  it("loads lazily", () => {
    expect(archivedLoad({ lazy: false, isSuccess: false, error: null })).toBe("ready");
    expect(archivedLoad({ lazy: true, isSuccess: true, error: null })).toBe("ready");
    expect(archivedLoad({ lazy: true, isSuccess: false, error: null })).toBe("loading");
    expect(archivedLoad({ lazy: true, isSuccess: false, error: "offline" })).toBe("error");
  });

  it("words the section headings", () => {
    expect(archivedHeading(3)).toBe("Archived chats (3)");
    expect(snoozedHeading(2)).toBe("Snoozed (2)");
  });
});

describe("activeEmptyText", () => {
  it("says every chat is snoozed when only snoozed ones exist", () => {
    expect(activeEmptyText("Ada", 2)).toBe("Every chat with Ada is snoozed.");
    expect(activeEmptyText("Ada", 0)).toBe("No chats with Ada yet.");
  });
});

describe("unreadThreadIds", () => {
  it("marks chats the bot replied in", () => {
    const rows = [rowOf({ id: "a", unread: true }), rowOf({ id: "b" })];
    expect(unreadThreadIds(rows, NO_CHAT_SEEN)).toEqual(new Set(["a"]));
  });

  it("skips the chat open on this device", () => {
    const rows = [rowOf({ id: "a", unread: true })];
    expect(unreadThreadIds(rows, { openThreadId: "a", seenUpToMs: new Map() })).toEqual(new Set());
  });
});

describe("turnsSettledKey", () => {
  it("changes when a chat completes a turn", () => {
    const before = [rowOf({ id: "a" })];
    const after = [rowOf({ id: "a", completedAt: "2026-11-02T00:00:00.000Z" })];
    expect(turnsSettledKey(before)).toBe("a:");
    expect(turnsSettledKey(after)).toBe("a:2026-11-02T00:00:00.000Z");
  });
});

describe("newestRow and wrapupDisabled", () => {
  it("picks the most recent chat", () => {
    const rows = [rowOf({ id: "a", updatedMs: 5 }), rowOf({ id: "b", updatedMs: 9 })];
    expect(newestRow(rows)?.link.threadId).toBe("b");
    expect(newestRow([])).toBeNull();
  });

  it("disables Wrapup without a chat, offline or while sending", () => {
    expect(wrapupDisabled({ hasChat: false, offline: false, sending: false })).toBe(true);
    expect(wrapupDisabled({ hasChat: true, offline: true, sending: false })).toBe(true);
    expect(wrapupDisabled({ hasChat: true, offline: false, sending: true })).toBe(true);
    expect(wrapupDisabled({ hasChat: true, offline: false, sending: false })).toBe(false);
  });
});

describe("rowStatus", () => {
  it("puts a pending approval first, then working, else nothing", () => {
    expect(rowStatus(rowOf({ id: "a", approvals: true, running: true }))).toEqual({
      kind: "needsYou",
      label: "Needs you",
    });
    expect(rowStatus(rowOf({ id: "a", running: true }))).toEqual({
      kind: "working",
      label: "Working",
    });
    expect(rowStatus(rowOf({ id: "a" }))).toEqual({ kind: "none" });
  });
});

describe("wakeStep", () => {
  it("waits until just after the wake time", () => {
    expect(wakeStep(10_000, 4_000)).toEqual({ kind: "wait", ms: 6_400 });
  });

  it("fires once the wake time and slack have passed", () => {
    expect(wakeStep(10_000, 10_400)).toEqual({ kind: "fire" });
  });

  it("waits in steps when the wake time is further than a timer allows", () => {
    expect(wakeStep(5_000_000_000, 0)).toEqual({ kind: "wait", ms: 2_147_483_647 });
  });
});

describe("turnsBaselineStep", () => {
  it("keeps the first non-empty key as the baseline without a refetch", () => {
    expect(turnsBaselineStep(null, "a:")).toEqual({ baseline: "a:", refetch: false });
  });

  it("ignores an empty key", () => {
    expect(turnsBaselineStep("a:", "")).toEqual({ baseline: "a:", refetch: false });
  });

  it("refetches when the key changes after the baseline", () => {
    expect(turnsBaselineStep("a:", "a:2026")).toEqual({ baseline: "a:2026", refetch: true });
    expect(turnsBaselineStep("a:2026", "a:2026")).toEqual({ baseline: "a:2026", refetch: false });
  });
});

describe("rowSwipeSpec", () => {
  it("gives open chats Pin and Snooze to the right and Archive and Delete to the left", () => {
    const spec = rowSwipeSpec("active", false);
    expect(spec.leading.map((action) => action.label)).toEqual(["Pin", "Snooze"]);
    expect(spec.trailing.map((action) => action.label)).toEqual(["Archive", "Delete"]);
  });

  it("offers Unpin on a pinned chat", () => {
    expect(rowSwipeSpec("active", true).leading.map((action) => action.key)).toEqual([
      "unpin",
      "snooze",
    ]);
  });

  it("gives snoozed and archived chats nothing to the right", () => {
    expect(rowSwipeSpec("snoozed", false).leading).toEqual([]);
    expect(rowSwipeSpec("archived", false).leading).toEqual([]);
  });

  it("gives archived chats Unarchive and Delete", () => {
    expect(rowSwipeSpec("archived", false).trailing).toEqual([
      { key: "unarchive", label: "Unarchive", tone: "neutral" },
      { key: "delete", label: "Delete", tone: "danger" },
    ]);
  });

  it("gives snoozed chats Archive and Delete", () => {
    expect(rowSwipeSpec("snoozed", false).trailing.map((action) => action.key)).toEqual([
      "archive",
      "delete",
    ]);
  });
});
