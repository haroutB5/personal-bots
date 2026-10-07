// Who can see and replace a memory entry, and which rules fit a turn's caps. Pure.
import type { PersonalBotId, PersonalMemoryEntry, PersonalMemoryScope } from "@t3tools/contracts";

import {
  PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
  PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
} from "./memoryShared.ts";

/** How widely a scope reaches; a save may not replace a wider entry than itself. */
export const SCOPE_REACH: Record<PersonalMemoryScope, number> = {
  bot: 1,
  project: 1,
  team: 2,
  shared: 3,
};

/** Whether a bot (on a team) can see an entry. */
export const visibleTo = (
  entry: PersonalMemoryEntry,
  botId: PersonalBotId,
  team: string | null | undefined,
) =>
  entry.scope === "shared" ||
  (entry.scope === "bot" && entry.scopeId === botId) ||
  (entry.scope === "team" &&
    team != null &&
    entry.scopeId !== null &&
    entry.scopeId.toLowerCase() === team.toLowerCase());

/** Same text, ignoring case and spacing: one rule saved in two scopes is listed once. */
export const dedupeKey = (content: string) => content.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The newest preferences that fit the caps. Entries come newest first; once
 * one does not fit, it and every older one are dropped (a shorter older rule
 * never jumps the queue), and the kept ones are returned oldest first.
 */
export function capPreferences(entries: ReadonlyArray<PersonalMemoryEntry>): {
  readonly kept: ReadonlyArray<PersonalMemoryEntry>;
  readonly dropped: number;
} {
  const kept: Array<PersonalMemoryEntry> = [];
  const seen = new Set<string>();
  let chars = 0;
  let dropped = 0;
  let full = false;
  for (const entry of entries) {
    const key = dedupeKey(entry.content);
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      full ||
      kept.length >= PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES ||
      chars + entry.content.length > PERSONAL_MEMORY_PREFERENCE_MAX_CHARS
    ) {
      full = true;
      dropped += 1;
      continue;
    }
    kept.push(entry);
    chars += entry.content.length;
  }
  return { kept: kept.toReversed(), dropped };
}
