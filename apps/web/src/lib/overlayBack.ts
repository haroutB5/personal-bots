/**
 * Android Back closes the open sheet, menu or dialog first.
 *
 * On Android Chrome the Back gesture is a history step. Without help, Back with
 * a bottom sheet open leaves the screen and the sheet's state is lost. While an
 * overlay is open it owns one extra history entry (a "sentinel": the same URL,
 * a state flag), so Back pops that entry and the popstate is used to close the
 * overlay instead of reaching the router.
 *
 * The router (TanStack history, wrapped by botsBackStack) never sees a sentinel:
 *
 * - it is written with the browser's own pushState, which the router has not
 *   patched, so the router's idea of the current entry stays the page under it;
 * - the popstate that removes it is swallowed in the capture phase, before the
 *   router's listener;
 * - before the router pushes, replaces or steps back (`afterCollapse`), a
 *   sentinel on top of the stack is popped first, so a sheet row that opens a
 *   chat leaves exactly the history it did before ("Back from a chat goes to
 *   /bots", "Back from a Team page returns to Team");
 * - a sentinel left behind by an overlay that was closed with a tap is reused
 *   by the next overlay, and skipped by Back (one extra silent step) when
 *   nothing reuses it.
 *
 * - Chrome treats a history entry written without a user gesture as one Back
 *   should skip, and a Back with nothing else to land on closes the tab. So a
 *   sentinel is only written while the user's gesture is fresh; an overlay that
 *   opens without one (a sheet restored by Back) gets its sentinel on the next
 *   tap or key press.
 *
 * Only touch devices that are not iOS get this (`overlayBackSupported`): iOS has
 * its own swipe-back and is left alone.
 */

const FLAG = "personalOverlayDepth";
/** Gives up waiting for the popstate of a collapse and runs the navigation anyway. */
export const COLLAPSE_TIMEOUT_MS = 400;

interface BackHistory {
  readonly state: unknown;
  go(delta: number): void;
  back(): void;
}

type GestureEvent = "pointerup" | "keydown" | "click";

interface BackWindow {
  readonly history: BackHistory;
  readonly location: { readonly href: string };
  addEventListener(
    type: "popstate",
    listener: (event: BackPopEvent) => void,
    capture: boolean,
  ): void;
  addEventListener(type: GestureEvent, listener: () => void, capture: boolean): void;
  removeEventListener(
    type: "popstate",
    listener: (event: BackPopEvent) => void,
    capture: boolean,
  ): void;
  removeEventListener(type: GestureEvent, listener: () => void, capture: boolean): void;
}

interface BackPopEvent {
  stopImmediatePropagation(): void;
}

type StateWriter = (this: unknown, state: unknown, title: string, url: string) => void;

export interface OverlayBackOptions {
  /** The browser's own pushState (History.prototype), not the router-patched one. */
  readonly pushState: StateWriter;
  /** The browser's own replaceState (History.prototype). */
  readonly replaceState: StateWriter;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** True while the user's gesture is fresh enough to write a history entry Chrome will not skip. */
  readonly gestureIsFresh?: () => boolean;
}

export interface OverlayBack {
  /**
   * An overlay opened. `close` closes it; it is called when Back pops the
   * overlay's entry. The returned function is called when the overlay closes
   * by any route.
   */
  register(close: () => void): () => void;
  /** Runs `run` now, or once a sentinel on top of the history has been popped. */
  afterCollapse(run: () => void): void;
  dispose(): void;
}

function flagOf(state: unknown): number {
  if (typeof state !== "object" || state === null) return 0;
  const value = (state as Record<string, unknown>)[FLAG];
  return typeof value === "number" && value > 0 ? value : 0;
}

function withoutFlag(state: unknown): Record<string, unknown> {
  const next = { ...(typeof state === "object" && state !== null ? state : {}) } as Record<
    string,
    unknown
  >;
  delete next[FLAG];
  return next;
}

interface OpenOverlay {
  /** The sentinel this overlay's Back pops; 0 once it has no sentinel (collapsed away). */
  depth: number;
  readonly close: () => void;
  /** Opened without a fresh gesture: its sentinel is written on the next one. */
  waiting: boolean;
}

export function createOverlayBack(win: BackWindow, options: OverlayBackOptions): OverlayBack {
  const schedule = options.setTimeout ?? ((run, ms) => setTimeout(run, ms));
  const cancel =
    options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const gestureIsFresh = options.gestureIsFresh ?? (() => true);
  const overlays: OpenOverlay[] = [];
  /** Open overlays that have no sentinel yet because they opened without a gesture. */
  let waitingForGesture = false;
  let lastFlag = flagOf(win.history.state);
  // A silent step Back took through a sentinel nobody owned.
  let skipping = false;
  let collapse: { waiters: Array<() => void>; timer: unknown } | null = null;

  // A reload on a sentinel entry leaves a flag with no overlay behind it.
  if (lastFlag > 0) {
    options.replaceState.call(win.history, withoutFlag(win.history.state), "", win.location.href);
    lastFlag = 0;
  }

  const owns = (depth: number) => overlays.some((overlay) => overlay.depth === depth);

  const finishCollapse = () => {
    const done = collapse;
    if (done === null) return;
    collapse = null;
    cancel(done.timer);
    for (const run of done.waiters) run();
  };

  const onPop = (event: BackPopEvent) => {
    const leaving = lastFlag;
    const landing = flagOf(win.history.state);
    lastFlag = landing;

    if (collapse !== null) {
      event.stopImmediatePropagation();
      if (landing === 0) finishCollapse();
      else win.history.go(-landing);
      return;
    }

    if (landing >= leaving) {
      skipping = false;
      // Landed on a sentinel from above (a stale one under a page): step over it.
      if (landing > leaving && !owns(landing)) {
        event.stopImmediatePropagation();
        skipping = true;
        win.history.back();
      }
      return;
    }

    // Back popped one or more sentinels.
    event.stopImmediatePropagation();
    const closing = overlays.filter((overlay) => overlay.depth > landing);
    if (closing.length > 0) {
      skipping = false;
      closing.sort((a, b) => b.depth - a.depth);
      for (const overlay of closing) overlay.close();
      return;
    }
    // An empty sentinel: Back meant "leave this page", so take that step too.
    skipping = true;
    win.history.back();
  };

  const GESTURES: readonly GestureEvent[] = ["pointerup", "keydown", "click"];

  /** Gives `overlay` its sentinel: reuses a stale one on top, or writes a new one. */
  const placeSentinel = (overlay: OpenOverlay) => {
    const top = flagOf(win.history.state);
    if (top > 0 && !owns(top)) {
      overlay.depth = top;
    } else {
      overlay.depth = top + 1;
      options.pushState.call(
        win.history,
        { ...withoutFlag(win.history.state), [FLAG]: overlay.depth },
        "",
        win.location.href,
      );
    }
    lastFlag = overlay.depth;
  };

  const onGesture = () => {
    if (collapse !== null || !gestureIsFresh()) return;
    stopWaiting();
    for (const overlay of overlays) {
      if (overlay.depth === 0 && overlay.waiting) {
        overlay.waiting = false;
        placeSentinel(overlay);
      }
    }
  };

  const startWaiting = () => {
    if (waitingForGesture) return;
    waitingForGesture = true;
    for (const type of GESTURES) win.addEventListener(type, onGesture, true);
  };

  function stopWaiting() {
    if (!waitingForGesture) return;
    waitingForGesture = false;
    for (const type of GESTURES) win.removeEventListener(type, onGesture, true);
  }

  win.addEventListener("popstate", onPop, true);

  return {
    register(close) {
      const overlay: OpenOverlay = { depth: 0, close, waiting: false };
      if (collapse === null) {
        if (gestureIsFresh()) {
          placeSentinel(overlay);
        } else {
          overlay.waiting = true;
          startWaiting();
        }
      }
      overlays.push(overlay);
      return () => {
        const at = overlays.indexOf(overlay);
        if (at !== -1) overlays.splice(at, 1);
        if (!overlays.some((open) => open.waiting)) stopWaiting();
      };
    },
    afterCollapse(run) {
      if (collapse !== null) {
        collapse.waiters.push(run);
        return;
      }
      const depth = flagOf(win.history.state);
      if (depth === 0) {
        skipping = false;
        run();
        return;
      }
      for (const overlay of overlays) {
        overlay.depth = 0;
        overlay.waiting = false;
      }
      collapse = { waiters: [run], timer: schedule(finishCollapse, COLLAPSE_TIMEOUT_MS) };
      win.history.go(-depth);
    },
    dispose() {
      win.removeEventListener("popstate", onPop, true);
      stopWaiting();
      finishCollapse();
    },
  };
}

/** True while a silent step through an empty sentinel is under way (tests). */
export function isSentinelState(state: unknown): boolean {
  return flagOf(state) > 0;
}

/** Touch devices that are not iOS: the Android Back gesture is a history step there. */
export function overlayBackSupported(env: {
  readonly coarsePointer: boolean;
  readonly hasNavigatorStandalone: boolean;
}): boolean {
  return env.coarsePointer && !env.hasNavigatorStandalone;
}

let active: OverlayBack | null = null;

/** The installed controller, or null where Back is left alone. */
export function getOverlayBack(): OverlayBack | null {
  return active;
}

/**
 * Call once after the router's history exists. Returns a function that waits
 * out a sentinel before it runs a navigation (see `afterCollapse`).
 */
export function installOverlayBack(): OverlayBack | null {
  if (active !== null) return active;
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  const supported = overlayBackSupported({
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    hasNavigatorStandalone: "standalone" in navigator,
  });
  if (!supported) return null;
  const proto = Object.getPrototypeOf(window.history) as History;
  active = createOverlayBack(window as unknown as BackWindow, {
    pushState: proto.pushState as StateWriter,
    replaceState: proto.replaceState as StateWriter,
    gestureIsFresh: () => navigator.userActivation?.isActive ?? true,
  });
  return active;
}

/** Test seam: forget the installed controller. */
export function resetOverlayBackForTests(): void {
  active?.dispose();
  active = null;
}

type HistoryMethod = "push" | "replace" | "back" | "go" | "forward";

/**
 * Makes the router's history pop a sentinel before it navigates. The history is
 * the object botsBackStack already patched; each method keeps its signature.
 */
export function collapseBeforeNavigating<
  H extends Record<HistoryMethod, (...args: never[]) => void>,
>(history: H, overlayBack: OverlayBack): H {
  for (const method of ["push", "replace", "back", "go", "forward"] as const) {
    const original = history[method] as (...args: unknown[]) => void;
    (history as Record<HistoryMethod, unknown>)[method] = (...args: unknown[]) => {
      overlayBack.afterCollapse(() => original.apply(history, args));
    };
  }
  return history;
}
