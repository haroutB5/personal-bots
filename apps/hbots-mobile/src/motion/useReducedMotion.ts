import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

import { createReducedMotionStore } from "./reducedMotionStore";

const store = createReducedMotionStore(AccessibilityInfo);

/**
 * True when Android "Remove animations" is on. Under it an enter sets its final
 * value and starts nothing, so no element waits at opacity 0 (a077fdd2aa).
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false);
}

export function reducedMotionNow(): boolean {
  return store.getSnapshot();
}
