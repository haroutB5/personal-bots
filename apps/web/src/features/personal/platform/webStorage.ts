import type { KeyValueStore } from "@hbots/personal-client/ports/keyValueStore";

function browserKeyValueStore(area: () => Storage | null): KeyValueStore {
  const areaOrNull = (): Storage | null => {
    try {
      return area() ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem: (key) => {
      try {
        return areaOrNull()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => areaOrNull()?.setItem(key, value),
    removeItem: (key) => areaOrNull()?.removeItem(key),
    subscribe: (listener) => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
        return () => undefined;
      }
      const onStorage = (event: StorageEvent) => {
        if (event.storageArea === null || event.storageArea === areaOrNull()) listener(event.key);
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}

export const webKeyValueStore: KeyValueStore = browserKeyValueStore(() => globalThis.localStorage);

export const webSessionKeyValueStore: KeyValueStore = browserKeyValueStore(
  () => globalThis.sessionStorage,
);

/**
 * Runs `work` when the main thread is idle, or after `fallbackMs` where the
 * browser has no requestIdleCallback (iOS Safari). Returns a cancel function.
 */
export function whenIdle(work: () => void, fallbackMs = 1_500): () => void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(work, { timeout: fallbackMs * 2 });
    return () =>
      (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(work, fallbackMs);
  return () => clearTimeout(handle);
}
