import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PersonalReplyQuote } from "@t3tools/contracts";
import { Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { MESSAGE_ID_ATTRIBUTE } from "./messageReply";
import { usePressOpenedMenuGuard } from "./pressOpenedMenuGuard";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "./useLongPress";

/**
 * A message you can act on: Reply (and Copy). Long press on the phone, right
 * click or the "..." beside the message on desktop (shown on hover and focus),
 * the same menu for all three. It also carries the message's id, which is what
 * a quote's jump looks for.
 *
 * Touch only for the long press: a mouse press keeps selecting text. On a
 * touch screen the message's text is not selectable (the menu's Copy takes
 * its place), because iOS would otherwise start a text selection under the
 * same hold.
 */
export function ReplyableMessage({
  messageId,
  quote,
  copyText,
  onReply,
  align,
  className,
  children,
}: {
  messageId: string;
  quote: PersonalReplyQuote;
  copyText: string;
  onReply: (quote: PersonalReplyQuote) => void;
  /** Which edge the message hugs: the owner's right, a bot's left. */
  align: "start" | "end";
  /** Width of the row, where the message inside does not fill the line. */
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const pressTimer = useRef(0);
  const pressOrigin = useRef<{ readonly x: number; readonly y: number } | null>(null);
  // A long press that opened the menu must not also press what is under it (a link, a quote).
  const openedByPress = useRef(false);
  const menuGuard = usePressOpenedMenuGuard();

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== 0) window.clearTimeout(pressTimer.current);
    pressTimer.current = 0;
    pressOrigin.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  // The menu's popup is portaled out of the message, but React still bubbles its
  // events up through it: a tap on "Reply" must not start another long press.
  const insideMessage = (event: { currentTarget: Element; target: EventTarget }) =>
    event.currentTarget.contains(event.target as Node);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" || !insideMessage(event)) return;
    pressOrigin.current = { x: event.clientX, y: event.clientY };
    openedByPress.current = false;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = 0;
      openedByPress.current = true;
      menuGuard.armUntilLift();
      setOpen(true);
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const origin = pressOrigin.current;
    if (origin === null) return;
    // Scrolling the chat is a drag, not a press.
    if (
      Math.abs(event.clientX - origin.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - origin.y) > LONG_PRESS_SLOP_PX
    ) {
      cancelPress();
    }
  };

  const reply = () => onReply(quote);
  const copy = () => {
    void navigator.clipboard?.writeText(copyText).catch(() => undefined);
  };

  return (
    <div
      ref={anchor}
      {...{ [MESSAGE_ID_ATTRIBUTE]: messageId }}
      data-replyable=""
      className={cn(
        "group/reply flex max-w-full items-start gap-1 rounded-[var(--personal-radius-bubble)] [@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]",
        align === "end" ? "flex-row-reverse" : "flex-row",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClickCapture={(event) => {
        if (!openedByPress.current || !insideMessage(event)) return;
        openedByPress.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onContextMenu={(event) => {
        if (!insideMessage(event)) return;
        event.preventDefault();
        setOpen(true);
      }}
    >
      {children}
      <Menu
        open={open}
        onOpenChange={(next, details) => {
          if (!next && !menuGuard.mayClose(details.reason)) return;
          setOpen(next);
        }}
      >
        {/* The keyboard, VoiceOver and the mouse reach the same menu. Hidden
            until the message is hovered or the button focused, and not at all
            on a touch screen, where the long press is the way in. */}
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Message options for ${quote.name}`}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-tertiary)] opacity-0 outline-none",
                "hover:bg-[var(--personal-fill-muted)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] group-hover/reply:opacity-100 data-popup-open:opacity-100",
                "[@media(pointer:coarse)]:sr-only",
              )}
            />
          }
        >
          <Ellipsis aria-hidden="true" className="size-4" strokeWidth={2} />
        </MenuTrigger>
        <MenuPopup
          align={align === "end" ? "end" : "start"}
          anchor={anchor}
          className="personal-app personal-menu min-w-40"
        >
          <MenuItem onClick={reply}>Reply</MenuItem>
          <MenuItem onClick={copy}>Copy text</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
