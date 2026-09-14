import type { JSX } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDown, ChevronUp } from "lucide-react";

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
  const activeForChat = computerIsActiveForChat(feed.status, { botId, threadId });
  if (!manuallyVisible && !activeForChat) return null;

  const reachable = environmentId !== null && error === null;
  const state = describeComputerState({ status: feed.status, reachable, loading });
  const detail = computerPanelDetail(feed.status, state.label);
  const DetailIcon = expanded ? ChevronDown : ChevronUp;

  return (
    <section
      aria-label="Computer"
      className="shrink-0 border-t border-[var(--personal-border)] bg-[var(--personal-surface)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="conversation-computer-pane"
        onClick={() => onExpandedChange(!expanded)}
        className="flex min-h-11 w-full items-center gap-2 px-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
      >
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
        <DetailIcon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      </button>
      <div
        id="conversation-computer-pane"
        className={cn(
          "overflow-hidden transition-[max-height] duration-200 ease-out motion-reduce:transition-none",
          expanded ? "max-h-[68dvh]" : "max-h-0",
        )}
      >
        {expanded ? (
          <div className="max-h-[calc(68dvh-44px)] overflow-y-auto border-t border-[var(--personal-border)] px-3 pb-3">
            <ComputerBrowserPane
              environmentId={environmentId}
              status={feed.status}
              events={feed.events}
              reachable={reachable}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
