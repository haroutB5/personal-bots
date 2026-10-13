import { useSyncExternalStore } from "react";

/**
 * The needs-you count, published by the home screen and read by the tab bar's
 * badge. Module state, so the tab bar never runs a second derivation and never
 * opens its own queries: the home computes the number once (needsYou.ts) and
 * hands it over here.
 *
 * The value survives the home unmounting (the Tasks tab keeps the badge), and
 * the last published number is what the badge shows until the home mounts
 * again and republishes. Starting at 0 means no badge rather than a wrong one.
 */
let count = 0;
const listeners = new Set<() => void>();

/** Called by the home after every store change; no-op when nothing moved. */
export function publishNeedsYouCount(next: number): void {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener();
}

/** Test hook. */
export function resetNeedsYouCount(): void {
  publishNeedsYouCount(0);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current value, outside React (tests, the badge's server-side checks). */
export function readNeedsYouCount(): number {
  return count;
}

function read(): number {
  return count;
}

export function useNeedsYouCount(): number {
  return useSyncExternalStore(subscribe, read, read);
}
