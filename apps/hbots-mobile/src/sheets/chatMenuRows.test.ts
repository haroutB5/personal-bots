import { describe, expect, it } from "vite-plus/test";
import type {
  ChatSettingsRow,
  ChatSettingsRowId,
} from "@hbots/personal-client/bots/chatSettingsModel";
import { chatMenuRows } from "./chatMenuRows";

function row(
  id: ChatSettingsRowId,
  label: string,
  extra: Partial<ChatSettingsRow> = {},
): ChatSettingsRow {
  return { id, label, detail: null, disabled: false, destructive: false, ...extra };
}

function ids(groups: ReturnType<typeof chatMenuRows>): ReadonlyArray<string> {
  return groups.flatMap((section) => section.rows.map((entry) => entry.id));
}

describe("chatMenuRows", () => {
  it("puts Token usage before Delete chat, which alone ends the menu", () => {
    const sections = chatMenuRows([
      [row("pin", "Pin chat"), row("snooze", "Snooze…")],
      [row("rename", "Rename chat")],
      [row("archive", "Archive chat"), row("delete", "Delete chat", { destructive: true })],
    ]);
    expect(ids(sections)).toEqual(["pin", "snooze", "rename", "archive", "tokenUsage", "delete"]);
    const last = sections.at(-1);
    expect(last?.kind).toBe("chat");
    expect(last?.rows).toEqual([row("delete", "Delete chat", { destructive: true })]);
  });

  it("has no Context used or Call row", () => {
    const sections = chatMenuRows([
      [row("pin", "Pin chat")],
      [row("archive", "Archive chat"), row("delete", "Delete chat", { destructive: true })],
    ]);
    const labels = sections.flatMap((section) => section.rows.map((entry) => entry.label));
    expect(labels).not.toContain("Context used");
    expect(labels.filter((label) => label.startsWith("Call "))).toEqual([]);
  });
});
