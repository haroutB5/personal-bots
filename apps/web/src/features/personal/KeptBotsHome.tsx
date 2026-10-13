import { Activity, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { perfOptimizationOn, whenIdle } from "./perfFlags";

/** Keep Activity's effect cleanup, but retain the browser's cached home layout. */
export function KeptBotsHome({ shown, children }: { shown: boolean; children: ReactNode }) {
  const [retainLayout] = useState(
    () =>
      perfOptimizationOn("home-back-layout") &&
      typeof CSS !== "undefined" &&
      CSS.supports("content-visibility", "hidden"),
  );
  const [asleep, setAsleep] = useState(false);
  if (shown && asleep) setAsleep(false);
  useEffect(() => {
    if (shown) return;
    return whenIdle(() => setAsleep(true), 1_000);
  }, [shown]);
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!retainLayout || !asleep || shown) return;
    // Activity has already disconnected descendant effects in this commit.
    // It also writes inline display:none!important on this one stable host.
    // Replace that write after the mutation phase: our outer wrapper hides
    // the content, while the browser retains its layout for Back.
    const content = rootRef.current?.firstElementChild;
    if (!content || !(content instanceof HTMLElement)) return;
    const restoreDisplay = () => {
      if (content.style.display === "none") content.style.setProperty("display", "block");
    };
    restoreDisplay();
    // Activity can finish hiding its host in a later commit without rendering
    // this parent again. Watch only that host while asleep; changing its style
    // does not reconnect Activity's descendant effects.
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(restoreDisplay);
    observer.observe(content, { attributes: true, attributeFilter: ["style"] });
    return () => observer.disconnect();
  }, [retainLayout, asleep, shown]);
  useEffect(() => {
    const node = rootRef.current;
    if (!retainLayout || !node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      // Keep the measured placeholder on the DOM node, without a home render
      // or a synchronous layout read when navigation hides the list.
      if (entry && !node.inert)
        node.style.containIntrinsicSize = `auto ${entry.contentRect.height}px`;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [retainLayout]);

  return (
    <div
      ref={rootRef}
      data-kept-bots-home=""
      data-kept-asleep={asleep && !shown ? "" : undefined}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
      className={retainLayout ? "min-h-full" : undefined}
      style={
        retainLayout
          ? {
              contentVisibility: shown ? "visible" : "hidden",
              // The chat uses this same scroller. Keep the cached home out of its
              // flow while hidden so it cannot add space or change the chat scroll.
              position: shown ? undefined : "absolute",
              top: shown ? undefined : 0,
              width: "100%",
              // Absolute boxes still contribute scroll overflow. Clip the
              // hidden wrapper to zero without destroying its cached children.
              height: shown ? undefined : 0,
              minHeight: shown ? undefined : 0,
              overflow: shown ? undefined : "hidden",
            }
          : { display: shown ? "contents" : "none" }
      }
    >
      <Activity mode={shown || !asleep ? "visible" : "hidden"}>
        <div className={retainLayout ? "min-h-full" : "contents"}>{children}</div>
      </Activity>
    </div>
  );
}
