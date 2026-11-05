import { MEMORY_LAST_SEEN_KEY } from "@hbots/personal-client/memory/memoryPresentation";

export * from "@hbots/personal-client/memory/memoryPresentation";

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
