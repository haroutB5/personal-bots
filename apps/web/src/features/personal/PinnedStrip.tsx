import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EnvironmentId,
  PersonalBot,
  PersonalBotId,
  PersonalGroup,
  PersonalGroupId,
  PersonalGroupRound,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { selectedChatProps } from "./BotRow";
import { botStatus, type BotSummary } from "./botSummaries";
import type { ChatsSnapshotRow } from "./chatsSnapshot";
import { GroupAvatarCluster } from "./GroupAvatarCluster";
import { activeGroupMembers, groupStatusLine, isGroupRoundLive, groupSubtitle } from "./groupModel";
import { useStartBotChat } from "./startBotChat";

/**
 * Favourites strip: the pinned chats as one horizontal row of faces above the
 * list, replacing the bordered "Pinned" card that used to wrap full rows.
 *
 * Three things the card got wrong and this does not:
 *
 * 1. **A box inside a box.** The card drew a border and a surface around a
 *    list that already had dividers, so the same rows had two frames.
 * 2. **Two shapes for one kind of content.** Pinned rows were inset and
 *    rounded while every other row is full-bleed, so a pinned bot looked like
 *    a different object from the same bot unpinned.
 * 3. **The chrome carried the meaning.** Nothing on the row said "pinned"; the
 *    box did. A face in the strip is self-evidently a favourite.
 *
 * What it costs: the preview line. What it must therefore not lose is the
 * *status* — "needs your help" has to survive the loss of "Planner answered:…"
 * — so it comes back as a badge on the avatar, derived from the same
 * {@link botStatus} the row prints, never from a second reading of the summary.
 */

/** Avatar diameter. Same 56px as a list row: it reads at arm's length and the
 * cold-start snapshot tile and the live tile stay the same size. */
export const PINNED_AVATAR_SIZE = 56;

/**
 * Tile width. On a 390pt phone the screen's `px-5` leaves 350px, so
 * `4 x 72 + 3 x 12 = 324` puts four faces on screen with 26px of the fifth
 * showing — enough peek that the strip is visibly scrollable without a
 * scrollbar or a chevron. Uncapped pin counts (1 to ~10) just scroll.
 */
const TILE_WIDTH_PX = 72;

/** Long-press that opens the tile menu. Matches the platform's own callout delay. */
const LONG_PRESS_MS = 500;
/** A drag past this is the strip scrolling, not a press. */
const MOVE_TOLERANCE_PX = 10;

const TILE_CLASS = cn(
  "flex w-full flex-col items-center gap-1.5 rounded-[var(--personal-radius-card)] py-1",
  "personal-row-hover text-center outline-none select-none [-webkit-touch-callout:none]",
  "focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
);

/**
 * The tile of the chat open in the desktop pane (md+ only; see
 * `SELECTED_ROW_CLASS` for the row version): the same muted fill in the
 * tile's own rounded card, with the page token swapped for the fill so the
 * badge's cut-out ring matches it. No bar: under the caption it read as an
 * underlined link, and there is no room for one without moving the strip.
 */
const SELECTED_TILE_CLASS =
  "md:bg-[var(--personal-fill-muted)] md:[--personal-bg:var(--personal-fill-muted)]";

const TILE_NAME_CLASS =
  "w-full truncate text-[12px] leading-[15px] font-medium text-[var(--personal-text)]";

/**
 * Where a tile goes when tapped. Deliberately the same destinations the pinned
 * *row* had: newest chat, or the editor when the provider cannot run, or start
 * the bot's first chat. `none` is the cold-start tile for a bot with no stored
 * thread — it paints, it just has nowhere to go until the live list lands.
 */
export type PinnedTileTarget =
  | { readonly kind: "thread"; readonly botId: PersonalBotId; readonly threadId: ThreadId }
  | { readonly kind: "botEdit"; readonly botId: PersonalBotId }
  | { readonly kind: "group"; readonly groupId: PersonalGroupId }
  | { readonly kind: "start"; readonly start: () => void; readonly starting: boolean }
  | { readonly kind: "none" };

/**
 * What the badge on a face says. `attention` is every state {@link botStatus}
 * tones as "review" (needs your help / a secret / approval / a reply, a broken
 * provider, a rate limit, an unavailable provider); `working` is a live turn.
 * Attention wins, exactly as it does in the row's status line.
 */
export type PinnedBadge = "attention" | "working";

/**
 * The badge for a bot, read off the row's own status so the face can never
 * disagree with the line the same bot shows in the list below.
 */
export function pinnedBotBadge(summary: BotSummary, now: number): PinnedBadge | null {
  if (botStatus(summary, now).tone === "review") return "attention";
  return summary.live ? "working" : null;
}

/** The same rule for a group, off {@link groupStatusLine} / {@link isGroupRoundLive}. */
export function pinnedGroupBadge(
  round: PersonalGroupRound | null,
  nameOf: (botId: string) => string | null,
): PinnedBadge | null {
  if (groupStatusLine(round, nameOf).tone === "review") return "attention";
  return isGroupRoundLive(round) ? "working" : null;
}

/**
 * The strip itself: a horizontally scrollable list of tiles.
 *
 * No visible heading. A row of faces pinned above a list of chats is the
 * favourites affordance on every phone the owner uses, and an uppercase
 * "PINNED" label would put back a third stacked row of chrome to explain a
 * shape that explains itself [Grok: subtraction]. The region keeps its name
 * for assistive tech (`aria-label="Pinned"`), which is the part that was never
 * decoration.
 *
 * The negative margin lets the tiles scroll out to the true screen edge.
 *
 * `safe center` centres the faces while they fit and falls back to flex-start
 * the moment they overflow, so a long pin list can still be scrolled to its
 * first tile. Plain `center` would push that tile past the scroll origin and
 * make it unreachable; a browser without `safe` ignores the declaration and
 * gets the left-aligned behaviour, which is the same fallback.
 */
export function PinnedStrip({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <section aria-label="Pinned" className="mt-3">
      <ul
        className={cn(
          "-mx-5 flex snap-x snap-proximity gap-3 overflow-x-auto overscroll-x-contain px-5 pb-1",
          "[justify-content:safe_center]",
          "scroll-px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {children}
      </ul>
    </section>
  );
}

/**
 * One face. Tap opens the chat; a long press (or a right-click, or the
 * assistive-tech "Options" button that sits in the tab order beside it) opens
 * the menu holding Unpin.
 *
 * Unpin has to live here: a pinned bot is not in the list below any more, so
 * the swipe-to-delete row's "Unpin" secondary action is unreachable for it.
 * Leaving it only in the bot's own settings would make the strip a one-way
 * door.
 */
export function PinnedTile({
  name,
  avatar,
  badge,
  statusLabel,
  target,
  onUnpin,
  selected = false,
}: {
  readonly name: string;
  readonly avatar: ReactNode;
  readonly badge: PinnedBadge | null;
  /** The row's status text, spoken after the name. Null when there is nothing to say. */
  readonly statusLabel: string | null;
  readonly target: PinnedTileTarget;
  /** Null on the cold-start tile, which has no bot record to update yet. */
  readonly onUnpin: (() => void) | null;
  /** This chat is open in the desktop pane. */
  readonly selected?: boolean | undefined;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchor = useRef<HTMLLIElement | null>(null);
  const pressTimer = useRef(0);
  const pressOrigin = useRef<{ readonly x: number; readonly y: number } | null>(null);
  // A long press that opened the menu must not also follow the link underneath.
  const openedByPress = useRef(false);

  const cancelPress = useCallback(() => {
    if (pressTimer.current !== 0) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = 0;
    }
    pressOrigin.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  const pressProps =
    onUnpin === null
      ? {}
      : {
          onPointerDown: (event: ReactPointerEvent) => {
            if (event.pointerType === "mouse") return;
            pressOrigin.current = { x: event.clientX, y: event.clientY };
            openedByPress.current = false;
            pressTimer.current = window.setTimeout(() => {
              pressTimer.current = 0;
              openedByPress.current = true;
              setMenuOpen(true);
            }, LONG_PRESS_MS);
          },
          onPointerMove: (event: ReactPointerEvent) => {
            const origin = pressOrigin.current;
            if (origin === null) return;
            const moved =
              Math.abs(event.clientX - origin.x) > MOVE_TOLERANCE_PX ||
              Math.abs(event.clientY - origin.y) > MOVE_TOLERANCE_PX;
            // Scrolling the strip is a drag, not a press.
            if (moved) cancelPress();
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

  const content = (
    <>
      {/* Fixed 56px band so a group's cluster, which is shorter than a single
          face, still puts its caption on the same baseline as its neighbours. */}
      <span className="relative flex h-14 items-center">
        {avatar}
        {badge !== null ? (
          <span
            aria-hidden="true"
            data-pinned-badge={badge}
            className={cn(
              "absolute right-0 bottom-0.5 rounded-full ring-2 ring-[var(--personal-bg)]",
              // Size, not only hue, separates the two: the amber "needs you"
              // badge is the bigger of the pair, so the difference survives a
              // colour-blind reading and the pale light-mode amber.
              badge === "attention"
                ? "size-4 bg-[var(--personal-review)]"
                : "size-3 bg-[var(--personal-live)]",
            )}
          />
        ) : null}
      </span>
      <span className={TILE_NAME_CLASS}>{name}</span>
    </>
  );

  // The avatar is an <img> with the bot's name, and the caption repeats it, so
  // the tile states its own name once — plus the status the strip would
  // otherwise have dropped with the preview line.
  const label = statusLabel === null ? name : `${name}, ${statusLabel}`;
  const tileClass = cn(TILE_CLASS, selected && SELECTED_TILE_CLASS);
  const selectedProps = selectedChatProps(selected);

  return (
    <li ref={anchor} className="relative shrink-0 snap-start" style={{ width: TILE_WIDTH_PX }}>
      {target.kind === "thread" ? (
        <Link
          to="/bots/$botId/$threadId"
          params={{ botId: target.botId, threadId: target.threadId }}
          aria-label={label}
          className={tileClass}
          {...selectedProps}
          {...pressProps}
        >
          {content}
        </Link>
      ) : target.kind === "botEdit" ? (
        <Link
          to="/bots/$botId/edit"
          params={{ botId: target.botId }}
          aria-label={`${label}, edit bot`}
          className={tileClass}
          {...selectedProps}
          {...pressProps}
        >
          {content}
        </Link>
      ) : target.kind === "group" ? (
        <Link
          to="/bots/groups/$groupId"
          params={{ groupId: target.groupId }}
          aria-label={`${label}, group chat`}
          className={tileClass}
          {...selectedProps}
          {...pressProps}
        >
          {content}
        </Link>
      ) : target.kind === "start" ? (
        <button
          type="button"
          onClick={target.start}
          disabled={target.starting}
          aria-busy={target.starting}
          aria-label={label}
          className={cn(tileClass, "cursor-pointer disabled:cursor-wait")}
          {...selectedProps}
          {...pressProps}
        >
          {content}
        </button>
      ) : (
        <div aria-label={label} className={tileClass} {...selectedProps} {...pressProps}>
          {content}
        </div>
      )}
      {onUnpin === null ? null : (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          {/*
            The keyboard and VoiceOver route to the same menu the long press
            opens. `sr-only` keeps a button out of a strip whose whole point is
            that it is quiet, while leaving it in the tab order and on the
            VoiceOver swipe path — a long press is not an affordance a screen
            reader can find.
          */}
          {/* A sighted keyboard user tabs onto it too, so it surfaces as a small
              "…" chip on the tile while it holds keyboard focus (WCAG 2.4.7). */}
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
            <Ellipsis aria-hidden="true" className="size-4" strokeWidth={2} />
          </MenuTrigger>
          {/* Anchored on the tile, not on the 1px trigger, so the popup lands
              under the face the owner actually pressed. */}
          <MenuPopup align="center" anchor={anchor} className="personal-app personal-menu min-w-44">
            <MenuItem onClick={onUnpin}>Unpin {name}</MenuItem>
          </MenuPopup>
        </Menu>
      )}
    </li>
  );
}

/** A pinned bot from the live list. */
export function PinnedBotTile({
  environmentId,
  summary,
  now,
  motion,
  onUnpin,
  selected = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly summary: BotSummary;
  readonly now: number;
  /** Pose for this face; the screen caps the continuous one across every row. */
  readonly motion?: AvatarMotion | undefined;
  readonly onUnpin: () => void;
  readonly selected?: boolean | undefined;
}): JSX.Element {
  const { bot, newestThread, provider } = summary;
  const { start, starting } = useStartBotChat(environmentId, bot.botId);
  const status = botStatus(summary, now);
  const badge = pinnedBotBadge(summary, now);
  const target: PinnedTileTarget = !provider.available
    ? { kind: "botEdit", botId: bot.botId }
    : newestThread !== null
      ? { kind: "thread", botId: bot.botId, threadId: newestThread.id }
      : { kind: "start", start: () => void start(), starting };
  return (
    <PinnedTile
      name={bot.name}
      avatar={
        <BotAvatar
          shape={bot.avatarShape}
          color={bot.avatarColor}
          size={PINNED_AVATAR_SIZE}
          label={bot.name}
          motion={motion}
          comet
        />
      }
      badge={badge}
      statusLabel={badge === null ? null : status.label}
      target={target}
      onUnpin={onUnpin}
      selected={selected}
    />
  );
}

/**
 * A pinned group. A group is a chat, so it gets a tile like any other — only
 * the face differs, the same member cluster {@link GroupRow} uses.
 *
 * Note for whoever wires this up: `PersonalGroup` carries no `pinned` flag
 * today (pinning is `isBotPinned`, bot-only), so nothing can put a group in
 * the strip yet. The tile exists so that when the contract gains it, the strip
 * does not have to be redesigned around a second shape.
 */
export function PinnedGroupTile({
  group,
  round,
  bots,
  onUnpin,
  selected = false,
}: {
  readonly group: PersonalGroup;
  readonly round: PersonalGroupRound | null;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly onUnpin: () => void;
  readonly selected?: boolean | undefined;
}): JSX.Element {
  const nameOf = (botId: string) =>
    bots.find((candidate) => candidate.botId === botId)?.name ?? null;
  const badge = pinnedGroupBadge(round, nameOf);
  const status = groupStatusLine(round, nameOf);
  return (
    <PinnedTile
      name={group.name}
      avatar={
        <GroupAvatarCluster
          // Two faces, not the cluster's usual three, and 34px each: the widest
          // the cluster then gets (two faces plus the "+N" counter) is 67px,
          // which still fits the tile's 72px column. The counter still counts
          // every member, so "+N" is not a lie about group size.
          bots={bots.slice(0, 2)}
          memberCount={activeGroupMembers(group).length}
          size={34}
        />
      }
      badge={badge}
      statusLabel={badge === null ? groupSubtitle(group, nameOf) : status.label}
      target={{ kind: "group", groupId: group.groupId }}
      onUnpin={onUnpin}
      selected={selected}
    />
  );
}

/**
 * A pinned bot painted from the cold-start snapshot, before the live list
 * arrives. Neutral by construction: the snapshot stores no live state, so
 * there is no badge and no status to speak — the live tile replaces it in
 * place the moment `personalBots.list` lands.
 */
export function PinnedSnapshotTile({
  row,
  selected = false,
}: {
  readonly row: ChatsSnapshotRow;
  readonly selected?: boolean | undefined;
}): JSX.Element {
  return (
    <PinnedTile
      name={row.name}
      avatar={
        <BotAvatar
          shape={row.avatarShape}
          color={row.avatarColor}
          size={PINNED_AVATAR_SIZE}
          label={row.name}
        />
      }
      badge={null}
      statusLabel={null}
      target={
        row.threadId === null
          ? { kind: "none" }
          : {
              kind: "thread",
              botId: row.botId as PersonalBotId,
              threadId: row.threadId as ThreadId,
            }
      }
      onUnpin={null}
      selected={selected}
    />
  );
}
