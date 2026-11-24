import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import type { PhoneSystemSummary } from "./serverStats";
import { startSummaryPoller, type SummaryPoller } from "./systemSummaryPoller";

type SummaryListener = (summary: PhoneSystemSummary | null) => void;

export interface SummaryStoreSource {
  readonly readSystemSummary: () => Promise<PhoneSystemSummary | null>;
}

export interface SummaryStoreAppState {
  readonly isActive: () => boolean;
  readonly subscribe: (onChange: (active: boolean) => void) => () => void;
}

interface SummaryStore {
  latest: PhoneSystemSummary | null;
  readonly listeners: Set<SummaryListener>;
  poller: SummaryPoller | null;
  stopAppState: (() => void) | null;
}

const nativeAppState: SummaryStoreAppState = {
  isActive: () => AppState.currentState === "active",
  subscribe: (onChange) => {
    const subscription = AppState.addEventListener("change", (state) => {
      onChange(state === "active");
    });
    return () => subscription.remove();
  },
};

/**
 * Creates a ref-counted system-summary registry keyed by client instance.
 * Every mounted caller on the same client shares one poller and sees the last
 * reading on first render, avoiding duplicate 10 s requests and layout jumps.
 */
export function createSystemSummaryRegistry(appState: SummaryStoreAppState = nativeAppState) {
  const stores = new WeakMap<SummaryStoreSource, SummaryStore>();

  const storeFor = (source: SummaryStoreSource): SummaryStore => {
    let store = stores.get(source);
    if (store === undefined) {
      store = {
        latest: null,
        listeners: new Set(),
        poller: null,
        stopAppState: null,
      };
      stores.set(source, store);
    }
    return store;
  };

  const getSnapshot = (source: SummaryStoreSource): PhoneSystemSummary | null =>
    stores.get(source)?.latest ?? null;

  const subscribe = (source: SummaryStoreSource, listener: SummaryListener): (() => void) => {
    const store = storeFor(source);
    store.listeners.add(listener);

    if (store.poller === null) {
      const poller = startSummaryPoller({
        read: () => source.readSystemSummary(),
        onSummary: (next) => {
          store.latest = next;
          for (const notify of store.listeners) {
            notify(next);
          }
        },
        initiallyActive: appState.isActive(),
      });
      store.poller = poller;
      store.stopAppState = appState.subscribe((active) => {
        poller.appStateChanged(active);
      });
    }

    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        store.stopAppState?.();
        store.stopAppState = null;
        store.poller?.stop();
        store.poller = null;
      }
    };
  };

  return { getSnapshot, subscribe };
}

const sharedRegistry = createSystemSummaryRegistry();

/**
 * The laptop's CPU, memory, disk and sensors, and the app server's stats and
 * app health. Shared across all mounted callers for a given `NativePersonal`
 * instance so only one poller runs at a time and late mounts paint immediately.
 */
export function useSystemSummary(native: NativePersonal): PhoneSystemSummary | null {
  return useSyncExternalStore(
    (onStoreChange) => sharedRegistry.subscribe(native, () => onStoreChange()),
    () => sharedRegistry.getSnapshot(native),
  );
}
