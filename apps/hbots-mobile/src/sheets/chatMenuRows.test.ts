import { describe, expect, it } from "vite-plus/test";
import type {
  ChatSettingsRow,
  ChatSettingsRowId,
} from "@hbots/personal-client/bots/chatSettingsModel";
import { CHAT_MENU_BOT_ROWS, chatMenuRows } from "./chatMenuRows";

function row(
  id: ChatSettingsRowId,
  label: string,
  extra: Partial<ChatSettingsRow> = {},
): ChatSettingsRow {
  return { id, label, detail: null, disabled: false, destructive: false, ...extra };
}

describe("chatMenuRows", () => {
  it("puts Delete chat alone in the last group", () => {
    const groups = chatMenuRows([
      [row("pin", "Pin chat"), row("snooze", "Snooze…")],
      [row("rename", "Rename chat")],
      [row("archive", "Archive chat"), row("delete", "Delete chat", { destructive: true })],
    ]);
    expect(groups.map((group) => group.map((entry) => entry.id))).toEqual([
      ["pin", "snooze"],
      ["rename"],
      ["archive"],
      ["delete"],
    ]);
    expect(groups.at(-1)).toEqual([row("delete", "Delete chat", { destructive: true })]);
  });

  it("has no Context used or Call row", () => {
    const groups = chatMenuRows([
      [row("pin", "Pin chat")],
      [row("archive", "Archive chat"), row("delete", "Delete chat", { destructive: true })],
    ]);
    const labels = [
      ...groups.flat().map((entry) => entry.label),
      ...CHAT_MENU_BOT_ROWS.map((entry) => entry.label),
    ];
    expect(labels).not.toContain("Context used");
    expect(labels.filter((label) => label.startsWith("Call "))).toEqual([]);
  });
});
