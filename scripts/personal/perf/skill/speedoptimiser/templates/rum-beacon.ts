/**
 * Real-user timings, one small beacon per journey (speedoptimiser skill).
 *
 * The lab bench says where the time goes; this says what real users wait.
 * Send to an endpoint that ALLOWLISTS fields (journey name, ms, a few
 * booleans), caps body size and rate-limits per client, and logs only. Never
 * reflect or store free text from the client. Report p75 per journey.
 */
const ENDPOINT = "/api/perf-beacon";

let hiddenAt: number | null =
  typeof document !== "undefined" && document.visibilityState !== "visible" ? 0 : null;
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") hiddenAt = performance.now();
  });
}

/** Background time is not app time: skip journeys the page was hidden during. */
const hiddenSince = (start: number) => hiddenAt !== null && hiddenAt >= start;

export function beacon(
  journey: string,
  ms: number,
  extra: Record<string, boolean | string> = {},
): void {
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        journey,
        ms: Math.round(ms),
        warm: navigator.serviceWorker?.controller != null,
        ...extra,
      }),
    }).catch(() => undefined);
  } catch {
    // best-effort
  }
}

/** Load journey: call when the journey's content has rendered. Measures from navigation start to the paint. */
export function reportLoadJourney(journey: string): void {
  requestAnimationFrame((paintAt) => {
    if (!hiddenSince(0)) beacon(journey, paintAt);
  });
}

/** Interaction journey: `start()` on the input (pointerdown/submit), `end()` when the result is painted. */
export function interactionJourney(journey: string) {
  let startedAt: number | null = null;
  return {
    start: () => {
      startedAt = performance.now();
    },
    end: () => {
      const from = startedAt;
      startedAt = null;
      if (from === null) return;
      requestAnimationFrame((paintAt) => {
        if (!hiddenSince(from)) beacon(journey, paintAt - from);
      });
    },
  };
}
