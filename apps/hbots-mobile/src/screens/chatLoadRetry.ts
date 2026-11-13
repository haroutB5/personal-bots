/**
 * A chat that fails to load is asked for again by itself before the phone says so. One slow
 * moment on the server (a restart, a backup, a busy laptop) used to leave "Couldn't load this
 * chat" on screen until a tap; now the error only shows once these waits are used up.
 */
const CHAT_LOAD_RETRY_DELAYS_MS: ReadonlyArray<number> = [2_000, 6_000, 12_000];

/** How long to wait before retry number `attempt` (0-based), or null when it is time to give up. */
export const chatLoadRetryDelayMs = (attempt: number): number | null =>
  CHAT_LOAD_RETRY_DELAYS_MS[attempt] ?? null;
