import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBotThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChatSettingsTarget,
  CHAT_SETTINGS_HINT,
  chatActionAnnouncement,
  chatActionFailure,
  chatSettingsHeader,
  chatSettingsHint,
  chatSettingsRows,
  quotedChatName,
  type ChatSettingsRowContext,
  type ChatSettingsTarget,
} from "./chatSettingsModel";

// Wed 7 Oct 2026, 12:00 UTC (the chat list's clock is UTC+1 in October, but the words below are relative).
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const link = (overrides: Record<string, unknown> = {}): PersonalBotThread =>
  ({
    botId: "bot-1",
    threadId: "t-other",
    createdAt: DateTime.makeUnsafe(NOW - 48 * HOUR),
    archivedAt: null,
    ...overrides,
  }) as unknown as PersonalBotThread;

const shell = (overrides: Record<string, unknown> = {}): EnvironmentThreadShell =>
  ({
    id: "t-other",
    environmentId: "env-1",
    title: "Tennis",
    updatedAt: iso(NOW - 2 * HOUR),
    createdAt: iso(NOW - 2 * HOUR),
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const base = {
  threadId: "t-other",
  currentThreadId: "t-open",
  kind: "chat" as const,
  waitingLabel: null,
  unread: false,
  hidePreviews: false,
  openChatBusy: false,
  nowMs: NOW,
};

function target(
  overrides: Partial<Parameters<typeof buildChatSettingsTarget>[0]> & {
    link?: PersonalBotThread;
    shell?: EnvironmentThreadShell;
  } = {},
): ChatSettingsTarget {
  return buildChatSettingsTarget({
    ...base,
    link: link(),
    shell: shell(),
    ...overrides,
  });
}

const context = (overrides: Partial<ChatSettingsRowContext> = {}): ChatSettingsRowContext => ({
  turnsUnavailable: false,
  wrapupSending: false,
  threadLoading: false,
  nowMs: NOW,
  ...overrides,
});

const rowIds = (t: ChatSettingsTarget, c: ChatSettingsRowContext = context()) =>
  chatSettingsRows(t, c).map((group) => group.map((entry) => entry.id));
const rowOf = (t: ChatSettingsTarget, id: string, c: ChatSettingsRowContext = context()) =>
  chatSettingsRows(t, c)
    .flat()
    .find((entry) => entry.id === id);

describe("another chat, idle and read", () => {
  const t = target();
  it("says when it last had a message, with no dot", () => {
    expect(chatSettingsHeader(t, NOW)).toMatchObject({
      title: "Tennis",
      meta: "Last message 2h ago",
      dot: null,
      pinned: false,
    });
  });
  it("offers every row in three groups, Wrapup saying it opens the chat", () => {
    expect(rowIds(t)).toEqual([
      ["pin", "snooze", "markUnread"],
      ["rename", "wrapup"],
      ["archive", "delete"],
    ]);
    expect(rowOf(t, "wrapup")).toMatchObject({ detail: "Opens it", disabled: false });
    expect(rowOf(t, "delete")).toMatchObject({ destructive: true, label: "Delete chat" });
    expect(
      chatSettingsRows(t, context())
        .flat()
        .map((entry) => entry.label),
    ).toEqual([
      "Pin chat",
      "Snooze…",
      "Mark unread",
      "Rename chat",
      "Wrapup chat",
      "Archive chat",
      "Delete chat",
    ]);
  });
  it("reads a day or more as a date, a minute as just now", () => {
    expect(
      chatSettingsHeader(target({ shell: shell({ createdAt: iso(NOW - 30_000) }) }), NOW).meta,
    ).toBe("Last message just now");
    expect(
      chatSettingsHeader(target({ shell: shell({ createdAt: iso(NOW - 30 * HOUR) }) }), NOW).meta,
    ).toBe("Last message yesterday");
    expect(
      chatSettingsHeader(target({ shell: shell({ createdAt: iso(NOW - 10 * 24 * HOUR) }) }), NOW)
        .meta,
    ).toBe("Last message 27 Sep");
  });
});

describe("the open chat", () => {
  const open = (extra: Record<string, unknown> = {}, overrides = {}) =>
    target({
      threadId: "t-open",
      link: link({ threadId: "t-open", ...extra }),
      shell: shell({ id: "t-open", createdAt: iso(NOW - 6 * 60_000) }),
      ...overrides,
    });
  it("reads This chat with its time, and Pinned first when it is", () => {
    expect(chatSettingsHeader(open(), NOW).meta).toBe("This chat · 6m");
    expect(
      chatSettingsHeader(open({ pinnedAt: DateTime.makeUnsafe(NOW - HOUR) }), NOW),
    ).toMatchObject({
      meta: "Pinned · This chat · 6m",
      pinned: true,
    });
  });
  it("is the open chat: Wrapup has no detail, Unpin replaces Pin", () => {
    const t = open({ pinnedAt: DateTime.makeUnsafe(NOW - HOUR) });
    expect(t.isOpenChat).toBe(true);
    expect(rowOf(t, "wrapup")).toMatchObject({ detail: null, disabled: false });
    expect(rowIds(t)[0]).toEqual(["unpin", "snooze", "markUnread"]);
    expect(rowOf(t, "unpin")?.label).toBe("Unpin chat");
  });
  it("waits for its thread to load: Rename and Wrapup are off until then", () => {
    const t = open();
    expect(rowOf(t, "rename", context({ threadLoading: true }))?.disabled).toBe(true);
    expect(rowOf(t, "wrapup", context({ threadLoading: true }))).toMatchObject({
      disabled: true,
      detail: "Loading",
    });
    // Another chat's rows never wait for the open chat's thread.
    expect(rowOf(target(), "rename", context({ threadLoading: true }))?.disabled).toBe(false);
    expect(rowOf(target(), "wrapup", context({ threadLoading: true }))?.disabled).toBe(false);
  });
  it("is busy when the screen says so, even if its shell shows no turn", () => {
    const t = open({}, { openChatBusy: true });
    expect(t.working).toBe(true);
    expect(rowOf(t, "wrapup")).toMatchObject({ disabled: true, detail: "After this reply" });
    // The same flag does not make another chat busy.
    expect(target({ openChatBusy: true }).working).toBe(false);
  });
});

describe("an unread chat", () => {
  const t = target({ unread: true });
  it("reads Unread with its dot, and leaves Mark unread out", () => {
    expect(chatSettingsHeader(t, NOW)).toMatchObject({ meta: "Unread · 2h", dot: "unread" });
    expect(rowIds(t)[0]).toEqual(["pin", "snooze"]);
  });
});

describe("a chat with a turn running", () => {
  const working = target({ shell: shell({ latestTurn: { state: "running", turnId: "x" } }) });
  it("reads Working with the live dot", () => {
    expect(working.working).toBe(true);
    expect(chatSettingsHeader(working, NOW)).toMatchObject({ dot: "working" });
    expect(chatSettingsHeader(working, NOW).meta).toMatch(/^(Working|Thinking) · /);
  });
  it("turns Wrapup off with After this reply, and keeps it in its place", () => {
    expect(rowOf(working, "wrapup")).toMatchObject({ disabled: true, detail: "After this reply" });
    expect(rowIds(working)[1]).toEqual(["rename", "wrapup"]);
    // Everything else stays available, Delete included.
    expect(rowOf(working, "delete")?.disabled).toBe(false);
  });
  it("turns Wrapup off while one is already being sent", () => {
    expect(rowOf(target(), "wrapup", context({ wrapupSending: true }))).toMatchObject({
      disabled: true,
      detail: "After this reply",
    });
  });
  it("says Unavailable when the bot cannot take a turn at all, whatever else is true", () => {
    const row = rowOf(target(), "wrapup", context({ turnsUnavailable: true }));
    expect(row).toMatchObject({ disabled: true, detail: "Unavailable" });
    expect(rowOf(working, "wrapup", context({ turnsUnavailable: true }))?.detail).toBe(
      "Unavailable",
    );
  });
});

describe("the other states", () => {
  it("needs you", () => {
    const t = target({ shell: shell({ hasPendingApprovals: true }) });
    expect(chatSettingsHeader(t, NOW)).toMatchObject({ meta: "Needs you · 2h", dot: "needs_you" });
  });
  it("waiting on another bot", () => {
    const t = target({ waitingLabel: "Waiting on Frontend" });
    expect(chatSettingsHeader(t, NOW)).toMatchObject({
      meta: "Waiting on Frontend · 2h",
      dot: "waiting",
    });
  });
  it("rate limited", () => {
    const t = target({
      shell: shell({
        session: { status: "running", providerRetry: { kind: "rate_limited" } },
      }),
    });
    expect(chatSettingsHeader(t, NOW)).toMatchObject({
      meta: "Rate limited · 2h",
      dot: "rate_limited",
    });
  });
});

describe("an archived chat", () => {
  const archived = (overrides = {}) =>
    target({
      threadId: "t-open",
      kind: "archived",
      link: link({ threadId: "t-open", archivedAt: DateTime.makeUnsafe(NOW - HOUR) }),
      shell: shell({ id: "t-open" }),
      ...overrides,
    });
  it("has Rename, Unarchive and Delete only", () => {
    expect(rowIds(archived())).toEqual([["rename"], ["unarchive", "delete"]]);
    expect(rowOf(archived(), "unarchive")?.label).toBe("Unarchive chat");
  });
  it("reads Archived · This chat with no dot", () => {
    expect(chatSettingsHeader(archived(), NOW)).toMatchObject({
      meta: "Archived · This chat",
      dot: null,
      title: "Tennis",
    });
  });
  it("is archived when only the shell says so", () => {
    const t = target({ shell: shell({ archivedAt: iso(NOW - HOUR) }) });
    expect(t.archived).toBe(true);
    expect(rowIds(t)).toEqual([["rename"], ["unarchive", "delete"]]);
  });
});

describe("a task chip", () => {
  const task = target({
    threadId: "t-open",
    kind: "task",
    link: link({ threadId: "t-open" }),
    shell: shell({ id: "t-open", title: "Weight chart fix" }),
  });
  it("is titled Task · and reads Task chat · This chat", () => {
    expect(chatSettingsHeader(task, NOW)).toMatchObject({
      title: "Task · Weight chart fix",
      meta: "Task chat · This chat",
    });
  });
  it("has the same rows as any open chat", () => {
    expect(rowIds(task)).toEqual([
      ["pin", "snooze", "markUnread"],
      ["rename", "wrapup"],
      ["archive", "delete"],
    ]);
  });
});

describe("a snoozed chat", () => {
  // Wake words are in the device's own time zone, so this one is built from local times.
  const LOCAL_NOON = new Date(2026, 9, 7, 12, 0, 0).getTime();
  const woke = new Date(2026, 9, 8, 9, 0, 0).getTime();
  const snoozed = target({
    threadId: "t-open",
    nowMs: LOCAL_NOON,
    link: link({ threadId: "t-open", snoozedUntil: DateTime.makeUnsafe(woke) }),
    shell: shell({ id: "t-open" }),
  });
  it("says when it wakes", () => {
    expect(snoozed.snoozedUntilMs).toBe(woke);
    expect(chatSettingsHeader(snoozed, LOCAL_NOON).meta).toBe("Snoozed until tomorrow 09:00");
  });
  it("offers Wake now with its time in place of Snooze", () => {
    const rows = chatSettingsRows(snoozed, context({ nowMs: LOCAL_NOON }));
    expect(rows.map((group) => group.map((entry) => entry.id))[0]).toEqual([
      "pin",
      "wake",
      "markUnread",
    ]);
    expect(rows.flat().find((entry) => entry.id === "wake")).toMatchObject({
      label: "Wake now",
      detail: "Tomorrow 09:00",
    });
    expect(rows.flat().find((entry) => entry.id === "snooze")).toBeUndefined();
  });
  it("is not snoozed once the time has passed", () => {
    const over = target({ link: link({ snoozedUntil: DateTime.makeUnsafe(NOW - 1) }) });
    expect(over.snoozedUntilMs).toBeNull();
    expect(rowOf(over, "snooze")).toBeDefined();
  });
});

describe("the header's words", () => {
  it("titles an untitled chat New chat", () => {
    expect(target({ shell: shell({ title: null }) }).title).toBe("New chat");
    expect(target({ shell: shell({ title: "  " }) }).title).toBe("New chat");
  });
  it("shows the last message on one line, unless the bot hides previews", () => {
    const withText = link({
      newestMessage: { id: "m1", role: "assistant", text: "Serve  was\nbetter today" },
    });
    expect(chatSettingsHeader(target({ link: withText }), NOW).preview).toBe(
      "Serve was better today",
    );
    expect(
      chatSettingsHeader(target({ link: withText, hidePreviews: true }), NOW).preview,
    ).toBeNull();
    const hidden = link({ newestMessage: { id: "m1", role: "assistant", text: "", hidden: true } });
    expect(chatSettingsHeader(target({ link: hidden }), NOW).preview).toBeNull();
    expect(chatSettingsHeader(target(), NOW).preview).toBeNull();
  });
  it("carries a long title whole: the sheet clamps it", () => {
    const long = "A very long chat title ".repeat(12).trim();
    expect(chatSettingsHeader(target({ shell: shell({ title: long }) }), NOW).title).toBe(long);
  });
});

describe("the three-dots hint and the announcements", () => {
  it("hints at the gesture that fits the header", () => {
    expect(chatSettingsHint(true)).toBe("or hold a chip");
    expect(chatSettingsHint(false)).toBe("or hold the name");
    expect(CHAT_SETTINGS_HINT).toBe("Touch and hold for chat settings.");
  });
  it("names the chat in sentences and failures", () => {
    expect(quotedChatName("Tennis")).toBe("“Tennis”");
    expect(chatActionFailure("archive", "Tennis")).toBe("Couldn't archive “Tennis”. Try again.");
    expect(chatActionFailure("delete", "Tennis")).toBe("Couldn't delete “Tennis”. Try again.");
    expect(chatActionFailure("archive", "Tennis", "Chat not found.")).toBe(
      "Couldn't archive “Tennis”: Chat not found.",
    );
  });
  it("announces what happened to another chat", () => {
    expect(chatActionAnnouncement("pin", "Tennis")).toBe("Tennis pinned.");
    expect(chatActionAnnouncement("unpin", "Tennis")).toBe("Tennis unpinned.");
    expect(chatActionAnnouncement("snooze", "Tennis", "Thu 09:00")).toBe(
      "Tennis snoozed until Thu 09:00.",
    );
    expect(chatActionAnnouncement("markUnread", "Tennis")).toBe("Tennis marked unread.");
    expect(chatActionAnnouncement("archive", "Tennis")).toBe("Tennis archived.");
    expect(chatActionAnnouncement("delete", "Tennis")).toBe("Tennis deleted.");
    expect(chatActionAnnouncement("rename", "Tennis", "Doubles")).toBe(
      "Tennis renamed to “Doubles”.",
    );
    expect(chatActionAnnouncement("wake", "Tennis")).toBe("Tennis woken.");
  });
});
