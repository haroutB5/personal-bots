import {
  type OrchestrationMessageContext,
  PERSONAL_CHAT_NOTICE_CONTEXT_KIND,
  PersonalChatNoticeMarker,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PERSONAL_TIME_ZONE } from "./greeting";

const decodeMarker = Schema.decodeUnknownOption(PersonalChatNoticeMarker);

/** Server-written notice rows and continue turns, by id when the context is not at hand. */
const NOTICE_MESSAGE_ID = /^personal-(notice|resume)-/;

/**
 * The server's own line in a bot chat (paused on a usage limit, or its
 * automatic continue), or null for anything anyone else wrote.
 */
export function readChatNotice(message: {
  readonly context?: OrchestrationMessageContext | undefined;
}): PersonalChatNoticeMarker | null {
  for (const record of message.context?.records ?? []) {
    if (record.kind !== PERSONAL_CHAT_NOTICE_CONTEXT_KIND || !("payload" in record)) continue;
    const marker = decodeMarker(record.payload);
    return Option.isSome(marker) ? marker.value : null;
  }
  return null;
}

/** The save a "Replaced" line belongs to: the entry that replaced it and the archived entry's version after that save. */
export interface UnreplaceReceipt {
  readonly replacedBy: string;
  readonly version: number;
}

/**
 * What a note line's Undo does, or null for a line without one. A "Replaced"
 * line's Undo is tied to its save by a receipt (1.66.7); one without a receipt
 * is shown as a plain line.
 */
export function chatNoticeUndo(notice: PersonalChatNoticeMarker): {
  readonly memoryId: string;
  readonly undo: "archive" | "restore" | "unreplace";
  readonly receipt?: UnreplaceReceipt;
} | null {
  if (notice.notice !== "memory-saved") return null;
  if (notice.memoryId === undefined || notice.undo === undefined) return null;
  if (notice.undo === "unreplace") {
    if (notice.replacedBy === undefined || notice.version === undefined) return null;
    return {
      memoryId: notice.memoryId,
      undo: notice.undo,
      receipt: { replacedBy: notice.replacedBy, version: notice.version },
    };
  }
  return { memoryId: notice.memoryId, undo: notice.undo };
}

export function isChatNoticeMessageId(messageId: string): boolean {
  return NOTICE_MESSAGE_ID.test(messageId);
}

/**
 * Notices that are the server's user-role turn message (the provider needs a
 * prompt): shown as an expandable system row, and they start a new turn.
 */
export function isServerTurnNotice(notice: PersonalChatNoticeMarker): boolean {
  return (
    notice.notice === "usage-limit-resumed" ||
    notice.notice === "team-bot-answer" ||
    notice.notice === "release-landed" ||
    notice.notice === "model-fallback-resumed"
  );
}

export const RESUMED_NOTICE_LABEL = "Auto-continue after usage reset";
export const FALLBACK_RESUMED_NOTICE_LABEL = "Continued on the fallback model";
export const FALLBACK_ON_NOTICE_TEXT = "Switched to the fallback model.";
export const FALLBACK_OFF_NOTICE_TEXT = "Back on the main model.";

function formatResumeTime(resumeAtMs: number, nowMs: number, timeZone: string): string {
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resumeAtMs);
  if (day(resumeAtMs) === day(nowMs)) return time;
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(
    resumeAtMs,
  );
  return `${weekday} ${time}`;
}

/**
 * The row's words. The paused line is the server's text with its time
 * re-read from the marker in this device's zone ("Continues at 23:00"); the
 * continue is always the same label, whatever prompt the provider was given.
 */
export function chatNoticeLabel(
  notice: PersonalChatNoticeMarker,
  text: string,
  nowMs: number,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  if (notice.notice === "usage-limit-resumed") return RESUMED_NOTICE_LABEL;
  if (notice.notice === "model-fallback-resumed") return FALLBACK_RESUMED_NOTICE_LABEL;
  const trimmed = text.trim();
  if (notice.notice === "team-bot-answer")
    return trimmed === "" ? "You answered a request" : trimmed;
  // A lead's bot change and a saved preference: the server's line is the whole
  // row, never usage-limit wording.
  if (notice.notice === "team-bot-change") return trimmed === "" ? "Team change" : trimmed;
  if (notice.notice === "memory-saved") return trimmed === "" ? "Memory saved" : trimmed;
  // The fallback model switch and its return: the server's line is the whole row.
  if (notice.notice === "model-fallback-on") {
    return trimmed === "" ? FALLBACK_ON_NOTICE_TEXT : trimmed;
  }
  if (notice.notice === "model-fallback-off") {
    return trimmed === "" ? FALLBACK_OFF_NOTICE_TEXT : trimmed;
  }
  // The release waiter's turn: its outcome line ("Release landed: ..."),
  // under the line saying the app wrote it.
  if (notice.notice === "release-landed") {
    const lines = trimmed.split("\n").map((line) => line.trim());
    return (
      lines.find((line) => line.startsWith("Release ") && !line.startsWith("Release notice")) ??
      (lines[0] || "Release notice")
    );
  }
  const resumeAtMs = notice.resumeAt === undefined ? Number.NaN : Date.parse(notice.resumeAt);
  if (!Number.isFinite(resumeAtMs)) {
    return trimmed === "" ? `Paused: ${notice.provider} usage limit.` : trimmed;
  }
  const head = trimmed.replace(/\s*Continues at .*$/, "");
  return `${head === "" ? `Paused: ${notice.provider} usage limit.` : head} Continues at ${formatResumeTime(resumeAtMs, nowMs, timeZone)}.`;
}
