// Where a memory note came from and how it may be undone: who wrote the message that started a turn, whether the
// bot read the web in it, and which Undo a chat line gets. Pure.
import {
  isBotRuleSource,
  type PersonalMemoryEntry,
  type PersonalMemoryNoteOrigin,
} from "@t3tools/contracts";

import { RULE_FORGOTTEN_REASON } from "./memoryShared.ts";

/** Tools that bring web or browser content into a turn (app tools and provider built-ins). */
export const WEB_TOOL_PATTERN =
  /(search_web|read_pages|search_google|search_products|secret_request|preview_[a-z_]+|computer_[a-z_]+|use_login|WebFetch|WebSearch|web_fetch|web_search)/i;
/** The same tools as WEB_TOOL_PATTERN, lowercase, for a SQL `instr` over a whole thread. */
export const WEB_TOOL_NEEDLES = [
  "search_web",
  "read_pages",
  "search_google",
  "search_products",
  "secret_request",
  "preview_",
  "computer_",
  "use_login",
  "webfetch",
  "websearch",
  "web_fetch",
  "web_search",
] as const;

/** App-written user-role messages all carry a "personal-" id (task and steer briefs, routine runs, relays, notices). */
export const isOwnerMessageId = (messageId: string): boolean => !messageId.startsWith("personal-");

/**
 * Who started the turn, from the id of its message: the owner in a chat, a task or routine, another bot (relay, group,
 * lead answer), or the app itself. `taskSource` is the source of the thread's newest task.
 */
export const originOfMessage = (
  messageId: string,
  taskSource: string | null,
): PersonalMemoryNoteOrigin =>
  isOwnerMessageId(messageId)
    ? "chat"
    : messageId.startsWith("personal-task-")
      ? taskSource === "routine"
        ? "routine"
        : "task"
      : messageId.startsWith("personal-relay-") ||
          messageId.startsWith("personal-group-") ||
          messageId.startsWith("personal-lead-answer-")
        ? "bot"
        : "app";

/** Whether any of the turn's tool activities brought web or browser content in. */
export const usedWebTool = (
  tools: ReadonlyArray<{ readonly itemType: string | null; readonly text: string }>,
): boolean =>
  tools.some((tool) => tool.itemType === "web_search" || WEB_TOOL_PATTERN.test(tool.text));

/**
 * Which Undo a chat line's entry gets. A rule a bot saved at the owner's word (a `;rule` source) can be archived
 * again, and a rule a bot forgot at the owner's word comes back whatever its source is (most live rules were saved
 * as `bot:<id>` or by a tidy-up, long before `;rule`). Any other preference gets none; a note gets the note Undo.
 */
export const undoRoute = (
  current: Pick<PersonalMemoryEntry, "kind" | "source" | "supersededReason">,
  undo: "archive" | "restore" | undefined,
): "rule" | "note" | "refuse" =>
  current.kind === "preference" &&
  (isBotRuleSource(current.source) ||
    (undo === "restore" && current.supersededReason === RULE_FORGOTTEN_REASON))
    ? "rule"
    : current.kind !== "note"
      ? "refuse"
      : "note";
