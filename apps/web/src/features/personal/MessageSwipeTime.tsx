import type { JSX, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { messageTimeParts } from "./messageTime";
import type { SwipeSide } from "./messageSwipe";
import { SWIPE_TIME_OPACITY_VAR, useMessageSwipe } from "./useMessageSwipe";

/** Touch only: pan up and down (and pinch) is the browser's, so a sideways drag is ours uncancelled. */
export const SWIPE_TOUCH_ACTION = "[@media(pointer:coarse)]:[touch-action:pan-y_pinch-zoom]";

/**
 * When a message was sent, in the room its swipe leaves: right of an owner's
 * message (which has moved left), left of a bot's reply (which has moved
 * right). A child of the swiping row, so it travels with it; its fade follows
 * the row's own custom property, which `useMessageSwipe` writes per move.
 */
export function MessageSwipeTime({
  sentAt,
  align,
  top,
}: {
  sentAt: Date;
  align: SwipeSide;
  /** Where the middle of the time sits, px from the top of the row (the finger's height). */
  top: number;
}): JSX.Element {
  const { day, time } = messageTimeParts(sentAt, new Date());
  return (
    <span
      aria-hidden="true"
      data-message-time=""
      className={cn(
        "pointer-events-none absolute flex -translate-y-1/2 flex-col text-[12px] leading-[15px] whitespace-nowrap text-[var(--personal-text-secondary)] tabular-nums transition-opacity duration-150 motion-reduce:transition-none",
        align === "end" ? "left-full ml-2 items-start" : "right-full mr-2 items-end",
      )}
      style={{ top, opacity: `var(${SWIPE_TIME_OPACITY_VAR}, 0)` }}
    >
      {day === null ? null : <span>{day}</span>}
      <span>{time}</span>
    </span>
  );
}

/**
 * A message that shows when it was sent on a sideways swipe but has no menu of
 * its own (an archived chat, where nothing can be sent so nothing can be
 * replied to). `ReplyableMessage` carries the same swipe for the rest.
 */
export function SwipeTimeRow({
  sentAt,
  align,
  className,
  children,
}: {
  sentAt: Date;
  align: SwipeSide;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const swipe = useMessageSwipe({ align, enabled: true });
  return (
    <div
      data-swipe-time-row=""
      className={cn("relative flex max-w-full", SWIPE_TOUCH_ACTION, className)}
      {...swipe.handlers}
      onClickCapture={(event) => {
        if (!swipe.consumeClick()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
      {swipe.reveal === null ? null : (
        <MessageSwipeTime sentAt={sentAt} align={align} top={swipe.reveal.top} />
      )}
    </div>
  );
}
