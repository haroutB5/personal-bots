import {
  CHAT_NAME_TAKEN_CODE,
  chatNameTakenMessage,
  normalizeChatName,
  type PersonalBotThread,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { botThreadRows } from "./botThreadRows";
import { conversationChatTitle } from "./ConversationHeaderName";

/**
 * A bot's open chats have unique names (1.66.5): trimmed, inner whitespace
 * collapsed, case ignored. The server decides (a refusal carries the
 * `chat_name_taken` code); these helpers let a field say so as the owner types,
 * from the chats the screen already holds. An unnamed chat ("New chat") has no
 * name to clash with.
 */

/** The open chats (not archived; snoozed ones included) a name has to differ from, as the bot's list holds them. */
export function botOpenChatNames(
  botId: string,
  links: ReadonlyArray<PersonalBotThread>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  relayThreadIds: ReadonlySet<string>,
): ReadonlyArray<{ readonly threadId: string; readonly title: string }> {
  const rows = botThreadRows(botId, links, shells, relayThreadIds);
  return [...rows.active, ...rows.snoozed].map((row) => ({
    threadId: row.link.threadId as string,
    title: row.shell.title,
  }));
}

/**
 * `A chat called "Main" already exists` when `draft` is the name of one of
 * `others`, else null. An empty draft (or "New chat") never clashes.
 */
export function chatNameClash(draft: string, others: ReadonlyArray<string>): string | null {
  const name = conversationChatTitle(draft);
  if (name === null) return null;
  const wanted = normalizeChatName(name);
  return others.some((title) => {
    const other = conversationChatTitle(title);
    return other !== null && normalizeChatName(other) === wanted;
  })
    ? chatNameTakenMessage(name)
    : null;
}

/** The server refused a typed name because another open chat of the bot has it. */
export function isChatNameTakenFailure(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const error = squashAtomCommandFailure(result);
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === CHAT_NAME_TAKEN_CODE
  );
}
