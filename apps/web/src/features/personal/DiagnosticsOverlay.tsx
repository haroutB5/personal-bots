import type { JSX } from "react";
import { useEffect, useState } from "react";

import { runningClientEntry } from "./appVersion";

const FLAG_KEY = "personal-diagnostics";

/** Settings-toggled flag, read fresh per mount (no live sync needed). */
export function diagnosticsEnabled(): boolean {
  try {
    return window.localStorage.getItem(FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDiagnosticsEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(FLAG_KEY, "1");
    else window.localStorage.removeItem(FLAG_KEY);
  } catch {
    // Storage unavailable: the overlay simply stays off.
  }
}

interface Metrics {
  readonly innerHeight: number;
  readonly vvHeight: number;
  readonly offsetTop: number;
  readonly scrollY: number;
}

function readMetrics(): Metrics {
  const viewport = window.visualViewport;
  return {
    innerHeight: window.innerHeight,
    vvHeight: viewport ? Math.round(viewport.height) : -1,
    offsetTop: viewport ? Math.round(viewport.offsetTop) : -1,
    scrollY: Math.round(window.scrollY),
  };
}

/**
 * On-device debugging readout for the keyboard/viewport work: a screenshot of
 * this line tells us what iOS actually reported. Rendered only when the
 * Settings > Diagnostics toggle is on.
 */
export function DiagnosticsOverlay(): JSX.Element {
  const [metrics, setMetrics] = useState<Metrics>(() => readMetrics());
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => setMetrics(readMetrics());
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, []);
  const entry = runningClientEntry(document);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed top-1/3 left-2 z-50 rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-3 text-white"
    >
      ih:{metrics.innerHeight} vv:{metrics.vvHeight} off:{metrics.offsetTop} sy:
      {metrics.scrollY} covered:{metrics.innerHeight - metrics.vvHeight - metrics.offsetTop}
      <br />
      js:{entry ?? "unknown"}
    </div>
  );
}
