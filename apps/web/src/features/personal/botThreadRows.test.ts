import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { botThreadRows, chatCountsLabel } from "./botThreadRows";

const link = (threadId: string, botId: string, archived = false) =>
  ({
    threadId,
    botId,
    archivedAt: archived ? "2026-09-20T10:00:00.000Z" : null,
  }) as unknown as PersonalBotThread;
// The time is the chat's last activity: rows order by that, never updatedAt.
const shell = (id: string, activityAt: string, updatedAt = activityAt) =>
  ({
    id,
    updatedAt,
    createdAt: activityAt,
    latestUserMessageAt: null,
    latestTurn: null,
    archivedAt: null,
    title: id,
  }) as unknown as EnvironmentThreadShell;

describe("chatCountsLabel", () => {
  it("shows open and archived chats", () => {
    expect(chatCountsLabel({ open: 8, archived: 1 })).toBe("8 open · 1 archived");
  });

  it("leaves archived out when there are none", () => {
    expect(chatCountsLabel({ open: 3, archived: 0 })).toBe("3 open");
    expect(chatCountsLabel({ open: 0, archived: 0 })).toBe("0 open");
  });
});

describe("botThreadRows", () => {
  it("counts only this bot's chats that still have a thread, split by archive", () => {
    const rows = botThreadRows(
      "cto",
      [
        link("a", "cto"),
        link("b", "cto"),
        link("c", "cto", true),
        link("d", "frontend"),
        link("gone", "cto"),
      ],
      [
        shell("a", "2026-09-24T10:00:00.000Z"),
        shell("b", "2026-09-25T10:00:00.000Z"),
        shell("c", "2026-09-23T10:00:00.000Z"),
        shell("d", "2026-09-25T10:00:00.000Z"),
      ],
    );
    expect(rows.active.map((row) => row.link.threadId)).toEqual(["b", "a"]);
    expect(rows.archived.map((row) => row.link.threadId)).toEqual(["c"]);
    expect(chatCountsLabel({ open: rows.active.length, archived: rows.archived.length })).toBe(
      "2 open · 1 archived",
    );
  });
});

describe("botThreadRows order", () => {
  it("orders by conversation, so a metadata write (auto-settle, rename) does not move a chat", () => {
    const rows = botThreadRows(
      "backend",
      [link("old-settled", "backend"), link("yesterday", "backend")],
      [
        // Last activity 25 Sep; auto-settle stamped updatedAt on 28 Sep.
        shell("old-settled", "2026-09-25T20:09:17.316Z", "2026-09-28T20:10:05.321Z"),
        shell("yesterday", "2026-09-27T10:00:00.000Z"),
      ],
    );
    expect(rows.active.map((row) => row.link.threadId)).toEqual(["yesterday", "old-settled"]);
    expect(rows.active[1]?.updatedMs).toBe(Date.parse("2026-09-25T20:09:17.316Z"));
  });

  it("leaves out the bot's group relay threads, open or archived", () => {
    const rows = botThreadRows(
      "cto",
      [link("own", "cto"), link("relay", "cto"), link("old-relay", "cto", true)],
      [
        shell("own", "2026-09-24T10:00:00.000Z"),
        shell("relay", "2026-09-25T10:00:00.000Z"),
        shell("old-relay", "2026-09-25T10:00:00.000Z"),
      ],
      new Set(["relay", "old-relay"]),
    );
    expect(rows.active.map((row) => row.link.threadId)).toEqual(["own"]);
    expect(rows.archived).toEqual([]);
  });
});
