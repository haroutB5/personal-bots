import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { cn } from "~/lib/utils";

import { CURRENT_CHIP_SELECTOR, chatSwitchNavigation } from "./chatChipNavigation";
import type { ChatChip } from "./chatChipRows";
import { markChatSwitched } from "./chatChipHandoff";
import { composerHasFocus, requestComposerRefocus } from "./composerRefocus";

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
}: {
  readonly botId: string;
  readonly botName: string;
  readonly chips: ReadonlyArray<ChatChip>;
  readonly openCount: number;
  readonly onNewChat: () => void;
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const [focusId, setFocusId] = useState<string | null>(null);
  const composerHadFocus = useRef(false);
  const firstCentre = useRef(true);
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
  // shows, smoothly after every switch.
  const chipsKey = chips.map((chip) => chip.threadId).join("|");
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const target = row.querySelector<HTMLElement>(CURRENT_CHIP_SELECTOR);
    if (target !== null && typeof row.scrollTo === "function") {
      const left = target.offsetLeft - (row.clientWidth - target.offsetWidth) / 2;
      row.scrollTo({
        left: Math.max(0, left),
        behavior: firstCentre.current || reducedMotion() ? "instant" : "smooth",
      });
      firstCentre.current = false;
    }
    updateFade();
  }, [currentId, chipsKey, updateFade]);
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

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
      className="relative z-[1] -mb-[3px] h-11 min-w-0 shrink-0"
    >
      <div
        ref={rowRef}
        data-fade-left={fade.left}
        data-fade-right={fade.right}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        className="personal-chip-row"
      >
        {chips.map((chip) => (
          <Link
            key={chip.threadId}
            {...chatSwitchNavigation(botId, chip.threadId)}
            data-chip-item=""
            data-chip-id={chip.threadId}
            aria-label={chip.label}
            aria-current={chip.current ? "page" : undefined}
            tabIndex={tabbableId === chip.threadId ? 0 : -1}
            onFocus={() => setFocusId(chip.threadId)}
            onPointerDown={onItemPointerDown}
            onClick={(event) => {
              if (chip.current) {
                event.preventDefault();
                return;
              }
              markChatSwitched();
              if (composerHadFocus.current) requestComposerRefocus();
              composerHadFocus.current = false;
            }}
            className="personal-chip-hit"
          >
            <span
              className={cn("personal-chip", fresh.has(chip.threadId) && "personal-chip-in")}
              data-state={chip.state}
              data-current={chip.current}
              data-unread={chip.unread}
            >
              <ChipDot chip={chip} />
              <span className="min-w-0 truncate">{chip.text}</span>
            </span>
          </Link>
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
