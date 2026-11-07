import type { Cancel } from "./cancel.ts";

/**
 * Synchronous on purpose: the outbox writes a tap before its handler returns and the bots
 * list paints from the cache in the first frame.
 * `subscribe` reports a change made by another holder of the same store, such as another
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  subscribe(listener: (key: string | null) => void): Cancel;
}
