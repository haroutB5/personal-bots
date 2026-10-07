import { useSyncExternalStore } from "react";

/**
 * Whether a usage probe is running anywhere on this page. The Chats strip asks
 * for the first reading and the sheet asks again on open and on the refresh
 * button; the sheet shows "Refreshing" beside each card's Updated line for all
 * of them, not just the ones it started itself.
 */
let inFlight = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Mark a probe as running; call the returned function once it settles. */
export function beginUsageRefresh(): () => void {
  inFlight += 1;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    emit();
  };
}

/** Run a probe promise with the in-flight mark held for its whole life. */
export function trackUsageRefresh<T>(probe: Promise<T>): Promise<T> {
  const end = beginUsageRefresh();
  return probe.finally(end);
}

/** Test hook: forget every probe in flight. */
export function resetUsageRefresh(): void {
  inFlight = 0;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUsageRefreshing(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inFlight > 0,
    () => false,
  );
}
