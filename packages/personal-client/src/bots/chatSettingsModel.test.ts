import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "./threadShell.ts";

import {
  buildChatSettingsTarget,
  chatSettingsArchiveInput,
  chatSettingsHeader,
  chatSettingsRows,
  chatSettingsSheet,
  type ChatSettingsRowContext,
} from "./chatSettingsModel.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

const shell = (overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell =>
  ({
    id: "th1",
    title: "Weekend in Lisbon",
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-05T11:00:00.000Z",
    archivedAt: null,
    session: null,
    latestTurn: null,
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const link = (overrides: Record<string, unknown> = {}) =>
  ({
    botId: "b1",
    threadId: "th1",
    createdAt: "2026-11-01T09:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }) as never;

const context = (overrides: Partial<ChatSettingsRowContext> = {}): ChatSettingsRowContext => ({
  turnsUnavailable: false,
  wrapupSending: false,
  threadLoading: false,
  nowMs: NOW,
  ...overrides,
});

const target = (
  overrides: {
    link?: Record<string, unknown>;
    shell?: Partial<EnvironmentThreadShell>;
  } = {},
) =>
  buildChatSettingsTarget({
    threadId: "th1",
    currentThreadId: "th1",
    kind: "chat",
    link: link(overrides.link),
    shell: shell(overrides.shell),
    waitingLabel: null,
    unread: false,
    hidePreviews: false,
    openChatBusy: false,
    nowMs: NOW,
  });

const ids = (rows: ReturnType<typeof chatSettingsRows>) => rows.flat().map((row) => row.id);

describe("chatSettingsHeader", () => {
  it("names the open chat once", () => {
    const header = chatSettingsHeader(target(), NOW);
    expect(header.title).toBe("Weekend in Lisbon");
    expect(header.meta).toContain("This chat");
    expect(header.preview).toBeNull();
  });
});

describe("chatSettingsRows", () => {
  it("offers the open chat's full action set", () => {
    expect(ids(chatSettingsRows(target(), context()))).toEqual([
      "pin",
      "snooze",
      "markUnread",
      "rename",
      "wrapup",
      "archive",
      "delete",
    ]);
  });

  it("keeps only Rename, Unarchive and Delete on an archived chat", () => {
    const archived = target({ link: { archivedAt: "2026-11-04T10:00:00.000Z" } });
    expect(ids(chatSettingsRows(archived, context()))).toEqual(["rename", "unarchive", "delete"]);
  });

  it("says when a wrapup will run instead of starting it now", () => {
    const rows = chatSettingsRows(target(), context({ wrapupSending: true })).flat();
    const wrapup = rows.find((row) => row.id === "wrapup");
    expect(wrapup?.disabled).toBe(true);
    expect(wrapup?.detail).toBe("After this reply");
  });

  it("offers Wake now instead of Snooze while a chat sleeps", () => {
    const sleeping = target({
      link: { snoozedUntil: DateTime.makeUnsafe("2026-11-05T15:00:00.000Z") },
    });
    expect(ids(chatSettingsRows(sleeping, context()))).toContain("wake");
    expect(ids(chatSettingsRows(sleeping, context()))).not.toContain("snooze");
  });
});

describe("chatSettingsSheet", () => {
  const CURRENT = "chat-a";
  const HELD = "chat-b";
  const links = [link({ threadId: CURRENT }), link({ threadId: HELD })];
  const shells = [
    shell({ id: CURRENT as EnvironmentThreadShell["id"], title: "The open chat" }),
    shell({ id: HELD as EnvironmentThreadShell["id"], title: "Can you check what's..." }),
  ];

  const sheet = (threadId: string | null) =>
    chatSettingsSheet({
      threadId,
      currentThreadId: CURRENT,
      links,
      shells,
      hidePreviews: false,
      openChatBusy: true,
      openChatLoaded: true,
      turnsUnavailable: false,
      wrapupSending: false,
      nowMs: NOW,
    });

  it("targets the held chat's own id and title", () => {
    const held = sheet(HELD);
    expect(held?.target.threadId).toBe("chat-b");
    expect(held?.target.title).toBe("Can you check what's...");
    expect(held?.target.isOpenChat).toBe(false);
  });

  it("archives only the held chat", () => {
    const held = sheet(HELD);
    expect(held).not.toBeNull();
    expect(chatSettingsArchiveInput(held!.target)).toEqual({
      threadIds: ["chat-b"],
      archived: true,
    });
  });

  it("leaves out the wrap-up row on a chat whose thread is not loaded", () => {
    expect(ids(sheet(HELD)!.groups)).toEqual([
      "pin",
      "snooze",
      "markUnread",
      "rename",
      "archive",
      "delete",
    ]);
    expect(ids(sheet(CURRENT)!.groups)).toEqual([
      "pin",
      "snooze",
      "markUnread",
      "rename",
      "wrapup",
      "archive",
      "delete",
    ]);
  });

  it("targets the open chat when opened from the header or the menu", () => {
    const open = sheet(CURRENT);
    expect(open?.target.threadId).toBe("chat-a");
    expect(open?.target.title).toBe("The open chat");
    expect(open?.target.isOpenChat).toBe(true);
  });

  it("is closed with no target, and for a chat that is gone", () => {
    expect(sheet(null)).toBeNull();
    expect(sheet("chat-gone")).toBeNull();
  });
});
