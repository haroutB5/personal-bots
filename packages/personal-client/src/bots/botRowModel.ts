import type { ServerTurn } from "../conversation/delegationModel.ts";
import { readChatNotice, chatNoticeLabel } from "../conversation/chatNotices.ts";
import { readServerTurn } from "../conversation/delegationModel.ts";
import {
  HIDDEN_PREVIEW_LABEL,
  HIDDEN_WORKING_LABEL,
  hidesBotPreviews,
} from "../conversation/previewPrivacy.ts";
import type { BotSummary } from "./botSummaries.ts";

/**
 * While the bot works, its latest progress note. Else the first non-empty line
 * of the newest user/assistant message, else the thread title. A turn the task
 * service wrote previews as its system-row text.
 */
export function previewOf(summary: BotSummary, describeTurn: (turn: ServerTurn) => string): string {
  if (hidesBotPreviews(summary.bot) || summary.newestMessage?.hidden === true) {
    if (summary.live) return HIDDEN_WORKING_LABEL;
    return summary.newestThread === null ? "No chats yet" : HIDDEN_PREVIEW_LABEL;
  }
  if (summary.live && summary.progressNote != null && summary.progressNote.length > 0) {
    return summary.progressNote;
  }
  const thread = summary.newestThread;
  if (thread === null) return "No chats yet";
  const message = summary.newestMessage;
  if (message !== null) {
    const notice = readChatNotice(message);
    if (notice !== null) return chatNoticeLabel(notice, message.text, Date.now());
    const turn = readServerTurn(message);
    if (turn !== null) return describeTurn(turn);
    const line = message.text
      .split("\n")
      .map((part) => plainPreviewLine(part))
      .find((part) => part.length > 0);
    if (line) return line;
  }
  return thread.title;
}

/**
 * One line of a reply as a row preview: the words, not the markdown around
 * them. Heading, quote and list markers, emphasis, code ticks and link targets
 * go; the text stays. A line that is only a rule or a code fence is empty.
 */
export function plainPreviewLine(line: string): string {
  const known = previewLineCache.get(line);
  if (known !== undefined) return known;
  const plain = computePlainPreviewLine(line);
  if (previewLineCache.size >= PREVIEW_LINE_CACHE_MAX) previewLineCache.clear();
  previewLineCache.set(line, plain);
  return plain;
}

const PREVIEW_LINE_CACHE_MAX = 500;
const previewLineCache = new Map<string, string>();

function computePlainPreviewLine(line: string): string {
  const trimmed = line.trim();
  if (/^(`{3,}|~{3,}|[-*_]{3,}\s*$)/.test(trimmed)) return "";
  return trimmed
    .replace(/^#{1,6}(\s+|$)/, "")
    .replace(/^>\s?/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * The part of {@link previewOf} that may be written to disk: a turn label when
 * the newest message is a task-service turn, else null so the cold-start
 * snapshot falls back to the thread title.
 */
export function snapshotPreviewLabel(
  summary: BotSummary,
  describeTurn: (turn: ServerTurn) => string,
): string | null {
  if (summary.newestThread === null) return null;
  if (hidesBotPreviews(summary.bot) || summary.newestMessage?.hidden === true) {
    return HIDDEN_PREVIEW_LABEL;
  }
  if (summary.newestMessage === null) return null;
  const notice = readChatNotice(summary.newestMessage);
  if (notice !== null) return chatNoticeLabel(notice, summary.newestMessage.text, Date.now());
  const turn = readServerTurn(summary.newestMessage);
  return turn === null ? null : describeTurn(turn);
}
