import type { CSSProperties, JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Crown, Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import type { TeamGroup } from "./teamDiagramModel";
import {
  buildConstellationLayout,
  nodeLabel,
  NODE_AVATAR,
  NODE_WIDTH,
  spokeIsClear,
  spokeLine,
  spokeWidth,
} from "./teamConstellationModel";
import type { TeamDragHandlers } from "./useTeamBotDrag";

const DEFAULT_SKY_WIDTH = 348;

export interface ConstellationBot {
  readonly bot: PersonalBot;
  readonly modelLabel: string | null;
  /** The bot has a turn running now. */
  readonly live: boolean;
  /** Who a running handoff to this bot is for, when there is one. */
  readonly workingFor: string | null;
}

/** The lead's handoffs to a member: how many this week, and whether one is open. */
export interface ConstellationSpoke {
  readonly recent: number;
  readonly running: boolean;
}

const RING_CLASS =
  "rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)]";

function bots(count: number): string {
  return `${String(count)} ${count === 1 ? "bot" : "bots"}`;
}

/**
 * One team as a card: the lead is the hub, the members orbit it, and a spoke
 * runs from the hub to every member the lead handed work to this week (thicker
 * for more, green and dashed while one is running). Every spoke starts at the
 * hub, so no two ever cross.
 *
 * A name wraps to two lines under its avatar and the model label is on the
 * node's accessible name; the full names and models are in the list the
 * "N bots" button opens, which is also where a crowded team's overflow goes.
 */
export function TeamConstellationCard({
  group,
  label,
  lead,
  members,
  spokes,
  maxSpoke,
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
  /** Keyed by member bot id. */
  readonly spokes: ReadonlyMap<string, ConstellationSpoke>;
  readonly maxSpoke: number;
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

  const lines = useMemo(() => members.map((entry) => nodeLabel(entry.bot.name)), [members]);
  const layout = useMemo(() => buildConstellationLayout(lines, width), [lines, width]);
  const total = members.length + (lead === null ? 0 : 1);
  const drawnMembers = layout.hidden > 0 ? members.slice(0, layout.slots.length - 1) : members;

  // A spoke that would run behind another node is not drawn: that member shows
  // its week's count on the avatar instead.
  const { spokeMarks, counted } = useMemo(() => {
    const marks: Array<
      {
        botId: string;
        line: { x1: number; y1: number; x2: number; y2: number };
      } & ConstellationSpoke
    > = [];
    const behind = new Map<string, number>();
    if (lead === null) return { spokeMarks: marks, counted: behind };
    drawnMembers.forEach((entry, index) => {
      const slot = layout.slots[index];
      const info = spokes.get(entry.bot.botId);
      if (slot === undefined || info === undefined) return;
      const line = spokeLine(layout.hub, slot);
      if (line !== null && spokeIsClear(layout, index)) {
        marks.push({ botId: entry.bot.botId, line, ...info });
      } else if (info.recent > 0) {
        behind.set(entry.bot.botId, info.recent);
      }
    });
    return { spokeMarks: marks, counted: behind };
  }, [drawnMembers, layout, lead, spokes]);
  const anyRunning = spokeMarks.some((mark) => mark.running);
  const anyRecent = spokeMarks.some((mark) => !mark.running && mark.recent > 0);
  const leadName = lead?.bot.name ?? "";

  return (
    <section
      data-team={group.team}
      aria-label={`${label}, ${bots(total)}`}
      className="relative mb-3.5 overflow-hidden rounded-[18px] border border-[var(--personal-border)] bg-[var(--personal-surface)] shadow-[var(--personal-shadow-card)]"
    >
      <div className="relative z-[3] flex min-h-12 items-center gap-1 pt-2 pr-1 pl-4">
        <h2 className="min-w-0 truncate text-[17px] leading-6 font-bold text-[var(--personal-text)]">
          {label}
        </h2>
        <button
          type="button"
          onClick={() => onOpenMembers(group.team)}
          aria-label={`See all ${bots(total)} on ${label}`}
          className="flex min-h-11 min-w-11 flex-1 items-center gap-0.5 rounded-[var(--personal-radius-button)] px-1 text-left text-[13px] text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          {bots(total)}
          <ChevronRight aria-hidden="true" className="size-4" strokeWidth={2} />
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
          {layout.orbits.map((orbit, index) => (
            <ellipse
              key={`orbit:${String(index)}`}
              cx={layout.hub.x}
              cy={layout.hub.y}
              rx={orbit.rx}
              ry={orbit.ry}
              fill="none"
              stroke="var(--personal-border)"
              strokeWidth="1.5"
              strokeDasharray="2 5"
            />
          ))}
          {spokeMarks.map((mark) =>
            mark.running ? (
              <line
                key={`spoke:${mark.botId}`}
                {...mark.line}
                stroke="var(--personal-team-live)"
                strokeWidth="3"
                strokeDasharray="8 5"
                strokeLinecap="round"
                className="personal-team-spoke-live"
              />
            ) : (
              <line
                key={`spoke:${mark.botId}`}
                {...mark.line}
                stroke="var(--personal-team-line)"
                strokeWidth={spokeWidth(mark.recent, maxSpoke)}
                strokeLinecap="round"
                opacity={anyRunning ? 0.45 : 1}
              />
            ),
          )}
        </svg>

        {lead === null ? (
          <div
            role="img"
            aria-label="No lead. Drop a bot here to make it the lead."
            className="absolute z-[2] flex w-[132px] flex-col items-center"
            style={{ left: layout.hub.x, top: layout.hub.y - 36, transform: "translateX(-50%)" }}
          >
            <span className="grid size-[72px] place-items-center rounded-full border-2 border-dashed border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)] not-dark:border-[var(--personal-team-recent)]">
              <Crown aria-hidden="true" className="size-4" strokeWidth={2} />
            </span>
            <span className="relative -mt-3 flex min-h-[26px] items-center rounded-full bg-[var(--personal-surface)] px-3 text-sm font-semibold text-[var(--personal-text-secondary)] shadow-[0_0_0_1px_var(--personal-border)]">
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
              handoffs={spokes.get(entry.bot.botId)?.recent ?? 0}
              showCount={counted.has(entry.bot.botId)}
            />
          );
        })}

        {layout.hidden > 0 ? (
          <MoreNode
            x={layout.slots[layout.slots.length - 1]!.x}
            y={layout.slots[layout.slots.length - 1]!.y}
            hidden={layout.hidden}
            label={label}
            onOpen={() => onOpenMembers(group.team)}
          />
        ) : null}
      </div>

      {anyRunning || anyRecent ? (
        <div className="relative z-[3] flex flex-wrap gap-x-3.5 gap-y-1 px-4 pb-3.5 text-xs text-[var(--personal-text-secondary)]">
          {anyRunning ? (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden="true" width="22" height="4">
                <line
                  x1="1"
                  y1="2"
                  x2="21"
                  y2="2"
                  stroke="var(--personal-team-live)"
                  strokeWidth="3"
                  strokeDasharray="6 4"
                  strokeLinecap="round"
                />
              </svg>
              Working now for {leadName}
            </span>
          ) : null}
          {anyRecent || anyRunning ? (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden="true" width="22" height="6">
                <line
                  x1="1"
                  y1="3"
                  x2="21"
                  y2="3"
                  stroke="var(--personal-team-line)"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              </svg>
              Handoffs from {leadName} this week, thicker is more
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function nodeAccessibleName(entry: ConstellationBot, isLead: boolean, handoffs = 0): string {
  const { bot, modelLabel, workingFor } = entry;
  return [
    bot.name,
    isLead ? "team lead" : "",
    modelLabel ?? "",
    workingFor === null ? (entry.live ? "working" : "") : `working for ${workingFor}`,
    handoffs > 0 ? `${String(handoffs)} ${handoffs === 1 ? "handoff" : "handoffs"} this week` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function MemberNode({
  entry,
  x,
  y,
  handlers,
  lifted,
  moving,
  handoffs,
  showCount,
}: {
  readonly entry: ConstellationBot;
  readonly x: number;
  readonly y: number;
  readonly handlers: TeamDragHandlers;
  readonly lifted: boolean;
  readonly moving: boolean;
  /** Handoffs from the lead this week. */
  readonly handoffs: number;
  /** No spoke was drawn to this node, so its count is shown on the avatar. */
  readonly showCount: boolean;
}): JSX.Element {
  const { bot, live, workingFor } = entry;
  const working = workingFor !== null;
  const style: CSSProperties = {
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
    opacity: lifted ? 0.35 : moving ? 0.7 : 1,
  };
  return (
    <Link
      to="/bots/$botId"
      params={{ botId: bot.botId }}
      {...handlers}
      draggable={false}
      data-bot-node={bot.botId}
      title={bot.name}
      aria-label={nodeAccessibleName(entry, false, handoffs)}
      aria-busy={moving}
      className="absolute z-[2] flex min-h-11 flex-col items-center gap-[3px] rounded-[10px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      style={style}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative flex size-10 items-center justify-center",
          RING_CLASS,
          working &&
            "ring-2 ring-[var(--personal-team-live)] ring-offset-2 ring-offset-[var(--personal-surface)]",
          moving && "motion-safe:animate-pulse",
        )}
      >
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={NODE_AVATAR} label="" />
        {showCount ? (
          <span className="absolute -top-1 -right-2 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[var(--personal-text)] px-1 text-[11px] leading-none font-bold text-[var(--personal-bg)]">
            {handoffs}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex max-w-full items-start justify-center gap-1 rounded bg-[var(--personal-surface)] px-[3px] text-center text-[12px] leading-[15px] font-semibold",
          working || live ? "text-[var(--personal-team-live)]" : "text-[var(--personal-text)]",
        )}
      >
        {working || live ? (
          <span className="mt-[3.5px] size-2 shrink-0 rounded-full bg-[var(--personal-team-live)]" />
        ) : null}
        <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
          {moving ? "Moving…" : bot.name}
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
  const { bot, modelLabel } = entry;
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
      className="absolute z-[2] flex w-[132px] flex-col items-center rounded-[14px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      style={{
        left: x,
        top: y - 36,
        transform: "translateX(-50%)",
        touchAction: "pan-y pinch-zoom",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        userSelect: "none",
        WebkitTapHighlightColor: "transparent",
        opacity: lifted ? 0.35 : moving ? 0.7 : 1,
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-[72px] place-items-center rounded-full bg-[var(--personal-surface)] shadow-[0_0_0_2px_var(--personal-primary)]",
          moving && "motion-safe:animate-pulse",
        )}
      >
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={56} label="" />
      </span>
      <span
        aria-hidden="true"
        className="relative -mt-3 flex min-h-[26px] max-w-full items-center gap-1.5 rounded-full bg-[var(--personal-surface)] py-0.5 pr-1 pl-2.5 text-base leading-5 font-bold shadow-[0_0_0_1px_var(--personal-border)]"
      >
        <span className="min-w-0 truncate">{moving ? "Moving…" : bot.name}</span>
        <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-[var(--personal-primary)] px-[7px] text-[11px] leading-none font-semibold text-[var(--personal-primary-text)]">
          Lead
        </span>
      </span>
      {modelLabel === null ? null : (
        <span
          aria-hidden="true"
          className="mt-0.5 max-w-full truncate rounded-md bg-[var(--personal-surface)] px-1.5 text-xs leading-[18px] text-[var(--personal-text-secondary)]"
        >
          {modelLabel}
        </span>
      )}
    </Link>
  );
}

function MoreNode({
  x,
  y,
  hidden,
  label,
  onOpen,
}: {
  readonly x: number;
  readonly y: number;
  readonly hidden: number;
  readonly label: string;
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${String(hidden)} more bots on ${label}. See all.`}
      className="absolute z-[2] flex min-h-11 flex-col items-center gap-[3px] rounded-[10px] text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      style={{
        left: x,
        top: y - NODE_AVATAR / 2,
        width: NODE_WIDTH,
        transform: "translateX(-50%)",
      }}
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-full border-2 border-dashed border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] text-[13px] font-bold not-dark:border-[var(--personal-team-recent)]"
      >
        +{hidden}
      </span>
      <span
        aria-hidden="true"
        className="rounded bg-[var(--personal-surface)] px-[3px] text-[12px] leading-[15px] font-semibold text-[var(--personal-text-secondary)]"
      >
        See all
      </span>
    </button>
  );
}
