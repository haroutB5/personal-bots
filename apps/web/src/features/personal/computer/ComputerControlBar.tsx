import { Bot, ChevronLeft, Hand } from "lucide-react";
import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { ICON_STROKE } from "./ComputerSourceRow";

/**
 * Full-screen top bar while you drive: exit, "You're in control" with the
 * control dot, what is paused, and Hand back. The title is a live region so a
 * screen reader hears the change once.
 */
export function ComputerControlTopBar(props: {
  readonly title: string;
  readonly subline: string;
  readonly onExit: () => void;
  readonly onHandBack: () => void;
  readonly handBackDisabled?: boolean;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex h-14 shrink-0 items-center gap-1 pr-3 pl-1", props.className)}>
      <button
        type="button"
        aria-label="Exit full screen"
        onClick={props.onExit}
        className="flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <ChevronLeft className="size-[22px]" strokeWidth={ICON_STROKE} />
      </button>
      <div className="min-w-0 flex-1">
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-[16px] leading-5 font-semibold"
        >
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--personal-control)]" />
          <span className="truncate">{props.title}</span>
        </p>
        <p className="truncate text-[13px] text-[var(--personal-text-secondary)]">
          {props.subline}
        </p>
      </div>
      <button
        type="button"
        disabled={props.handBackDisabled === true}
        onClick={props.onHandBack}
        className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
      >
        <Bot className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
        Hand back
      </button>
    </div>
  );
}

/** "Followed Assistant to the desktop": a pill over the top of the stage. */
export function FollowToast(props: { readonly text: string }): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="computer-toast pointer-events-none absolute top-2 left-1/2 z-20 flex h-8 max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center rounded-full border border-[var(--personal-border-strong)] bg-[rgb(15_15_14/.92)] px-3.5 text-[13px] text-[var(--personal-text)]"
    >
      <span className="truncate">{props.text}</span>
    </div>
  );
}

/** The help request kept in view while you drive. */
export function HelpStrip(props: { readonly text: string }): JSX.Element {
  return (
    <div className="mx-3 mb-2 flex items-start gap-2.5 rounded-[12px] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] px-3 py-2.5 text-[14px] leading-5">
      <Hand
        className="mt-0.5 size-[18px] shrink-0 text-[var(--personal-review)]"
        strokeWidth={ICON_STROKE}
        aria-hidden
      />
      <span className="min-w-0 flex-1">{props.text}</span>
    </div>
  );
}
