import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "~/lib/utils";

import { ComputerBrowserPane } from "./computer/ComputerScreen";
import {
  computerIsActiveForChat,
  computerNeedsHelpForChat,
  computerPanelDetail,
  describeComputerState,
  type ComputerDotTone,
} from "./computer/computerModel";
import { useComputerFeed } from "./computer/computerState";
import { inertOutside } from "./overlayInert";

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
  onBrowserClosed,
  conversationState = "other",
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
  readonly threadId: string;
  readonly manuallyVisible: boolean;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onBrowserClosed: () => void;
  readonly conversationState?: "working" | "needs_help" | "other";
}): JSX.Element | null {
  const { feed, error, loading } = useComputerFeed(environmentId);
  const [fullScreen, setFullScreen] = useState(false);
  const panelToggleRef = useRef<HTMLButtonElement | null>(null);
  const fullScreenRef = useRef<HTMLElement | null>(null);
  const activeForChat = computerIsActiveForChat(feed.status, { botId, threadId });
  const needsHelp = computerNeedsHelpForChat(feed.status, { botId, threadId });
  const visible = manuallyVisible || activeForChat || needsHelp;
  const displayExpanded = expanded || needsHelp;
  useEffect(() => {
    if (needsHelp && !expanded) onExpandedChange(true);
  }, [expanded, needsHelp, onExpandedChange]);
  // Taking control here pins the panel open. Once help ends and the lease
  // goes back to the bot, neither needsHelp nor an active agent lease holds it
  // on screen, so Return to bot would drop full screen and hide the panel
  // until the bot's next browser op (QA v1.10.0 BUG-5).
  const inControlHere =
    feed.status?.controller._tag === "Human" && feed.status.controller.self === true;
  useEffect(() => {
    if (visible && inControlHere && !manuallyVisible) onExpandedChange(true);
  }, [inControlHere, manuallyVisible, onExpandedChange, visible]);
  // External closure can hide the mounted panel without going through its
  // Close button. Drop full screen then, including its body scroll lock.
  if (fullScreen && (!visible || !displayExpanded)) setFullScreen(false);

  // The browser closing (Close button, close_browser tool, crash-teardown)
  // retires the bar: a "Browser not running" strip is dead chrome. Transition-
  // edged so opening the panel from the menu while already offline still works.
  const browserOffline = feed.status?.state === "offline";
  const wasOffline = useRef(browserOffline);
  useEffect(() => {
    if (browserOffline && !wasOffline.current && !activeForChat) onBrowserClosed();
    wasOffline.current = browserOffline;
  }, [browserOffline, activeForChat, onBrowserClosed]);

  useEffect(() => {
    if (!fullScreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // aria-modal alone still leaves the page behind the overlay focusable and
    // clickable; inert is what actually keeps focus in the dialog.
    const restoreBackground = inertOutside(fullScreenRef.current);
    fullScreenRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      restoreBackground();
      document.body.style.overflow = previousOverflow;
      panelToggleRef.current?.focus({ preventScroll: true });
    };
  }, [fullScreen]);

  if (!visible) return null;

  const reachable = environmentId !== null && error === null;
  const agentTurnRunning = conversationState === "working";
  const state = describeComputerState({
    status: feed.status,
    reachable,
    loading,
    agentTurnRunning,
  });
  const detail = computerPanelDetail(feed.status, state.label, agentTurnRunning);
  const DetailIcon = displayExpanded ? ChevronDown : ChevronUp;
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
      <div className={cn("min-h-11 shrink-0", fullScreen && "hidden")}>
        <button
          ref={panelToggleRef}
          type="button"
          aria-expanded={fullScreen ? undefined : displayExpanded}
          aria-controls="conversation-computer-pane"
          onClick={fullScreen ? undefined : () => onExpandedChange(!displayExpanded)}
          className="flex min-h-11 w-full min-w-0 items-center gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
        >
          {title}
          <DetailIcon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
        </button>
      </div>
      <div
        id="conversation-computer-pane"
        className={cn(
          "overflow-hidden transition-[max-height] duration-200 ease-out motion-reduce:transition-none",
          fullScreen
            ? "min-h-0 flex-1 transition-none"
            : displayExpanded
              ? "max-h-[200px]"
              : "max-h-0",
        )}
      >
        {displayExpanded ? (
          <div
            className={cn(
              "border-t border-[var(--personal-border)]",
              fullScreen
                ? "h-full min-h-0 overflow-hidden border-t-0"
                : "h-[200px] overflow-hidden",
            )}
          >
            <ComputerBrowserPane
              environmentId={environmentId}
              status={feed.status}
              events={feed.events}
              reachable={reachable}
              fullScreen={fullScreen}
              compact={!fullScreen}
              onOpenFullScreen={() => setFullScreen(true)}
              onBackToChat={() => setFullScreen(false)}
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
