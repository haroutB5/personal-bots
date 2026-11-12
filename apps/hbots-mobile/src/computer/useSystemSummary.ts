import type { SystemSummary } from "@hbots/personal-client/computer/systemStats";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { startSummaryPoller } from "./systemSummaryPoller";

/**
 * The host's CPU, memory, disk, sensors and gaming PC. One poller per mounted
 * caller; a failed read retries slower, the last good summary stays on screen,
 * and nothing is asked while the app is in the background.
 */
export function useSystemSummary(native: NativePersonal): SystemSummary | null {
  const [summary, setSummary] = useState<SystemSummary | null>(null);

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
