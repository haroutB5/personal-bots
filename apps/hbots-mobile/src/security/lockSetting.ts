import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import { LOCK_OFF, parseLock, serializeLock, type Lock } from "./appLock";

const LOCK_STORAGE_ID = "hbots.applock.v1";

let current: Lock = LOCK_OFF;
// `current` is Off until the saved setting is read. Anything that acts on the lock (the notification
// policy sent to native) must wait for this, or it would report "lock off" for a lock that is on.
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: Lock): void {
  current = next;
  for (const listener of listeners) listener();
}

export function currentLock(): Lock {
  return current;
}

/** True once the saved setting was read (or the owner chose one this run). */
export function lockIsLoaded(): boolean {
  return loaded;
}

/** For tests: back to the state before the first read. */
export function resetLockForTests(): void {
  current = LOCK_OFF;
  loaded = false;
  listeners.clear();
}

/** Reads the saved setting. A read that fails counts as Off. */
export async function loadLock(): Promise<Lock> {
  let next = LOCK_OFF;
  try {
    next = parseLock(await SecureStore.getItemAsync(LOCK_STORAGE_ID));
  } catch {
    // Off: a damaged setting never locks the user out.
  }
  loaded = true;
  publish(next);
  return next;
}

export async function saveLock(next: Lock): Promise<void> {
  loaded = true;
  publish(next);
  try {
    await SecureStore.setItemAsync(LOCK_STORAGE_ID, serializeLock(next));
  } catch {
    // The choice holds for this run; the next launch falls back to Off.
  }
}

export function subscribeLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLockSetting(): Lock {
  return useSyncExternalStore(subscribeLock, currentLock, currentLock);
}
