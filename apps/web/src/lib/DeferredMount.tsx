import { type ReactNode, Suspense, useEffect, useState } from "react";

import { perfOptimizationOn, whenIdle } from "~/features/personal/perfFlags";

/** How long after mount the deferred boot pieces wait before loading. */
export const DEFERRED_MOUNT_MIN_MS = 3_000;

/**
 * Mounts `children` (lazy components that draw nothing at first) once the app
 * has settled: at least DEFERRED_MOUNT_MIN_MS after boot, then at an idle
 * moment. Their code then loads and evaluates away from the first paint and
 * the owner's first tap. Everything they open on (a sign-in, an install
 * request, an SSH prompt, the theme editor) is state that outlives them, so a
 * later mount misses nothing. Kill switch: bots:perf-off = "lean-boot" mounts
 * them at once.
 */
export function DeferredMount({ children }: { readonly children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(() => !perfOptimizationOn("lean-boot"));
  useEffect(() => {
    if (ready) return;
    let cancelIdle: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancelIdle = whenIdle(() => setReady(true));
    }, DEFERRED_MOUNT_MIN_MS);
    return () => {
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [ready]);
  return ready ? <Suspense fallback={null}>{children}</Suspense> : null;
}
