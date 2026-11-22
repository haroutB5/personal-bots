import { useEffect, useState } from "react";
import { AppState } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import type { PhoneSystemSummary } from "./serverStats";
import { startSummaryPoller } from "./systemSummaryPoller";

/**
 * The laptop's CPU, memory, disk and sensors, and the app server's stats and app health. One poller per mounted
 * caller; a failed read retries slower, the last good summary stays on screen,
 * and nothing is asked while the app is in the background.
 */
export function useSystemSummary(native: NativePersonal): PhoneSystemSummary | null {
  const [summary, setSummary] = useState<PhoneSystemSummary | null>(null);

  useEffect(() => {
    const poller = startSummaryPoller({
      read: () => native.readSystemSummary(),
      onSummary: setSummary,
      initiallyActive: AppState.currentState === "active",
    });
    const subscription = AppState.addEventListener("change", (state) => {
      poller.appStateChanged(state === "active");
    });
    return () => {
      subscription.remove();
      poller.stop();
    };
  }, [native]);

  return summary;
}
