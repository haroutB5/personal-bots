import { type ReactNode, Suspense, useEffect, useState } from "react";

import { perfOptimizationOn, whenIdle } from "~/features/personal/perfFlags";

import { ChunkLoadBoundary } from "./ChunkLoadBoundary";

/**
 * How long after mount the deferred boot pieces wait at the least. Long enough
 * that an owner who opens a chat soon after launch (a few seconds in, before
 * touching anything else) does so before this code loads, not during it.
 */
export const DEFERRED_MOUNT_MIN_MS = 8_000;
/** How long the owner must leave the screen alone before they load. */
export const DEFERRED_MOUNT_QUIET_MS = 2_000;

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Calls `work` once the app is quiet: DEFERRED_MOUNT_MIN_MS after the call,
 * then DEFERRED_MOUNT_QUIET_MS with no touch, click, key or wheel input (each
 * one starts the wait again, so a tap and the navigation it starts are never
 * shared with this work), then at an idle moment. Returns a cancel function.
 */
export function whenQuiet(work: () => void): () => void {
  let timer = 0;
  let cancelIdle: (() => void) | null = null;
  let earliest = Date.now() + DEFERRED_MOUNT_MIN_MS;
  const arm = () => {
    window.clearTimeout(timer);
    cancelIdle?.();
    cancelIdle = null;
    const wait = Math.max(earliest - Date.now(), DEFERRED_MOUNT_QUIET_MS);
    timer = window.setTimeout(() => {
      cancelIdle = whenIdle(() => {
        stop();
        work();
      });
    }, wait);
  };
  const onInput = () => {
    earliest = Math.max(earliest, Date.now());
    arm();
  };
  const stop = () => {
    window.clearTimeout(timer);
    cancelIdle?.();
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, true);
  };
  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, onInput, { capture: true, passive: true });
  }
  arm();
  return stop;
}

/**
 * Mounts `children` (lazy components that draw nothing at first) once the app
 * is quiet (whenQuiet). Their code then loads and evaluates away from the
 * first paint and from the owner's taps. Everything they open on (a sign-in,
 * an install request, an SSH prompt, the theme editor) is state that outlives
 * them, so a later mount misses nothing. Kill switch: bots:perf-off =
 * "lean-boot" mounts them at once.
 */
export function DeferredMount({ children }: { readonly children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(() => !perfOptimizationOn("lean-boot"));
  useEffect(() => {
    if (ready) return;
    return whenQuiet(() => setReady(true));
  }, [ready]);
  // A chunk that cannot be fetched (the phone lost its network after the page
  // opened) leaves its piece out; it must not replace the screen with an error.
  return ready ? (
    <ChunkLoadBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </ChunkLoadBoundary>
  ) : null;
}
