import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { useLocation, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";

import { ChatsScreen } from "./ChatsScreen";
import {
  chatSwipeBackEnabled,
  EDGE_WIDTH_PX,
  EdgeSwipeTracker,
  nativeSwipeForced,
} from "./edgeSwipeBack";
import { PersonalTabBar } from "./PersonalTabBar";
import { isStandaloneDisplay } from "./serviceWorker";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";

const BOTS_ROUTE_ID = "/_personal/bots";
const SETTLE_MS = 220;
/** How far left the list starts, as iOS navigation does (share of the width). */
const PARALLAX = 0.3;

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "drag"; readonly offset: number }
  | { readonly kind: "settle"; readonly offset: number; readonly leaving: boolean };

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isTextEntry(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function scrollableAncestor(element: Element | null): Element | null {
  for (let node = element; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * An iOS-style edge swipe back to Bots for the phone shell, on chats in the
 * installed app (see edgeSwipeBack.ts for why the native one is replaced).
 * The shell puts `style` on its root and renders `layers` beside it. The Bots
 * list is rendered under the chat only while a swipe is on screen; letting go
 * past the threshold slides the chat off and goes to /bots exactly as the
 * Back arrow does, and the list stays underneath until the routed Bots page
 * has taken its place.
 */
export function useChatSwipeBack({ wide }: { readonly wide: boolean }): {
  readonly style: CSSProperties | undefined;
  readonly layers: ReactNode;
} {
  const router = useRouter();
  const navigate = useNavigate();
  const location = useLocation();
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId });
  const enabled = chatSwipeBackEnabled({
    pathname: location.pathname,
    state: location.state,
    standalone: isStandaloneDisplay(),
    wide,
    nativeForced: nativeSwipeForced(readStorage()),
  });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Outlives the strip (it goes when the address leaves the chat), so a route
  // that never lands cannot leave the chat off screen.
  const leaveFallback = useRef(0);
  useEffect(() => () => window.clearTimeout(leaveFallback.current), []);

  // The list under the chat must paint at once: keep its data and its route
  // chunk warm while a chat that can swipe is open.
  const environmentId = usePersonalEnvironmentId();
  usePersonalBotsList(enabled ? environmentId : null);
  useEffect(() => {
    if (enabled) void router.preloadRoute({ to: "/bots" }).catch(() => {});
  }, [enabled, router]);

  // Once the routed Bots page is what the column renders, the list beneath
  // has done its job; leaving the chat any other way mid-swipe (a
  // notification tap) drops the swipe. Both are settled during render, so the
  // list and the chat's offset go in the same commit as the route change.
  const pathname = location.pathname;
  const [seenPath, setSeenPath] = useState(pathname);
  const leaving = phase.kind === "settle" && phase.leaving;
  if (leaving && routeId === BOTS_ROUTE_ID) {
    setPhase({ kind: "idle" });
  } else if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (!leaving) setPhase({ kind: "idle" });
  }
  const shown: Phase = leaving && routeId === BOTS_ROUTE_ID ? { kind: "idle" } : phase;

  useEffect(() => {
    const strip = stripRef.current;
    if (!enabled || strip === null) return;
    let tracker: EdgeSwipeTracker | null = null;
    let scroller: Element | null = null;
    let timer = 0;

    const underStrip = (x: number, y: number): Element | null => {
      strip.style.pointerEvents = "none";
      try {
        return document.elementFromPoint(x, y);
      } finally {
        strip.style.pointerEvents = "";
      }
    };
    const onStart = (event: TouchEvent) => {
      // Stops iOS starting its own swipe with the stale snapshot.
      event.preventDefault();
      window.clearTimeout(leaveFallback.current);
      const touch = event.touches[0];
      if (event.touches.length !== 1 || touch === undefined) {
        tracker = null;
        setPhase({ kind: "idle" });
        return;
      }
      tracker = new EdgeSwipeTracker(
        { x: touch.clientX, y: touch.clientY, t: event.timeStamp },
        window.innerWidth,
      );
      scroller = null;
    };
    const onMove = (event: TouchEvent) => {
      event.preventDefault();
      const touch = event.touches[0];
      if (tracker === null || touch === undefined) return;
      const step = tracker.move({ x: touch.clientX, y: touch.clientY, t: event.timeStamp });
      if (step.kind === "drag") {
        setPhase({ kind: "drag", offset: step.offset });
      } else if (step.kind === "scroll") {
        scroller ??= scrollableAncestor(underStrip(touch.clientX, touch.clientY));
        scroller?.scrollBy(0, -step.dy);
      }
    };
    const onEnd = (event: TouchEvent) => {
      event.preventDefault();
      const current = tracker;
      tracker = null;
      if (current === null) return;
      const end = current.end(event.timeStamp);
      if (end.kind === "tap") {
        // The strip sits over the chat's left edge (the Back arrow among it).
        const target = underStrip(end.x, end.y);
        if (target === null) return;
        if (isTextEntry(target)) {
          target.focus();
          return;
        }
        // An icon inside a link or button is an SVG element, which has no click().
        target.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: end.x,
            clientY: end.y,
          }),
        );
        return;
      }
      if (end.kind === "scroll") return;
      if (end.kind === "cancel") {
        setPhase({ kind: "settle", offset: 0, leaving: false });
        timer = window.setTimeout(() => setPhase({ kind: "idle" }), SETTLE_MS);
        return;
      }
      setPhase({ kind: "settle", offset: window.innerWidth, leaving: true });
      timer = window.setTimeout(() => {
        // The arrow's own path: /bots is right behind, so this steps back.
        void navigate({ to: "/bots" });
        window.clearTimeout(leaveFallback.current);
        leaveFallback.current = window.setTimeout(() => setPhase({ kind: "idle" }), 2000);
      }, SETTLE_MS);
    };
    const onCancel = () => {
      tracker = null;
      setPhase({ kind: "idle" });
    };
    strip.addEventListener("touchstart", onStart, { passive: false });
    strip.addEventListener("touchmove", onMove, { passive: false });
    strip.addEventListener("touchend", onEnd, { passive: false });
    strip.addEventListener("touchcancel", onCancel);
    return () => {
      window.clearTimeout(timer);
      strip.removeEventListener("touchstart", onStart);
      strip.removeEventListener("touchmove", onMove);
      strip.removeEventListener("touchend", onEnd);
      strip.removeEventListener("touchcancel", onCancel);
    };
  }, [enabled, navigate]);

  const moving = shown.kind !== "idle";
  const offset = shown.kind === "idle" ? 0 : shown.offset;
  const width = typeof window === "undefined" ? 1 : window.innerWidth;
  const progress = Math.min(1, offset / width);
  const transition = shown.kind === "settle" ? `transform ${SETTLE_MS}ms ease-out` : "none";
  const chatStyle: CSSProperties | undefined = moving
    ? {
        position: "relative",
        zIndex: 1,
        transform: `translate3d(${offset}px, 0, 0)`,
        transition,
        boxShadow: "-8px 0 24px rgba(0, 0, 0, 0.18)",
      }
    : undefined;

  const layers = (
    <>
      {moving ? (
        <div
          data-swipe-underlay=""
          aria-hidden="true"
          inert
          className="personal-app fixed inset-0 flex flex-col overflow-hidden pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
          style={{
            transform: `translate3d(${-(1 - progress) * PARALLAX * 100}%, 0, 0)`,
            transition,
          }}
        >
          <div className="min-h-0 flex-1 overflow-hidden pt-[env(safe-area-inset-top)]">
            <ChatsScreen />
          </div>
          <PersonalTabBar active="chats" />
          <div
            className="pointer-events-none absolute inset-0 bg-black"
            style={{
              opacity: 0.12 * (1 - progress),
              transition: shown.kind === "settle" ? `opacity ${SETTLE_MS}ms ease-out` : "none",
            }}
          />
        </div>
      ) : null}
      {enabled ? (
        <div
          ref={stripRef}
          aria-hidden="true"
          data-swipe-edge=""
          className="fixed top-0 bottom-0 left-0 z-40"
          style={{ width: EDGE_WIDTH_PX, touchAction: "none" }}
        />
      ) : null}
    </>
  );
  return { style: chatStyle, layers };
}
