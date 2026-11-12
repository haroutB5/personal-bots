import type { ChatSettingsRow } from "@hbots/personal-client/bots/chatSettingsModel";

export interface ChatMenuBotRow {
  readonly id: "tokenUsage";
  readonly label: string;
}

/** The bot section's rows. Token usage has no other entry point. */
export const CHAT_MENU_BOT_ROWS: ReadonlyArray<ChatMenuBotRow> = [
  { id: "tokenUsage", label: "Token usage" },
];

/** The chat's groups with destructive rows pulled out into one last group. */
export function chatMenuRows(
  groups: ReadonlyArray<ReadonlyArray<ChatSettingsRow>>,
): ReadonlyArray<ReadonlyArray<ChatSettingsRow>> {
  const body = groups
    .map((group) => group.filter((row) => !row.destructive))
    .filter((group) => group.length > 0);
  const destructive = groups.flatMap((group) => group.filter((row) => row.destructive));
  return destructive.length === 0 ? body : [...body, destructive];
}
