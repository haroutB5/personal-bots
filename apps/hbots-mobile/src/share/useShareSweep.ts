import { useEffect } from "react";
import { Linking } from "react-native";

import { discardStaleShares } from "./shareIntake";
import { shareToKeepAtStart } from "./unpairedShare";

/** Once per process: delete share intakes left by an earlier run. */
export function useShareSweepAtStart(): void {
  useEffect(() => {
    void Linking.getInitialURL()
      .catch(() => null)
      .then((url) => discardStaleShares(shareToKeepAtStart(url)));
  }, []);
}
