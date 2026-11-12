import type { ChatSettingsRow } from "@hbots/personal-client/bots/chatSettingsModel";

export interface ChatMenuBotRow {
  readonly id: "tokenUsage";
  readonly label: string;
}

/** The bot section's rows. Token usage has no other entry point. */
export const CHAT_MENU_BOT_ROWS: ReadonlyArray<ChatMenuBotRow> = [
  { id: "tokenUsage", label: "Token usage" },
];

export type ChatMenuSection =
  | {
      readonly kind: "chat";
      readonly key: string;
      readonly rows: ReadonlyArray<ChatSettingsRow>;
    }
  | {
      readonly kind: "bot";
      readonly key: "bot";
      readonly rows: ReadonlyArray<ChatMenuBotRow>;
    };

/**
 * The menu's sections in order: chat groups, the bot section, then destructive
 * rows pulled into one last group. Delete chat is always the final row.
 */
export function chatMenuRows(
  groups: ReadonlyArray<ReadonlyArray<ChatSettingsRow>>,
): ReadonlyArray<ChatMenuSection> {
  const body = groups
    .map((group) => group.filter((row) => !row.destructive))
    .filter((group) => group.length > 0)
    .map((rows): ChatMenuSection => ({
      kind: "chat",
      key: rows.map((row) => row.id).join(":"),
      rows,
    }));
  const destructive = groups.flatMap((group) => group.filter((row) => row.destructive));
  const sections: ChatMenuSection[] = [
    ...body,
    { kind: "bot", key: "bot", rows: CHAT_MENU_BOT_ROWS },
  ];
  if (destructive.length > 0) {
    sections.push({ kind: "chat", key: "destructive", rows: destructive });
  }
  return sections;
}
