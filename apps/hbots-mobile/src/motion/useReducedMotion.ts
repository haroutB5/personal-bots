import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

import { createReducedMotionStore, type ReducedMotionStore } from "./reducedMotionStore";

let store: ReducedMotionStore | null = null;

function reducedMotionStore(): ReducedMotionStore {
  store ??= createReducedMotionStore(AccessibilityInfo);
  return store;
}

/**
 * True when Android "Remove animations" or the developer animation scale of 0
 * is on. Every motion in the app reads this one value. Under it an enter sets
 * its final value with `setValue` and starts nothing, a loop never starts, and
 * no element waits for a frame at opacity 0 (a077fdd2aa).
 */
export function useReducedMotion(): boolean {
  const source = reducedMotionStore();
  return useSyncExternalStore(source.subscribe, source.getSnapshot, () => false);
}

export function reducedMotionNow(): boolean {
  return reducedMotionStore().getSnapshot();
}
