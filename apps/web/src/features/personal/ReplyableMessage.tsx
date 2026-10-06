import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PersonalReplyQuote } from "@t3tools/contracts";
import { Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { MESSAGE_ID_ATTRIBUTE } from "./messageReply";
import {
  clearSelectionIn,
  hasSelectionIn,
  INTERACTIVE_SELECTOR,
  isDoubleTap,
  selectAllIn,
  selectWordAtPoint,
  TAP_MAX_MS,
  type TapPoint,
} from "./messageTextSelection";
import { usePressOpenedMenuGuard } from "./pressOpenedMenuGuard";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "./useLongPress";

/** What turns on a message's text: it is selectable, with iOS's own callout. */
const SELECTABLE = "select-text [-webkit-touch-callout:default]";
/**
 * On a touch screen the text is locked so the long press opens the menu rather
 * than iOS's selection.
 */
const TOUCH_LOCKED =
  "[@media(pointer:coarse)]:select-none [@media(pointer:coarse)]:[-webkit-touch-callout:none]";

/** What to select once the message has turned selectable. */
type SelectTarget =
  | { readonly kind: "all" }
  | { readonly kind: "word"; readonly x: number; readonly y: number };

/**
 * A message you can act on: Reply, Select text and Copy. Long press on the
 * phone, right click or the "..." beside the message on desktop (shown on hover
 * and focus), the same menu for all three. It also carries the message's id,
 * which is what a quote's jump looks for.
 *
 * Touch only for the long press: a mouse press keeps selecting text. On a
 * touch screen the message's text is not selectable until asked for, because
 * iOS would otherwise start a text selection under the same hold. "Select
 * text" in the menu, or a double tap on the text, turns this one message
 * selectable and selects it (the whole message from the menu, the tapped word
 * from a double tap), so iOS shows its handles and Copy bubble to drag onto
 * the sentence wanted. It ends when the selection is cleared, on a tap
 * elsewhere, or when the message scrolls out of view. The row is
 * touch-action: manipulation, so a double tap does not zoom the page.
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
  const [selecting, setSelecting] = useState(false);
  const anchor = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const pendingSelect = useRef<SelectTarget | null>(null);
  // The finger that is down, and the last tap that was short and still (a double tap's first half).
  const fingerDown = useRef<TapPoint | null>(null);
  const lastTap = useRef<TapPoint | null>(null);
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

  const startSelecting = (target: SelectTarget) => {
    cancelPress();
    pendingSelect.current = target;
    setSelecting(true);
  };
  const stopSelecting = useCallback(() => {
    pendingSelect.current = null;
    setSelecting(false);
    if (anchor.current !== null) clearSelectionIn(anchor.current);
  }, []);

  // Once the text is selectable, put the selection on it. From the menu the popup is
  // still closing, so a moment later; from a double tap, at once, in the finger's touch.
  useLayoutEffect(() => {
    if (!selecting) return;
    const target = pendingSelect.current;
    pendingSelect.current = null;
    const root = content.current;
    if (target === null || root === null) return;
    if (target.kind === "word") {
      selectWordAtPoint(root, target.x, target.y);
      return;
    }
    const timer = window.setTimeout(() => selectAllIn(root), 60);
    return () => window.clearTimeout(timer);
  }, [selecting]);

  // Selection mode ends when the selection is cleared, on a tap elsewhere, or when the
  // message scrolls out of view.
  useEffect(() => {
    if (!selecting) return;
    // A double tap has already put its word on the text by now; the menu's choice comes later.
    let hadSelection = anchor.current !== null && hasSelectionIn(anchor.current);
    const onSelectionChange = () => {
      const root = anchor.current;
      if (root === null) return;
      if (hasSelectionIn(root)) hadSelection = true;
      else if (hadSelection) stopSelecting();
    };
    const onPointerDownAnywhere = (event: Event) => {
      const root = anchor.current;
      if (root !== null && !root.contains(event.target as Node)) stopSelecting();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDownAnywhere, true);
    const observer =
      typeof IntersectionObserver === "undefined" || anchor.current === null
        ? null
        : new IntersectionObserver((entries) => {
            if (entries.some((entry) => !entry.isIntersecting)) stopSelecting();
          });
    if (anchor.current !== null) observer?.observe(anchor.current);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDownAnywhere, true);
      observer?.disconnect();
    };
  }, [selecting, stopSelecting]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" || !insideMessage(event)) return;
    const point = { t: performance.now(), x: event.clientX, y: event.clientY };
    fingerDown.current = point;
    const onControl = (event.target as Element | null)?.closest?.(INTERACTIVE_SELECTOR) != null;
    if (!onControl && isDoubleTap(lastTap.current, point)) {
      // A double tap on the text: this message turns selectable and the tapped word is selected.
      lastTap.current = null;
      fingerDown.current = null;
      startSelecting({ kind: "word", x: event.clientX, y: event.clientY });
      return;
    }
    // Selecting already: a hold is the browser's own (its handles and callout), not our menu.
    if (selecting) return;
    pressOrigin.current = { x: event.clientX, y: event.clientY };
    openedByPress.current = false;
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = 0;
      openedByPress.current = true;
      menuGuard.armUntilLift();
      setOpen(true);
    }, LONG_PRESS_MS);
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    cancelPress();
    // A short tap that stayed put can be the first half of a double tap.
    const down = fingerDown.current;
    fingerDown.current = null;
    const now = performance.now();
    lastTap.current =
      down !== null &&
      event.pointerType !== "mouse" &&
      now - down.t <= TAP_MAX_MS &&
      Math.abs(event.clientX - down.x) <= LONG_PRESS_SLOP_PX &&
      Math.abs(event.clientY - down.y) <= LONG_PRESS_SLOP_PX
        ? { t: now, x: event.clientX, y: event.clientY }
        : null;
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
      data-selecting={selecting ? "" : undefined}
      className={cn(
        "group/reply flex max-w-full items-start gap-1 rounded-[var(--personal-radius-bubble)] [@media(pointer:coarse)]:touch-manipulation",
        selecting ? SELECTABLE : TOUCH_LOCKED,
        align === "end" ? "flex-row-reverse" : "flex-row",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        cancelPress();
        fingerDown.current = null;
        lastTap.current = null;
      }}
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
      {/* display: contents, so it takes no space; it marks what "Select text" selects. */}
      <div ref={content} className="contents">
        {children}
      </div>
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
          <MenuItem onClick={() => startSelecting({ kind: "all" })}>Select text</MenuItem>
          <MenuItem onClick={copy}>Copy text</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
