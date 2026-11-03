import { hidesBotPreviews } from "@t3tools/contracts";

/**
 * The owner's "Hide message previews" switch (per bot). A bot with it on has
 * its message text kept out of every list, card, notification and cache
 * outside its own chat; these are the neutral lines that stand in for it.
 * Status words ("Working", "Ready") stay; message words never do.
 */
export const HIDDEN_PREVIEW_LABEL = "Preview hidden";
/** A hidden bot's live progress note ("Checking Kraken balance") reads as just this. */
export const HIDDEN_WORKING_LABEL = "Working";
/** A task result a hidden bot wrote, on a card outside its own chat. */
export const HIDDEN_RESULT_LABEL = "Result hidden. Open the task to read it.";

export { hidesBotPreviews };

/** A task summary a hidden bot's task left in memory: its clipped result text. */
export const HIDDEN_SUMMARY_LABEL = "Summary hidden: this bot's previews are hidden.";

/**
 * A memory entry as the Memory screen shows it. A task summary is the clipped
 * result a bot's task wrote, so for a bot with hidden previews its text is
 * replaced; rules and notes (what the owner and bots chose to keep) are not
 * reply text and show as saved.
 */
export function maskHiddenTaskSummary<
  E extends {
    readonly kind: string;
    readonly scope: string;
    readonly scopeId: string | null;
    readonly content: string;
  },
>(entry: E, botById: ReadonlyMap<string, { readonly hidePreviews?: boolean }>): E {
  if (entry.kind !== "task_summary" || entry.scope !== "bot" || entry.scopeId === null) {
    return entry;
  }
  const bot = botById.get(entry.scopeId);
  return bot !== undefined && hidesBotPreviews(bot)
    ? { ...entry, content: HIDDEN_SUMMARY_LABEL }
    : entry;
}
