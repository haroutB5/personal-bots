import { MEMORY_LAST_SEEN_KEY } from "@hbots/personal-client/memory/presentation";

export * from "@hbots/personal-client/memory/presentation";

/**
 * Where the Memory screen keeps, on this device, when it was last opened.
 * Web only: the phone keeps its own cache.
 */
export function readMemoryLastSeen(): number | null {
  try {
    const raw = window.localStorage.getItem(MEMORY_LAST_SEEN_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeMemoryLastSeen(at: number): void {
  try {
    window.localStorage.setItem(MEMORY_LAST_SEEN_KEY, String(at));
  } catch {
    // Private mode: nothing is marked New next time.
  }
}
