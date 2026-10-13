import type { CSSProperties, JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Crown, Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import type { TeamGroup } from "./teamDiagramModel";
import type { TeamCaption, TeamCaptionTone } from "./teamCaption";
import {
  buildConstellationLayout,
  HUB_AVATAR,
  NODE_AVATAR,
  NODE_WIDTH,
} from "./teamConstellationModel";
import type { TeamDragHandlers } from "./useTeamBotDrag";

const DEFAULT_SKY_WIDTH = 348;

export interface ConstellationBot {
  readonly bot: PersonalBot;
  /** "Sonnet 5.5 · H": the model and effort the caption shows when idle. */
  readonly modelLabel: string | null;
  /** A turn is running now. */
  readonly live: boolean;
  /** The card's own words for what the bot is doing ({@link teamBotCaption}). */
  readonly caption: TeamCaption;
  /** An approval, a question, a secret or browser help is waiting on the owner. */
  readonly needsYou: boolean;
  /** Who a running handoff to this bot is for, when there is one. */
  readonly workingFor: string | null;
}

const RING_CLASS =
  "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)]";

/** The caption's colour per tone: the design tokens Frontend adds, with the tokens they alias. */
const TONE_CLASS: Record<TeamCaptionTone, string> = {
  working: "text-[var(--personal-state-working,var(--personal-live))]",
  needs: "text-[var(--personal-state-needs,var(--personal-review-text))]",
  thinking: "text-[var(--personal-state-thinking,var(--personal-text-secondary))]",
  idle: "text-[var(--personal-state-idle,var(--personal-text-tertiary))]",
};

/** The amber ring a bot waiting on the owner gets, 4 px outside its avatar. */
const NEEDS_RING_CLASS =
  "ring-2 ring-[var(--personal-state-needs,var(--personal-review-text))] ring-offset-4 ring-offset-[var(--personal-surface)]";

function bots(count: number): string {
  return `${String(count)} ${count === 1 ? "bot" : "bots"}`;
}

/**
 * The line under the team's name: "3 working · 1 needs you", or nothing at
 * all. A bot that is thinking counts as working - it is mid-turn, just quiet -
 * the same way the Bots list reads it.
 */
function teamStatusLine(entries: ReadonlyArray<ConstellationBot>): {
  readonly working: number;
  readonly needs: number;
} {
  return {
    working: entries.filter(
      (entry) => entry.caption.tone === "working" || entry.caption.tone === "thinking",
    ).length,
    needs: entries.filter((entry) => entry.needsYou).length,
  };
}

/**
 * One team as a card (design A): the lead is the hub, its members orbit it on
 * one ring dotted at 0.8 opacity, and every label sits on its own plate, so
 * the line never runs through text. Each caption says what the bot is doing -
 * a step in green, a state word, or the model with effort when it is idle -
 * and a bot the owner owes something wears the amber ring.
 *
 * The header keeps the whole count in words ("N bots · Move") and opens the
 * members sheet, which is also where a crowded card's "+N" seat leads.
 */
export function TeamConstellationCard({
  group,
  label,
  lead,
  members,
  custom,
  removable,
  removeBusy,
  draggingBotId,
  movingBotId,
  handlersFor,
  onOpenMembers,
  onRemove,
}: {
  readonly group: TeamGroup;
  readonly label: string;
  readonly lead: ConstellationBot | null;
  readonly members: ReadonlyArray<ConstellationBot>;
  readonly custom: boolean;
  readonly removable: boolean;
  readonly removeBusy: boolean;
  readonly draggingBotId: string | null;
  /** A bot whose move is sent and not yet confirmed by the refreshed list. */
  readonly movingBotId: string | null;
  readonly handlersFor: (botId: string) => TeamDragHandlers;
  readonly onOpenMembers: (team: string) => void;
  readonly onRemove: (team: string) => void;
}): JSX.Element {
  const skyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_SKY_WIDTH);
  useEffect(() => {
    const element = skyRef.current;
    if (element === null) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => buildConstellationLayout(members.length, width),
    [members.length, width],
  );
  const total = members.length + (lead === null ? 0 : 1);
  const entries = lead === null ? members : [lead, ...members];
  const status = teamStatusLine(entries);
  // The "+N" seat is the layout's last seat; the members it hides are in the sheet.
  const drawnMembers = layout.hidden > 0 ? members.slice(0, layout.slots.length - 1) : members;
  const seat = layout.slots[layout.slots.length - 1];

  return (
    <section
      data-team={group.team}
      aria-label={`${label}, ${bots(total)}`}
      className="relative mb-4 overflow-hidden rounded-2xl border border-[var(--personal-border)] bg-[var(--personal-surface)] shadow-[var(--personal-shadow-card)]"
    >
      <div className="relative z-[3] flex items-center gap-2 pt-4 pr-3 pl-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[20px] leading-6 font-bold text-[var(--personal-text)]">
            {label}
          </h2>
          {status.working === 0 && status.needs === 0 ? null : (
            <p className="mt-0.5 text-[13px] leading-4 font-semibold text-[var(--personal-text-secondary)]">
              {status.working > 0 ? (
                <span className={TONE_CLASS.working}>{status.working} working</span>
              ) : null}
              {status.working > 0 && status.needs > 0 ? " · " : null}
              {status.needs > 0 ? (
                <span className={TONE_CLASS.needs}>{status.needs} needs you</span>
              ) : null}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onOpenMembers(group.team)}
          aria-label={`See all ${bots(total)} on ${label}, or move them`}
          className="flex h-11 shrink-0 items-center gap-1 rounded-full bg-[var(--personal-fill-muted)] pr-2.5 pl-3.5 text-[15px] leading-5 font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          {bots(total)} · Move
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-[var(--personal-text-secondary)]"
            strokeWidth={2}
          />
        </button>
        {custom ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`${label} options`}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                />
              }
            >
              <Ellipsis aria-hidden="true" className="size-5" strokeWidth={1.75} />
            </MenuTrigger>
            <MenuPopup align="end" className="personal-app personal-menu min-w-44">
              <MenuItem disabled={!removable || removeBusy} onClick={() => onRemove(group.team)}>
                {removable ? "Remove team" : "Remove team (move its bots first)"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>

      <div ref={skyRef} className="relative" style={{ height: layout.height }}>
        <svg
          aria-hidden="true"
          width={layout.width}
          height={layout.height}
          className="pointer-events-none absolute inset-0"
        >
          {layout.slots.length === 0 ? null : (
            <ellipse
              cx={layout.hub.x}
              cy={layout.hub.y}
              rx={layout.rx}
              ry={layout.ry}
              fill="none"
              stroke="var(--personal-border-strong)"
              strokeWidth="1.5"
              strokeDasharray="2 6"
              strokeLinecap="round"
              opacity=".8"
            />
          )}
        </svg>

        {lead === null ? (
          <div
            role="img"
            aria-label="No lead. Drop a bot here to make it the lead."
            className="absolute z-[2] flex w-[160px] flex-col items-center"
            style={{ left: layout.hub.x, top: layout.hub.y - 36, transform: "translateX(-50%)" }}
          >
            <span className="grid size-[72px] place-items-center rounded-full border-2 border-dashed border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]">
              <Crown aria-hidden="true" className="size-4" strokeWidth={2} />
            </span>
            <span className="lbl relative -mt-3 rounded-md bg-[var(--personal-surface)] px-1 text-sm font-semibold text-[var(--personal-text-secondary)]">
              No lead
            </span>
          </div>
        ) : (
          <HubNode
            entry={lead}
            x={layout.hub.x}
            y={layout.hub.y}
            handlers={handlersFor(lead.bot.botId)}
            lifted={draggingBotId === lead.bot.botId}
            moving={movingBotId === lead.bot.botId}
          />
        )}

        {drawnMembers.map((entry, index) => {
          const slot = layout.slots[index];
          if (slot === undefined) return null;
          return (
            <MemberNode
              key={entry.bot.botId}
              entry={entry}
              x={slot.x}
              y={slot.y}
              handlers={handlersFor(entry.bot.botId)}
              lifted={draggingBotId === entry.bot.botId}
              moving={movingBotId === entry.bot.botId}
            />
          );
        })}

        {layout.hidden > 0 && seat !== undefined ? (
          <button
            type="button"
            onClick={() => onOpenMembers(group.team)}
            aria-label={`${String(layout.hidden)} more bots on ${label}. See all.`}
            className="absolute z-[2] flex flex-col items-center rounded-[10px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
            style={nodeStyle(seat.x, seat.y, false)}
          >
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-full border-2 border-dashed border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] text-[13px] font-bold"
            >
              +{layout.hidden}
            </span>
            <span className="lbl mt-1 rounded-md bg-[var(--personal-surface)] px-1 text-[13px] leading-4 font-semibold text-[var(--personal-text-secondary)]">
              See all
            </span>
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The words a node is announced by: its name, its role, what its caption says
 * ("Atlas, team lead, Planning release 2.4" - the model when it is idle) and,
 * for a bot the lead handed work to, who it works for.
 */
function nodeAccessibleName(entry: ConstellationBot, isLead: boolean): string {
  const { bot, caption, workingFor } = entry;
  return [
    bot.name,
    isLead ? "team lead" : "",
    caption.text,
    workingFor === null ? "" : `working for ${workingFor}`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Where a node sits: the avatar's centre on the ring, its column centred on it. */
function nodeStyle(x: number, y: number, lifted: boolean): CSSProperties {
  return {
    left: x,
    top: y - NODE_AVATAR / 2,
    width: NODE_WIDTH,
    transform: "translateX(-50%)",
    // pan-y keeps a flick scrolling the page; the long press that lifts a bot
    // blocks touchmove itself once it matures.
    touchAction: "pan-y pinch-zoom",
    // iOS starts text selection and its callout on the same long press that
    // lifts a bot; the node must never be selectable.
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    opacity: lifted ? 0.35 : 1,
  };
}

function MemberNode({
  entry,
  x,
  y,
  handlers,
  lifted,
  moving,
}: {
  readonly entry: ConstellationBot;
  readonly x: number;
  readonly y: number;
  readonly handlers: TeamDragHandlers;
  readonly lifted: boolean;
  readonly moving: boolean;
}): JSX.Element {
  const { bot, caption } = entry;
  const style = nodeStyle(x, y, lifted);
  return (
    <Link
      to="/bots/$botId"
      params={{ botId: bot.botId }}
      {...handlers}
      draggable={false}
      data-bot-node={bot.botId}
      title={bot.name}
      aria-label={nodeAccessibleName(entry, false)}
      aria-busy={moving}
      className="absolute z-[2] flex flex-col items-center rounded-[10px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      style={{ ...style, opacity: moving ? 0.7 : style.opacity }}
    >
      <span
        className={cn(
          "flex size-9 items-center justify-center",
          RING_CLASS,
          entry.needsYou && NEEDS_RING_CLASS,
          moving && "motion-safe:animate-pulse",
        )}
      >
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={NODE_AVATAR} label="" />
      </span>
      <span className="lbl mt-1 flex flex-col items-center rounded-md bg-[var(--personal-surface)] px-1">
        <span
          aria-hidden="true"
          className="line-clamp-2 max-w-[88px] text-center text-[13px] leading-4 font-semibold [overflow-wrap:anywhere]"
        >
          {moving ? "Moving…" : bot.name}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "text-center text-[13px] leading-4 whitespace-nowrap",
            TONE_CLASS[caption.tone],
          )}
        >
          {caption.text}
        </span>
      </span>
    </Link>
  );
}

function HubNode({
  entry,
  x,
  y,
  handlers,
  lifted,
  moving,
}: {
  readonly entry: ConstellationBot;
  readonly x: number;
  readonly y: number;
  readonly handlers: TeamDragHandlers;
  readonly lifted: boolean;
  readonly moving: boolean;
}): JSX.Element {
  const { bot, caption } = entry;
  return (
    <Link
      to="/bots/$botId"
      params={{ botId: bot.botId }}
      {...handlers}
      draggable={false}
      data-bot-node={bot.botId}
      title={bot.name}
      aria-label={nodeAccessibleName(entry, true)}
      aria-busy={moving}
      className="absolute z-[2] flex flex-col items-center rounded-[14px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      style={{
        left: x,
        // The crown sits 15 px above the disc, so the column starts there.
        top: y - HUB_AVATAR / 2 - 15,
        width: 160,
        transform: "translateX(-50%)",
        touchAction: "pan-y pinch-zoom",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        WebkitTapHighlightColor: "transparent",
        opacity: lifted ? 0.35 : moving ? 0.7 : 1,
      }}
    >
      <span className="relative flex size-16 items-center justify-center">
        <span
          aria-hidden="true"
          className="absolute -top-[15px] left-1/2 grid size-[22px] -translate-x-1/2 place-items-center rounded-full bg-[var(--personal-surface)]"
        >
          <Crown aria-hidden="true" className={cn("size-3.5", TONE_CLASS.needs)} strokeWidth={2} />
        </span>
        <span
          className={cn(
            "flex size-16 items-center justify-center",
            RING_CLASS,
            entry.needsYou && NEEDS_RING_CLASS,
            moving && "motion-safe:animate-pulse",
          )}
        >
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={HUB_AVATAR} label="" />
        </span>
      </span>
      <span className="lbl mt-1.5 flex flex-col items-center rounded-md bg-[var(--personal-surface)] px-1">
        <span
          aria-hidden="true"
          className="max-w-[160px] text-center text-[17px] leading-[22px] font-bold [overflow-wrap:anywhere]"
        >
          {moving ? "Moving…" : bot.name}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "max-w-[160px] truncate text-center text-[13px] leading-4 font-medium",
            TONE_CLASS[caption.tone],
          )}
        >
          {caption.text}
        </span>
      </span>
    </Link>
  );
}
