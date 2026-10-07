import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Link } from "@tanstack/react-router";
import { Pin, Plus } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  CURRENT_CHIP_SELECTOR,
  chatSwitchNavigation,
  scrollLeftToReveal,
} from "./chatChipNavigation";
import type { ChatChip } from "./chatChipRows";
import { markChatSwitched } from "./chatChipHandoff";
import { CHAT_SETTINGS_HINT } from "./chatSettingsModel";
import { composerHasFocus, requestComposerRefocus } from "./composerRefocus";
import { useHoldCue } from "./useHoldCue";

const NO_IDS: ReadonlySet<string> = new Set();

/** Chips added after the row first showed (a new chat): they fade in, the first paint does not. */
function useFreshChipIds(ids: ReadonlyArray<string>): ReadonlySet<string> {
  const [known, setKnown] = useState<ReadonlySet<string> | null>(null);
  const key = ids.join("|");
  useEffect(() => {
    setKnown((previous) => new Set([...(previous ?? []), ...(key === "" ? [] : key.split("|"))]));
  }, [key]);
  if (known === null) return NO_IDS;
  const fresh = ids.filter((id) => !known.has(id));
  return fresh.length === 0 ? NO_IDS : new Set(fresh);
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function ChipDot({ chip }: { readonly chip: ChatChip }): JSX.Element | null {
  if (chip.current || chip.state === "idle") return null;
  return <span aria-hidden="true" className="personal-chip-dot" data-state={chip.state} />;
}

/**
 * One chat's chip. A tap switches to the chat; a hold (or a right-click, or the
 * ContextMenu key, which the row handles) opens that chat's settings. A hold
 * that fires never switches: useLongPress swallows the click that ends it.
 */
function ChatChipLink({
  botId,
  chip,
  tabbable,
  isFresh,
  hintId,
  onFocus,
  onItemPointerDown,
  onSwitch,
  onSettings,
}: {
  readonly botId: string;
  readonly chip: ChatChip;
  readonly tabbable: boolean;
  readonly isFresh: boolean;
  readonly hintId: string;
  readonly onFocus: () => void;
  readonly onItemPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onSwitch: (chip: ChatChip, event: ReactMouseEvent<HTMLElement>) => void;
  readonly onSettings: (threadId: string) => void;
}): JSX.Element {
  const hold = useHoldCue(() => onSettings(chip.threadId));
  return (
    <Link
      {...chatSwitchNavigation(botId, chip.threadId)}
      data-chip-item=""
      data-chip-id={chip.threadId}
      {...hold.attributes}
      aria-label={chip.label}
      aria-describedby={hintId}
      aria-current={chip.current ? "page" : undefined}
      tabIndex={tabbable ? 0 : -1}
      draggable={false}
      onFocus={onFocus}
      onPointerDown={(event) => {
        onItemPointerDown(event);
        hold.handlers.onPointerDown(event);
      }}
      onPointerMove={hold.handlers.onPointerMove}
      onPointerUp={hold.handlers.onPointerUp}
      onPointerCancel={hold.handlers.onPointerCancel}
      onContextMenu={(event) => {
        // A right-click on a desktop, or the hold itself on Android: the same sheet,
        // and opening it a second time is harmless.
        event.preventDefault();
        onSettings(chip.threadId);
      }}
      onClick={(event) => onSwitch(chip, event)}
      className="personal-chip-hit"
    >
      <span
        className={cn("personal-chip", isFresh && "personal-chip-in")}
        data-state={chip.state}
        data-current={chip.current}
        data-unread={chip.unread}
      >
        <ChipDot chip={chip} />
        {chip.pinned ? (
          <Pin aria-hidden="true" data-chip-pin="" className="size-3 shrink-0" strokeWidth={2} />
        ) : null}
        <span className="min-w-0 truncate">{chip.text}</span>
      </span>
    </Link>
  );
}

/**
 * The chat chips: slim pills in the bot's chat header, one per chat the owner
 * started with the bot, then "+" (new chat) and "All N" (the full list). Each
 * pill is 24 px tall inside a 44 px tap band that overlaps nothing.
 */
export function ChatChips({
  botId,
  botName,
  chips,
  openCount,
  onNewChat,
  onChipSettings,
  resortEpoch = 0,
}: {
  readonly botId: string;
  readonly botName: string;
  readonly chips: ReadonlyArray<ChatChip>;
  readonly openCount: number;
  readonly onNewChat: () => void;
  /** A hold, right-click or ContextMenu key on a chip: open that chat's settings. `opener` takes focus back. */
  readonly onChipSettings?: ((threadId: string, opener: HTMLElement | null) => void) | undefined;
  /** Moves when the order was re-taken after the app came back: the open chip is centred again at once. */
  readonly resortEpoch?: number | undefined;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const [focusId, setFocusId] = useState<string | null>(null);
  const composerHadFocus = useRef(false);
  const firstCentre = useRef(true);
  const lastEpoch = useRef(resortEpoch);
  const hintId = useId();
  const fresh = useFreshChipIds(chips.map((chip) => chip.threadId));
  const currentId = chips.find((chip) => chip.current)?.threadId ?? null;
  const tabbableId = focusId ?? currentId ?? chips[0]?.threadId ?? "new";

  const updateFade = useCallback(() => {
    const row = rowRef.current;
    if (row === null) return;
    const left = row.scrollLeft > 0;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    setFade((previous) =>
      previous.left === left && previous.right === right ? previous : { left, right },
    );
  }, []);
  const scheduled = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (scheduled.current !== null) return;
    scheduled.current = window.requestAnimationFrame(() => {
      scheduled.current = null;
      updateFade();
    });
  }, [updateFade]);
  useEffect(
    () => () => {
      if (scheduled.current !== null) window.cancelAnimationFrame(scheduled.current);
    },
    [],
  );

  // The open chat sits in the middle of the row: at once when the row first
  // shows (and when the order was re-taken after the app came back), smoothly
  // after every switch. A chat that was pinned or unpinned while the owner
  // stays moves, so the row follows it instead: that chip is scrolled fully
  // into view (smoothly, or at once under reduced motion).
  const chipsKey = chips.map((chip) => chip.threadId).join("|");
  const pinKey = chips
    .filter((chip) => chip.pinned)
    .map((chip) => chip.threadId)
    .join("|");
  const chipsNow = useRef(chips);
  const pinnedSeen = useRef<ReadonlyMap<string, boolean> | null>(null);
  useLayoutEffect(() => {
    chipsNow.current = chips;
  });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const before = pinnedSeen.current;
    pinnedSeen.current = new Map(chipsNow.current.map((chip) => [chip.threadId, chip.pinned]));
    const epochMoved = lastEpoch.current !== resortEpoch;
    // The first chip whose pin changed (a chip not in the row before is new, not pinned).
    const followed =
      before === null || firstCentre.current || epochMoved
        ? null
        : (chipsNow.current.find(
            (chip) => before.has(chip.threadId) && before.get(chip.threadId) !== chip.pinned,
          )?.threadId ?? null);
    const followTarget =
      followed === null || followed === currentId
        ? null
        : row.querySelector<HTMLElement>(`[data-chip-id="${followed}"]`);
    if (followTarget !== null && typeof row.scrollTo === "function") {
      const left = scrollLeftToReveal(row, followTarget);
      if (left !== null) row.scrollTo({ left, behavior: reducedMotion() ? "instant" : "smooth" });
    } else {
      const target = row.querySelector<HTMLElement>(CURRENT_CHIP_SELECTOR);
      if (target !== null && typeof row.scrollTo === "function") {
        const left = target.offsetLeft - (row.clientWidth - target.offsetWidth) / 2;
        row.scrollTo({
          left: Math.max(0, left),
          behavior: firstCentre.current || epochMoved || reducedMotion() ? "instant" : "smooth",
        });
        firstCentre.current = false;
        lastEpoch.current = resortEpoch;
      }
    }
    updateFade();
  }, [currentId, chipsKey, pinKey, resortEpoch, updateFade]);
  useEffect(() => {
    const row = rowRef.current;
    if (row === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateFade);
    observer.observe(row);
    return () => observer.disconnect();
  }, [updateFade]);

  // A tap on a chip must not take the keyboard down: iOS blurs the message
  // field on the tap's default action. The next chat's composer takes the
  // focus over when the switch lands (composerRefocus.ts).
  const onItemPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    composerHadFocus.current = composerHasFocus();
    if (composerHadFocus.current) event.preventDefault();
  };

  const onChipSwitch = (chip: ChatChip, event: ReactMouseEvent<HTMLElement>) => {
    if (chip.current) {
      event.preventDefault();
      return;
    }
    markChatSwitched();
    if (composerHadFocus.current) requestComposerRefocus();
    composerHadFocus.current = false;
  };

  const openSettingsFor = (threadId: string) => {
    const row = rowRef.current;
    const opener =
      row === null || typeof row.querySelector !== "function"
        ? null
        : row.querySelector<HTMLElement>(`[data-chip-id="${threadId}"]`);
    onChipSettings?.(threadId, opener);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // ContextMenu or Shift+F10 on a focused chip: its settings, the keyboard's way in.
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const target = event.target as HTMLElement;
      const threadId = target.getAttribute?.("data-chip-id") ?? null;
      if (threadId !== null && threadId !== "") {
        event.preventDefault();
        onChipSettings?.(threadId, target);
      }
      return;
    }
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-chip-item]")];
    const at = items.findIndex((item) => item === document.activeElement);
    if (at === -1 || items.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1)));
    items[next]?.focus();
  };

  return (
    <nav
      aria-label={`Chats with ${botName}`}
      data-testid="chat-chips"
      // On a phone the strip runs on under the "..." button (which only fills the first row), so
      // the 56 px of that column are chip room and "All" is not cut off at the end.
      className="relative z-[1] -mr-14 -mb-[3px] h-11 min-w-0 shrink-0 md:mr-0"
    >
      {/* One hint for every chip (aria-describedby): hidden elements still describe. */}
      <span id={hintId} hidden>
        {CHAT_SETTINGS_HINT}
      </span>
      <div
        ref={rowRef}
        data-fade-left={fade.left}
        data-fade-right={fade.right}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        className="personal-chip-row"
      >
        {chips.map((chip) => (
          <ChatChipLink
            key={chip.threadId}
            botId={botId}
            chip={chip}
            tabbable={tabbableId === chip.threadId}
            isFresh={fresh.has(chip.threadId)}
            hintId={hintId}
            onFocus={() => setFocusId(chip.threadId)}
            onItemPointerDown={onItemPointerDown}
            onSwitch={onChipSwitch}
            onSettings={openSettingsFor}
          />
        ))}
        <button
          type="button"
          data-chip-item=""
          aria-label={`New chat with ${botName}`}
          tabIndex={tabbableId === "new" ? 0 : -1}
          onFocus={() => setFocusId("new")}
          onPointerDown={onItemPointerDown}
          onClick={onNewChat}
          className="personal-chip-hit"
        >
          <span className="personal-chip personal-chip-plus">
            <Plus aria-hidden="true" className="size-3.5" strokeWidth={2} />
          </span>
        </button>
        <Link
          to="/bots/$botId"
          params={{ botId }}
          // The router marks a link active (data-status, aria-current="page") when its path
          // is a prefix of the location, and /bots/<id> prefixes every chat of the bot. Exact
          // keeps the row's one aria-current on the open chat's chip, which centring reads.
          activeOptions={{ exact: true }}
          data-chip-item=""
          aria-label={`All chats with ${botName}, ${openCount} open`}
          tabIndex={tabbableId === "all" ? 0 : -1}
          onFocus={() => setFocusId("all")}
          className="personal-chip-hit"
        >
          <span className="personal-chip personal-chip-all">All {openCount}</span>
        </Link>
      </div>
    </nav>
  );
}
