import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";

import { cn } from "~/lib/utils";

import { ComputerBrowserPane } from "./computer/ComputerScreen";
import {
  computerIsActiveForChat,
  computerPanelDetail,
  describeComputerState,
  type ComputerDotTone,
} from "./computer/computerModel";
import { useComputerFeed } from "./computer/computerState";

const DOT_CLASS: Record<ComputerDotTone, string> = {
  live: "bg-[var(--personal-live)]",
  pending: "bg-[var(--personal-review)]",
  problem: "bg-[var(--personal-danger)]",
  idle: "bg-[var(--personal-text-tertiary)]",
};

export function ConversationComputerPanel({
  environmentId,
  botId,
  threadId,
  manuallyVisible,
  expanded,
  onExpandedChange,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
  readonly threadId: string;
  readonly manuallyVisible: boolean;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}): JSX.Element | null {
  const { feed, error, loading } = useComputerFeed(environmentId);
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenToggleRef = useRef<HTMLButtonElement | null>(null);
  const fullScreenRef = useRef<HTMLElement | null>(null);
  const activeForChat = computerIsActiveForChat(feed.status, { botId, threadId });

  useEffect(() => {
    if (!fullScreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    fullScreenRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      fullScreenToggleRef.current?.focus({ preventScroll: true });
    };
  }, [fullScreen]);

  if (!manuallyVisible && !activeForChat) return null;

  const reachable = environmentId !== null && error === null;
  const state = describeComputerState({ status: feed.status, reachable, loading });
  const detail = computerPanelDetail(feed.status, state.label);
  const DetailIcon = expanded ? ChevronDown : ChevronUp;
  // Rendered inside a collapse button inline, and inside a plain row full
  // screen, where there is nothing to collapse to.
  const title = (
    <>
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[state.tone])}
      />
      <span className="shrink-0 text-[14px] font-semibold text-[var(--personal-text)]">
        Computer
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--personal-text-secondary)]">
        {detail}
      </span>
    </>
  );

  return (
    <section
      ref={fullScreenRef}
      aria-label={fullScreen ? "Computer full screen" : "Computer"}
      aria-modal={fullScreen || undefined}
      role={fullScreen ? "dialog" : undefined}
      tabIndex={fullScreen ? -1 : undefined}
      className={cn(
        "shrink-0 border-t border-[var(--personal-border)] bg-[var(--personal-surface)] outline-none",
        fullScreen &&
          "personal-app fixed inset-0 z-50 flex flex-col border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
      )}
    >
      <div className="flex min-h-11 shrink-0 items-center">
        {fullScreen ? (
          <div className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-4">{title}</div>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="conversation-computer-pane"
            onClick={() => onExpandedChange(!expanded)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
          >
            {title}
            <DetailIcon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
          </button>
        )}
        {expanded ? (
          <button
            ref={fullScreenToggleRef}
            type="button"
            aria-label={fullScreen ? "Exit full screen" : "Full screen"}
            onClick={() => setFullScreen((value) => !value)}
            className="flex size-11 shrink-0 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
          >
            {fullScreen ? (
              <Minimize2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
            ) : (
              <Maximize2 aria-hidden="true" className="size-5" strokeWidth={1.75} />
            )}
          </button>
        ) : null}
      </div>
      <div
        id="conversation-computer-pane"
        className={cn(
          "overflow-hidden transition-[max-height] duration-200 ease-out motion-reduce:transition-none",
          fullScreen ? "min-h-0 flex-1 transition-none" : expanded ? "max-h-[68dvh]" : "max-h-0",
        )}
      >
        {expanded ? (
          <div
            className={cn(
              "overflow-y-auto border-t border-[var(--personal-border)] px-3 pb-3",
              fullScreen ? "h-full overscroll-contain" : "max-h-[calc(68dvh-44px)]",
            )}
          >
            <ComputerBrowserPane
              environmentId={environmentId}
              status={feed.status}
              events={feed.events}
              reachable={reachable}
              fullScreen={fullScreen}
              onClosed={() => {
                // Nothing left to watch: leave full screen and fold the panel
                // back down to the bar.
                setFullScreen(false);
                onExpandedChange(false);
              }}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
