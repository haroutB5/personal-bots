import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, BackHandler } from "react-native";

import { setRecentsBlanked } from "../platform/secureStorage";
import { createLockController, type LockView } from "./appLock";
import { authenticate } from "./deviceAuth";
import { currentLock, loadLock, subscribeLock } from "./lockSetting";

/** The lock for a signed-in session; see {@link createLockController}. */
export function useAppLock(): LockView & {
  readonly unlock: () => void;
  readonly coveredNow: () => boolean;
} {
  const [controller] = useState(() =>
    createLockController({ authenticate, blankRecents: setRecentsBlanked, now: Date.now }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.view, controller.view);

  useEffect(() => {
    let live = true;
    const stopSetting = subscribeLock(() => controller.setLock(currentLock()));
    void loadLock().then((saved) => {
      if (live) controller.start(saved);
    });
    const appState = AppState.addEventListener("change", (next) =>
      controller.presence(next === "active" ? "foreground" : "background"),
    );
    return () => {
      live = false;
      stopSetting();
      appState.remove();
      controller.dispose();
    };
  }, [controller]);

  const { locked } = view;
  useEffect(() => {
    if (!locked) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      BackHandler.exitApp();
      return true;
    });
    return () => back.remove();
  }, [locked]);

  return { ...view, unlock: controller.unlock, coveredNow: controller.coveredNow };
}
