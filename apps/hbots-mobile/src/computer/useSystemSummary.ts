import type { SystemSummary } from "@hbots/personal-client/computer/systemStats";
import { useEffect, useRef, useState } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";

const POLL_MS = 10_000;
const RETRY_MS = 30_000;

/**
 * The host's CPU, memory, disk and sensors. One poller per mounted caller; a
 * failed read retries slower, and the last good summary stays on screen.
 */
export function useSystemSummary(native: NativePersonal): SystemSummary | null {
  const [summary, setSummary] = useState<SystemSummary | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = (delay: number) => {
      if (!mounted.current) return;
      timer = setTimeout(() => void ask(), delay);
    };

    const ask = async () => {
      if (!mounted.current || inFlight) return;
      inFlight = true;
      const next = await native.readSystemSummary();
      inFlight = false;
      if (!mounted.current) return;
      if (next === null) {
        schedule(RETRY_MS);
        return;
      }
      setSummary(next);
      schedule(POLL_MS);
    };

    void ask();
    return () => {
      mounted.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [native]);

  return summary;
}
