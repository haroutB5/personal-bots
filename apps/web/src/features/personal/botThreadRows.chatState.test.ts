import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { botThreadRows } from "./botThreadRows";

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const link = (threadId: string, extra: Record<string, unknown> = {}) =>
  ({ threadId, botId: "cto", archivedAt: null, ...extra }) as unknown as PersonalBotThread;
const shell = (id: string, activityMs: number) =>
  ({
    id,
    updatedAt: iso(activityMs),
    createdAt: iso(activityMs),
    latestUserMessageAt: null,
    latestTurn: null,
    archivedAt: null,
    title: id,
  }) as unknown as EnvironmentThreadShell;

const shells = [
  shell("old", NOW - 5 * 3_600_000),
  shell("mid", NOW - 3 * 3_600_000),
  shell("new", NOW - 1 * 3_600_000),
  shell("pinned-old", NOW - 9 * 3_600_000),
  shell("pinned-new", NOW - 2 * 3_600_000),
];
const pinnedAt = DateTime.makeUnsafe(NOW - 86_400_000);
const snoozedUntil = (hours: number) => DateTime.makeUnsafe(NOW + hours * 3_600_000);

describe("botThreadRows pin and snooze", () => {
  it("puts pinned chats first, then the rest, each newest first", () => {
    const rows = botThreadRows(
      "cto",
      [
        link("old"),
        link("mid"),
        link("new"),
        link("pinned-old", { pinnedAt }),
        link("pinned-new", { pinnedAt }),
      ],
      shells,
      new Set(),
      NOW,
    );
    expect(rows.active.map((row) => row.link.threadId)).toEqual([
      "pinned-new",
      "pinned-old",
      "new",
      "mid",
      "old",
    ]);
  });

  it("takes a snoozed chat out of the open list into Snoozed, soonest wake first", () => {
    const rows = botThreadRows(
      "cto",
      [
        link("old"),
        link("mid", { snoozedUntil: snoozedUntil(5) }),
        link("new", { snoozedUntil: snoozedUntil(2) }),
      ],
      shells,
      new Set(),
      NOW,
    );
    expect(rows.active.map((row) => row.link.threadId)).toEqual(["old"]);
    expect(rows.snoozed.map((row) => row.link.threadId)).toEqual(["new", "mid"]);
  });

  it("treats a snooze whose time has passed as awake (the client does not wait for the refetch)", () => {
    const rows = botThreadRows(
      "cto",
      [link("new", { snoozedUntil: snoozedUntil(-0.01) }), link("old")],
      shells,
      new Set(),
      NOW,
    );
    expect(rows.active.map((row) => row.link.threadId)).toEqual(["new", "old"]);
    expect(rows.snoozed).toEqual([]);
  });

  it("a snoozed pinned chat waits in Snoozed, and an archived chat is in neither", () => {
    const rows = botThreadRows(
      "cto",
      [
        link("pinned-new", { pinnedAt, snoozedUntil: snoozedUntil(3) }),
        link("old", { archivedAt: DateTime.makeUnsafe(NOW - 1000) }),
      ],
      shells,
      new Set(),
      NOW,
    );
    expect(rows.active).toEqual([]);
    expect(rows.snoozed.map((row) => row.link.threadId)).toEqual(["pinned-new"]);
    expect(rows.archived.map((row) => row.link.threadId)).toEqual(["old"]);
  });
});
