/** At most one read this often while a working chat keeps changing. */
export const PROGRESS_REFRESH_MS = 2_500;

/** A note and the turn the server read it from. */
export interface WorkingProgressEntry {
  readonly note: string;
  readonly turnId: string | null;
  /** The turn has started a tool step (the server's `toolStep`). */
  readonly toolStep?: boolean | undefined;
}

/**
 * The note to show for a working chat, or undefined. Only a note read from the
 * turn the chat's shell reports as its latest.
 */
export function currentProgressNote(
  entry: WorkingProgressEntry | undefined,
  shell: { readonly latestTurn?: { readonly turnId: string } | null },
): string | undefined {
  if (entry === undefined) return undefined;
  return entry.turnId === (shell.latestTurn?.turnId ?? null) ? entry.note : undefined;
}

/**
 * The chat's current turn has started a tool step, so it is working, not
 * thinking, even before its first line of text.
 */
export function currentTurnHasToolStep(
  entry: WorkingProgressEntry | undefined,
  shell: { readonly latestTurn?: { readonly turnId: string } | null },
): boolean {
  if (entry === undefined || entry.toolStep !== true) return false;
  return entry.turnId === (shell.latestTurn?.turnId ?? null);
}

/** How long to hold a read that is due, so reads stay at least {@link PROGRESS_REFRESH_MS} apart. */
export function progressRefreshDelayMs(lastRefreshMs: number, nowMs: number): number {
  return Math.max(0, lastRefreshMs + PROGRESS_REFRESH_MS - nowMs);
}
