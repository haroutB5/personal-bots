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
const shell = (id: string, updatedAt: string) =>
  ({ id, updatedAt, archivedAt: null, title: id }) as unknown as EnvironmentThreadShell;

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
