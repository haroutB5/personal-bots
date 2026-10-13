import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import type {
  BotAvatarColor,
  BotAvatarShape,
  PersonalBot,
  PersonalBotId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Pin } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { selectedChatProps } from "./BotRow";
import { GroupFacePair } from "./GroupFacePair";
import type { RailCaption } from "./homeRows";
import { perfOptimizationOn } from "./perfFlags";
import { usePressOpenedMenuGuard } from "./pressOpenedMenuGuard";
import { useStagedCount } from "./useStagedCount";

/**
 * The rail above the filters: the pinned chats as small cards, a divider, then
 * every bot as a bare avatar (design decision: pinned chats live here and are
 * not repeated in All). Cards open their chat; tiles open the bot's own page.
 *
 * The scroller carries a right-edge fade while there is more to the right, a
 * left fade once it has been scrolled, and neither at the end, so the half
 * tile that shows at 390 px reads as "there is more" rather than as a clipped
 * row. The edge state is one attribute on the scroller, set on scroll and when
 * the item count changes: no layout read per render.
 */

/** Long-press that opens a card's menu. The platform's own callout delay. */
const LONG_PRESS_MS = 500;
/** A drag past this is the rail scrolling, not a press. */
const MOVE_TOLERANCE_PX = 10;
/** How close to an edge counts as "at" it. */
const EDGE_SLACK_PX = 6;

type RailEdge = "start" | "middle" | "end";

/**
 * A face in the rail, with the design's 2 px "needs you" ring 4 px outside it.
 * The ring is a sibling of the avatar rather than inside it: the static avatar
 * is an `<svg>`, which cannot hold HTML children.
 */
export function RailAvatar({
  ring = false,
  children,
}: {
  readonly ring?: boolean | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span className="relative inline-flex shrink-0">
      {children}
      {ring ? <span aria-hidden="true" className="bot-avatar-ring" /> : null}
    </span>
  );
}

export interface RailBotItem {
  readonly botId: string;
  readonly name: string;
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: BotAvatarColor;
  readonly caption: RailCaption;
  readonly motion: AvatarMotion | undefined;
  readonly comet: boolean;
}

export interface RailChatItem {
  readonly threadId: string;
  /** This chat is open in the desktop pane. */
  readonly selected: boolean;
  readonly botId: string;
  readonly botName: string;
  readonly title: string;
  readonly avatarShape: BotAvatarShape;
  readonly avatarColor: BotAvatarColor;
  readonly caption: RailCaption;
  readonly motion: AvatarMotion | undefined;
  readonly comet: boolean;
  readonly ring: boolean;
  readonly unread: boolean;
}

export interface RailGroupItem {
  readonly groupId: string;
  /** This group is open in the desktop pane. */
  readonly selected: boolean;
  readonly name: string;
  readonly members: ReadonlyArray<PersonalBot>;
  readonly caption: RailCaption;
}

/** Rail items drawn in the first commit, then added per frame (useStagedCount): five fit the screen. */
const RAIL_FIRST_ITEMS = 6;
const RAIL_STEP_ITEMS = 4;

interface HomeRailProps {
  readonly chats: ReadonlyArray<RailChatItem>;
  readonly groups: ReadonlyArray<RailGroupItem>;
  readonly bots: ReadonlyArray<RailBotItem>;
  /** Mount the items in steps (a first launch with nothing saved to show). */
  readonly stage?: boolean;
  /** Unpin a chat card. The only home-level way back out of the pinned set. */
  readonly onUnpinChat: (chat: RailChatItem) => void;
  readonly onUnpinGroup: (group: RailGroupItem) => void;
}

function sameCaption(a: RailCaption, b: RailCaption): boolean {
  return a === b || (a.label === b.label && a.tone === b.tone);
}

function sameChatItem(a: RailChatItem, b: RailChatItem): boolean {
  return (
    a === b ||
    (a.threadId === b.threadId &&
      a.selected === b.selected &&
      a.botId === b.botId &&
      a.botName === b.botName &&
      a.title === b.title &&
      a.avatarShape === b.avatarShape &&
      a.avatarColor === b.avatarColor &&
      sameCaption(a.caption, b.caption) &&
      a.motion === b.motion &&
      a.comet === b.comet &&
      a.ring === b.ring &&
      a.unread === b.unread)
  );
}

function sameGroupItem(a: RailGroupItem, b: RailGroupItem): boolean {
  if (a === b) return true;
  if (
    a.groupId !== b.groupId ||
    a.selected !== b.selected ||
    a.name !== b.name ||
    !sameCaption(a.caption, b.caption) ||
    a.members.length !== b.members.length
  ) {
    return false;
  }
  return a.members.every((member, index) => member === b.members[index]);
}

function sameBotItem(a: RailBotItem, b: RailBotItem): boolean {
  return (
    a === b ||
    (a.botId === b.botId &&
      a.name === b.name &&
      a.avatarShape === b.avatarShape &&
      a.avatarColor === b.avatarColor &&
      sameCaption(a.caption, b.caption) &&
      a.motion === b.motion &&
      a.comet === b.comet)
  );
}

function sameItems<T>(
  a: ReadonlyArray<T>,
  b: ReadonlyArray<T>,
  same: (left: T, right: T) => boolean,
): boolean {
  return a === b || (a.length === b.length && a.every((item, index) => same(item, b[index]!)));
}

/** Kill switch "home-rail-memo" (perfFlags.ts), read once per load. */
const RAIL_MEMO_ON = perfOptimizationOn("home-rail-memo");

function HomeRailView({
  chats,
  groups,
  bots,
  onUnpinChat,
  onUnpinGroup,
  stage = false,
}: {
  readonly chats: ReadonlyArray<RailChatItem>;
  readonly groups: ReadonlyArray<RailGroupItem>;
  readonly bots: ReadonlyArray<RailBotItem>;
  /** Mount the items in steps (a first launch with nothing saved to show). */
  readonly stage?: boolean;
  /** Unpin a chat card. The only home-level way back out of the pinned set. */
  readonly onUnpinChat: (chat: RailChatItem) => void;
  readonly onUnpinGroup: (group: RailGroupItem) => void;
}): JSX.Element {
  const scroller = useRef<HTMLUListElement | null>(null);
  const lastScrollLeft = useRef(0);
  // Kill switch "home-rail-edge-dom" (perfFlags.ts), read once per load. On, the
  // edge is written straight to the scroller's attribute: crossing an edge while
  // the rail scrolls costs one attribute write and a repaint of the mask, not a
  // render of every card and tile (their menus and links) in the middle of a drag.
  const [edgeInDom] = useState(() => perfOptimizationOn("home-rail-edge-dom"));
  const [edge, setEdge] = useState<RailEdge>("start");
  const applyEdge = useCallback(
    (next: RailEdge) => {
      if (!edgeInDom) {
        setEdge((current) => (current === next ? current : next));
        return;
      }
      const element = scroller.current;
      if (element !== null && element.getAttribute("data-edge") !== next) {
        element.setAttribute("data-edge", next);
      }
    },
    [edgeInDom],
  );
  const measure = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    lastScrollLeft.current = element.scrollLeft;
    const max = element.scrollWidth - element.clientWidth;
    const next: RailEdge =
      max <= EDGE_SLACK_PX || element.scrollLeft <= EDGE_SLACK_PX
        ? "start"
        : element.scrollLeft >= max - EDGE_SLACK_PX
          ? "end"
          : "middle";
    applyEdge(next);
  }, [applyEdge]);
  // Re-measure when the items change (a new pin, a bot leaving), not on every
  // render: reading scrollWidth during a render is a layout read in the
  // opening tap's frame.
  const itemCount = chats.length + groups.length + bots.length;
  useEffect(() => {
    // At the left edge the answer is already known. In particular, mounting
    // and waking the kept home need no scrollWidth read after React's writes.
    if (lastScrollLeft.current <= EDGE_SLACK_PX) {
      applyEdge("start");
    } else {
      measure();
    }
  }, [applyEdge, measure, itemCount]);

  const empty = itemCount === 0;
  // The first commit draws only what the screen shows; the rest follows frame by
  // frame. Chats first, then groups, then bots, as the rail reads.
  const drawnCount = useStagedCount(itemCount, {
    enabled: stage,
    first: RAIL_FIRST_ITEMS,
    step: RAIL_STEP_ITEMS,
  });
  const drawnChats = drawnCount >= itemCount ? chats : chats.slice(0, drawnCount);
  const drawnGroups =
    drawnCount >= itemCount ? groups : groups.slice(0, Math.max(0, drawnCount - chats.length));
  const drawnBots =
    drawnCount >= itemCount
      ? bots
      : bots.slice(0, Math.max(0, drawnCount - chats.length - groups.length));
  return (
    <section aria-label="Pinned chats, then bots" className="relative">
      <ul
        ref={scroller}
        data-edge={edgeInDom ? "start" : edge}
        onScroll={measure}
        data-testid="home-rail"
        className={cn(
          // Full-bleed scroller with the design's 16 px margin inside it, so a
          // card scrolled off the edge is cut by the screen, not by the margin.
          "home-rail flex snap-x snap-proximity items-start gap-2 overflow-x-auto overscroll-x-contain px-4 pt-5 pb-2",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {drawnChats.map((chat) => (
          <RailChatCard key={chat.threadId} chat={chat} onUnpinChat={onUnpinChat} />
        ))}
        {drawnGroups.map((group) => (
          <RailGroupCard key={group.groupId} group={group} onUnpinGroup={onUnpinGroup} />
        ))}
        {chats.length + groups.length > 0 && drawnBots.length > 0 ? (
          <li
            aria-hidden="true"
            className="mx-1 mt-[18px] h-14 w-px shrink-0 bg-[var(--personal-border)]"
          />
        ) : null}
        {drawnBots.map((bot) => (
          <RailBotTile key={bot.botId} bot={bot} />
        ))}
        {empty ? <li aria-hidden="true" className="h-14 w-px" /> : null}
      </ul>
    </section>
  );
}

/**
 * The rail, drawn again only when something it shows changed. The home renders
 * on every store change (a shell update while a bot streams, a task feed tick),
 * and the rail's items are rebuilt each time with the same contents: without
 * this every card and tile (links, menus, avatars) rendered again for nothing,
 * also while a chat covers the list.
 */
export const HomeRail = RAIL_MEMO_ON
  ? memo(HomeRailView, (previous: HomeRailProps, next: HomeRailProps) => {
      return (
        previous.stage === next.stage &&
        previous.onUnpinChat === next.onUnpinChat &&
        previous.onUnpinGroup === next.onUnpinGroup &&
        sameItems(previous.chats, next.chats, sameChatItem) &&
        sameItems(previous.groups, next.groups, sameGroupItem) &&
        sameItems(previous.bots, next.bots, sameBotItem)
      );
    })
  : HomeRailView;

/** The caption under a rail name: the state in words, in the state's colour. */
function RailCap({ caption }: { readonly caption: RailCaption }): JSX.Element {
  return (
    <span
      // Keyed on the words: a state change swaps the caption and the new one
      // rises into place (the design's rail moment; `.rail-cap`).
      key={caption.label}
      data-testid="rail-cap"
      className={cn(
        // The link's gap is 8 px; subtract 6 px to retain the former inner
        // label column's 2 px gap without an extra wrapper on every tile.
        "rail-cap -mt-1.5 w-full truncate text-center text-[13px] leading-4 font-medium",
        caption.tone === "working" && "text-[var(--personal-state-working)]",
        caption.tone === "thinking" && "text-[var(--personal-state-thinking)]",
        caption.tone === "needs" && "text-[var(--personal-state-needs)]",
        caption.tone === "idle" && "text-[var(--personal-state-idle)]",
      )}
    >
      {caption.label === "" ? " " : caption.label}
    </span>
  );
}

const CARD_CLASS =
  "personal-press relative flex w-full flex-col items-center gap-2 rounded-[var(--personal-radius-card-lg)] bg-[var(--personal-surface)] px-1 py-2 text-center outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/**
 * The card of the chat open in the desktop pane (md+ only): the same muted
 * fill the list rows use, in the card's own rounded shape.
 */
const SELECTED_CARD_CLASS =
  "md:bg-[var(--personal-fill-muted)] md:[--personal-bg:var(--personal-fill-muted)]";

const NAME_CLASS =
  "w-full truncate text-[13px] leading-4 font-semibold text-[var(--personal-text)]";

const TILE_CLASS =
  "personal-press flex w-full flex-col items-center gap-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/**
 * Long-press plumbing shared by the two card kinds: a press opens the card's
 * menu, and the release that follows must not also follow the link underneath.
 */
function useCardPressMenu(): {
  readonly menuOpen: boolean;
  readonly setMenuOpen: (open: boolean) => void;
  readonly anchor: React.RefObject<HTMLLIElement | null>;
  readonly pressProps: Record<string, unknown>;
  readonly guard: ReturnType<typeof usePressOpenedMenuGuard>;
} {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLLIElement | null>(null);
  const pressTimer = useRef(0);
  const pressOrigin = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const openedByPress = useRef(false);
  const guard = usePressOpenedMenuGuard();
  const cancelPress = useCallback(() => {
    if (pressTimer.current !== 0) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = 0;
    }
    pressOrigin.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  const pressProps = {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === "mouse") return;
      pressOrigin.current = { x: event.clientX, y: event.clientY };
      openedByPress.current = false;
      pressTimer.current = window.setTimeout(() => {
        pressTimer.current = 0;
        openedByPress.current = true;
        guard.armUntilLift();
        setMenuOpen(true);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const origin = pressOrigin.current;
      if (origin === null) return;
      if (
        Math.abs(event.clientX - origin.x) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - origin.y) > MOVE_TOLERANCE_PX
      ) {
        cancelPress();
      }
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
      if (!openedByPress.current) return;
      openedByPress.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      setMenuOpen(true);
    },
  };
  return { menuOpen, setMenuOpen, anchor, pressProps, guard };
}

/** A pinned chat's card: it opens the chat, not the bot. */
function RailChatCardView({
  chat,
  onUnpinChat,
}: {
  readonly chat: RailChatItem;
  readonly onUnpinChat: (chat: RailChatItem) => void;
}): JSX.Element {
  const { menuOpen, setMenuOpen, anchor, pressProps, guard } = useCardPressMenu();
  const label = `Pinned chat ${chat.title} with ${chat.botName}${
    chat.caption.label === "" ? "" : `, ${chat.caption.label}`
  }`;
  return (
    <li ref={anchor} className="relative w-[76px] shrink-0 snap-start">
      <Link
        to="/bots/$botId/$threadId"
        params={{ botId: chat.botId as PersonalBotId, threadId: chat.threadId as ThreadId }}
        aria-label={label}
        className={cn(CARD_CLASS, chat.selected && SELECTED_CARD_CLASS)}
        {...selectedChatProps(chat.selected)}
        {...pressProps}
      >
        <RailAvatar ring={chat.ring}>
          <BotAvatar
            shape={chat.avatarShape}
            color={chat.avatarColor}
            size={48}
            label={chat.title}
            motion={chat.motion}
            compactIdle
            comet={chat.comet}
            thought="pinned"
          />
          <span aria-hidden="true" className="bot-avatar-pin">
            <Pin aria-hidden="true" className="size-3" strokeWidth={2.4} />
          </span>
        </RailAvatar>
        <span className={NAME_CLASS}>{chat.title}</span>
        <RailCap caption={chat.caption} />
      </Link>
      <CardMenu
        name={chat.title}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        guard={guard}
        anchor={anchor}
        onUnpin={() => onUnpinChat(chat)}
      />
    </li>
  );
}

const RailChatCard = RAIL_MEMO_ON
  ? memo(
      RailChatCardView,
      (previous, next) =>
        previous.onUnpinChat === next.onUnpinChat && sameChatItem(previous.chat, next.chat),
    )
  : RailChatCardView;

/** A pinned group's card: a group is a chat, so it rides the rail the same way. */
function RailGroupCardView({
  group,
  onUnpinGroup,
}: {
  readonly group: RailGroupItem;
  readonly onUnpinGroup: (group: RailGroupItem) => void;
}): JSX.Element {
  const { menuOpen, setMenuOpen, anchor, pressProps, guard } = useCardPressMenu();
  const label = `Pinned chat ${group.name}, group${
    group.caption.label === "" ? "" : `, ${group.caption.label}`
  }`;
  return (
    <li ref={anchor} className="relative w-[76px] shrink-0 snap-start">
      <Link
        to="/bots/groups/$groupId"
        params={{ groupId: group.groupId }}
        aria-label={label}
        className={cn(CARD_CLASS, group.selected && SELECTED_CARD_CLASS)}
        {...selectedChatProps(group.selected)}
        {...pressProps}
      >
        <span className="relative flex size-12 items-center justify-center">
          <GroupFacePair bots={group.members} />
          <span aria-hidden="true" className="bot-avatar-pin">
            <Pin aria-hidden="true" className="size-3" strokeWidth={2.4} />
          </span>
        </span>
        <span className={NAME_CLASS}>{group.name}</span>
        <RailCap caption={group.caption} />
      </Link>
      <CardMenu
        name={group.name}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        guard={guard}
        anchor={anchor}
        onUnpin={() => onUnpinGroup(group)}
      />
    </li>
  );
}

const RailGroupCard = RAIL_MEMO_ON
  ? memo(
      RailGroupCardView,
      (previous, next) =>
        previous.onUnpinGroup === next.onUnpinGroup && sameGroupItem(previous.group, next.group),
    )
  : RailGroupCardView;

/** A bot tile: it opens the bot's page, where its chats and Edit live. */
function RailBotTileView({ bot }: { readonly bot: RailBotItem }): JSX.Element {
  const label = `${bot.name}, ${bot.caption.label}, open bot`;
  return (
    <li className="w-[68px] shrink-0 snap-start">
      <Link
        to="/bots/$botId"
        params={{ botId: bot.botId }}
        // Never "current": this tile is a parent of the bot's chat routes, and
        // the router would light it up on every chat of that bot (1.60.30).
        activeOptions={{ exact: true }}
        aria-label={label}
        className={TILE_CLASS}
      >
        <RailAvatar ring={bot.caption.tone === "needs"}>
          <BotAvatar
            shape={bot.avatarShape}
            color={bot.avatarColor}
            size={56}
            label={bot.name}
            motion={bot.motion}
            compactIdle
            comet={bot.comet}
            thought="pinned"
          />
        </RailAvatar>
        <span className={NAME_CLASS}>{bot.name}</span>
        <RailCap caption={bot.caption} />
      </Link>
    </li>
  );
}

const RailBotTile = RAIL_MEMO_ON
  ? memo(RailBotTileView, (previous, next) => sameBotItem(previous.bot, next.bot))
  : RailBotTileView;

/**
 * The card menu behind a long press, a right-click or the keyboard's own quiet
 * "Options" button (a long press is not an affordance a screen reader can
 * find). Unpin is the only item: the chat's other actions live in its own
 * chat list and on the bot's page.
 */
function CardMenu({
  name,
  menuOpen,
  setMenuOpen,
  guard,
  anchor,
  onUnpin,
}: {
  readonly name: string;
  readonly menuOpen: boolean;
  readonly setMenuOpen: (open: boolean) => void;
  readonly guard: ReturnType<typeof usePressOpenedMenuGuard>;
  readonly anchor: React.RefObject<HTMLLIElement | null>;
  readonly onUnpin: () => void;
}): JSX.Element {
  return (
    <Menu
      open={menuOpen}
      onOpenChange={(open, details) => {
        if (!open && !guard.mayClose(details.reason)) return;
        setMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <button
            type="button"
            className={cn(
              "sr-only outline-none",
              "focus-visible:not-sr-only focus-visible:absolute focus-visible:top-0 focus-visible:right-1 focus-visible:z-10",
              "focus-visible:flex focus-visible:size-7 focus-visible:items-center focus-visible:justify-center focus-visible:rounded-full",
              "focus-visible:bg-[var(--personal-surface)] focus-visible:text-[var(--personal-text)] focus-visible:shadow-[var(--personal-shadow-card)]",
              "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
            )}
          />
        }
      >
        <span className="sr-only">Options for {name}</span>
      </MenuTrigger>
      <MenuPopup align="center" anchor={anchor} className="personal-app personal-menu min-w-44">
        <MenuItem onClick={onUnpin}>Unpin {name}</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
