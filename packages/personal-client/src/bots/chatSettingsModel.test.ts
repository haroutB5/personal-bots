import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import {
  buildChatSettingsTarget,
  chatSettingsHeader,
  chatSettingsRows,
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
