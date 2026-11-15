import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

const SEEN_AT_STORAGE_ID = "hbots-work-seen-at";

/**
 * The server clock when the owner last left the Work tab. Kept as the server's
 * `asOf`, never the phone's clock, so skew can neither hide nor repeat events.
 */
let current: string | null = null;
let loaded = false;
let loading: Promise<string | null> | null = null;
const listeners = new Set<() => void>();

const parseSeenAt = (value: string | null): string | null =>
  value !== null && Number.isFinite(Date.parse(value)) ? value : null;

function publish(next: string | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function currentSeenAt(): string | null {
  return current;
}

export function seenAtIsLoaded(): boolean {
  return loaded;
}

/** For tests: back to the state before the first read. */
export function resetSeenAtForTests(): void {
  current = null;
  loaded = false;
  loading = null;
  listeners.clear();
}

/** Reads the saved marker once. A failed or damaged read counts as the first run. */
export function ensureSeenAtLoaded(): Promise<string | null> {
  if (loaded) return Promise.resolve(current);
  loading ??= (async () => {
    let next: string | null = null;
    try {
      next = parseSeenAt(await SecureStore.getItemAsync(SEEN_AT_STORAGE_ID));
    } catch {
      // First run: the box stays hidden and the first response stores asOf.
    }
    loading = null;
    loaded = true;
    publish(next);
    return next;
  })();
  return loading;
}

export async function saveSeenAt(value: string): Promise<void> {
  loaded = true;
  publish(value);
  try {
    await SecureStore.setItemAsync(SEEN_AT_STORAGE_ID, value);
  } catch {
    // The marker holds for this run; the next launch reads the older one.
  }
}

export function subscribeSeenAt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSeenAt(): string | null {
  return useSyncExternalStore(subscribeSeenAt, currentSeenAt, currentSeenAt);
}

export function useSeenAtLoaded(): boolean {
  return useSyncExternalStore(subscribeSeenAt, seenAtIsLoaded, seenAtIsLoaded);
}
