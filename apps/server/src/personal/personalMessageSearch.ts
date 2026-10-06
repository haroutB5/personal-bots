import {
  PERSONAL_MESSAGE_SEARCH_MAX_RESULTS,
  type MessageId,
  type PersonalBotId,
  type PersonalBotSearchMessageHit,
  type PersonalBotSearchMessagesResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PersonalMessageSearchRow } from "./PersonalBotRepository.ts";

/** The most message rows one search reads before it groups them by chat. */
export const PERSONAL_MESSAGE_SEARCH_RAW_ROWS = 200;

/** A snooze can reach at most this far ahead. */
export const PERSONAL_SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/** Lower-cases ASCII only, exactly as SQLite's `lower()` does, so both sides agree. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

const SNIPPET_CHARS = 140;

/**
 * One line of the message around its match: whitespace folded, cut at both
 * ends with an ellipsis when the message continues. `row.snippet` starts at
 * `row.snippetStart` (1-based) and is at most 200 characters.
 */
export function snippetOf(row: Pick<PersonalMessageSearchRow, "snippet" | "snippetStart">): string {
  const flat = row.snippet.replace(/\s+/g, " ").trim();
  const clipped = flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS).trimEnd()}…` : flat;
  return row.snippetStart > 1 ? `…${clipped}` : clipped;
}

/**
 * Newest first, one hit per chat (the newest message that matches), the rest of
 * that chat counted in `moreInChat`. `capped` says the search stopped at its
 * limits, so older chats may match too.
 */
export function groupMessageSearchRows(
  rows: ReadonlyArray<PersonalMessageSearchRow>,
  limit: number,
  rawCapped: boolean,
): PersonalBotSearchMessagesResult {
  const hits: PersonalBotSearchMessageHit[] = [];
  const byThread = new Map<string, number>();
  let more = false;
  for (const row of rows) {
    const index = byThread.get(row.threadId);
    if (index !== undefined) {
      const hit = hits[index]!;
      hits[index] = { ...hit, moreInChat: hit.moreInChat + 1 };
      continue;
    }
    if (hits.length >= limit) {
      more = true;
      continue;
    }
    byThread.set(row.threadId, hits.length);
    hits.push({
      threadId: row.threadId as ThreadId,
      botId: row.botId as PersonalBotId | null,
      groupId: row.groupId,
      messageId: row.messageId as MessageId,
      role: row.role,
      snippet: snippetOf(row),
      createdAt: DateTime.makeUnsafe(row.createdAt),
      archived: row.archived,
      moreInChat: 0,
    });
  }
  return { hits, capped: rawCapped || more };
}

export { PERSONAL_MESSAGE_SEARCH_MAX_RESULTS };
