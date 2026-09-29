import type { JSX } from "react";
import { useEffect, useRef } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Crown, Plus } from "lucide-react";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import { inertOutside } from "./overlayInert";
import { NEW_TEAM_ZONE_ID, teamDropZoneId } from "./teamDiagramModel";
import type { MoveTargetRow } from "./teamConstellationModel";

/** Where the token rides against the finger, so the finger never hides the card it is over. */
const TOKEN_OFFSET = { x: -40, y: -52 } as const;

/**
 * The page zoomed out to one small drop card per team, shown while a bot is
 * lifted (or, after a release over nothing or from the list's Move button,
 * waiting for a tap). A card is "join this team"; its round seat is "make it the
 * lead". Nothing needs scrolling mid-drag.
 *
 * The cards are read from the DOM through their `data-drop-zone` attributes
 * (see `zoneAt` in the screen), so the layout is free to change without a
 * second copy of the geometry.
 */
export function TeamMoveOverlay({
  bot,
  rows,
  facesByTeam,
  leadBots,
  hotZoneId,
  hint,
  hintTone,
  dragPoint,
  interactive,
  onPick,
  onNewTeam,
  onCancel,
}: {
  readonly bot: PersonalBot;
  readonly rows: ReadonlyArray<MoveTargetRow>;
  readonly facesByTeam: ReadonlyMap<string, ReadonlyArray<PersonalBot>>;
  readonly leadBots: ReadonlyMap<string, PersonalBot>;
  /** The zone the finger is over, lit up. */
  readonly hotZoneId: string | null;
  readonly hint: string;
  readonly hintTone: "info" | "review";
  /** While dragging: where the finger is. Null in tap mode. */
  readonly dragPoint: { readonly x: number; readonly y: number } | null;
  /** Tap mode: cards are buttons and focus moves in. */
  readonly interactive: boolean;
  readonly onPick: (zoneId: string) => void;
  readonly onNewTeam: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  // The page behind never scrolls while the cards are up.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let scroller: HTMLElement | null = root.parentElement;
    while (scroller !== null) {
      const overflowY = getComputedStyle(scroller).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      scroller = scroller.parentElement;
    }
    const previousOverflow = scroller?.style.overflowY ?? "";
    if (scroller !== null) scroller.style.overflowY = "hidden";
    return () => {
      if (scroller !== null) scroller.style.overflowY = previousOverflow;
    };
  }, []);

  // In tap mode nothing behind the cards takes a tap or a Tab. Not while a
  // finger is dragging: the bot it holds is behind the cards, and an inert
  // element would stop receiving that finger's moves.
  useEffect(() => {
    const root = rootRef.current;
    if (!interactive || root === null) return;
    return inertOutside(root);
  }, [interactive]);

  // Tap mode is a dialog: focus goes to its first target and Esc closes it.
  useEffect(() => {
    if (!interactive) return;
    firstRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactive, onCancel]);

  let firstTargetTaken = false;
  const claimFirst = () => {
    if (firstTargetTaken) return undefined;
    firstTargetTaken = true;
    return firstRef;
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Move ${bot.name}`}
      data-team-move-overlay=""
      className="fixed inset-x-0 top-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 flex flex-col overflow-hidden bg-[var(--personal-bg)] pt-[env(safe-area-inset-top)] md:bottom-0"
    >
      <div className="px-5 pt-3">
        <p
          className={cn(
            "rounded-[14px] px-3.5 py-3 text-[15px] leading-5 font-semibold shadow-[var(--personal-shadow-lift)]",
            hintTone === "review"
              ? "border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] text-[var(--personal-review-text)]"
              : "bg-[var(--personal-text)] text-[var(--personal-bg)]",
          )}
        >
          {hint}
        </p>
      </div>
      <div className="personal-team-cards min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-3 pb-6">
        <ul className="grid gap-2.5">
          {rows.map((row) => {
            const leadZone = teamDropZoneId({ kind: "lead", team: row.team });
            const teamZone = teamDropZoneId({ kind: "team", team: row.team });
            const leadBot = row.leadBotId === null ? null : (leadBots.get(row.leadBotId) ?? null);
            const joinable = row.join.kind !== "none";
            const leadable = row.lead.kind !== "none";
            const hotTeam = hotZoneId === teamZone;
            const hotLead = hotZoneId === leadZone;
            const blocked = row.join.kind === "blocked" || row.lead.kind === "blocked";
            const faces = (facesByTeam.get(row.team) ?? []).filter(
              (face) => face.botId !== row.leadBotId,
            );
            const subtitle = row.here
              ? `${bot.name} is here now`
              : row.leadName === null
                ? "No lead · drop on the seat to lead"
                : `Led by ${row.leadName} · drop on ${row.leadName} to lead`;
            return (
              <li key={row.team}>
                <div
                  data-drop-zone={teamZone}
                  className={cn(
                    "relative flex min-h-[104px] items-center gap-3.5 rounded-[18px] border-[1.5px] bg-[var(--personal-surface)] p-3",
                    row.here
                      ? "border-solid border-[var(--personal-border)]"
                      : "border-dashed border-[var(--personal-border-strong)] not-dark:border-[var(--personal-team-recent)]",
                    hotTeam &&
                      "border-solid border-[var(--personal-primary)] bg-[color-mix(in_srgb,var(--personal-primary)_10%,var(--personal-surface))]",
                    blocked &&
                      !row.here &&
                      "border-[var(--personal-review-border)] bg-[var(--personal-review-bg)]",
                  )}
                >
                  <button
                    type="button"
                    ref={leadable ? claimFirst() : undefined}
                    data-drop-zone={leadZone}
                    disabled={!interactive || !leadable}
                    onClick={() => onPick(leadZone)}
                    aria-label={
                      leadable ? `Make ${bot.name} the ${row.label} lead` : `${row.label} lead seat`
                    }
                    className={cn(
                      "grid size-16 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] enabled:active:scale-95 motion-safe:transition-transform",
                      leadBot === null
                        ? "border-2 border-dashed border-[var(--personal-border-strong)] bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)] not-dark:border-[var(--personal-team-recent)]"
                        : "shadow-[0_0_0_2px_var(--personal-primary)]",
                      hotLead &&
                        "scale-110 border-[3px] border-solid border-[var(--personal-team-live)] bg-[color-mix(in_srgb,var(--personal-team-live)_18%,var(--personal-surface))] text-[var(--personal-text)] shadow-none",
                    )}
                  >
                    {leadBot === null ? (
                      <Crown aria-hidden="true" className="size-4" strokeWidth={2} />
                    ) : (
                      <BotAvatar
                        shape={leadBot.avatarShape}
                        color={leadBot.avatarColor}
                        size={48}
                        label=""
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    ref={!leadable && joinable ? claimFirst() : undefined}
                    disabled={!interactive || !joinable}
                    onClick={() => onPick(teamZone)}
                    aria-label={
                      joinable
                        ? `Move ${bot.name} to the ${row.label}`
                        : `${row.label}: ${bot.name} is already here`
                    }
                    className="min-h-[76px] min-w-0 flex-1 rounded-[10px] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
                  >
                    <span className="block truncate text-base leading-5 font-bold text-[var(--personal-text)]">
                      {row.label}
                    </span>
                    <span className="mt-px mb-1.5 block text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                      {subtitle}
                    </span>
                    <span aria-hidden="true" className="flex flex-wrap gap-[3px]">
                      {faces.slice(0, 24).map((face) => (
                        <BotAvatar
                          key={face.botId}
                          shape={face.avatarShape}
                          color={face.avatarColor}
                          size={20}
                          label=""
                        />
                      ))}
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              data-drop-zone={NEW_TEAM_ZONE_ID}
              disabled={!interactive}
              onClick={onNewTeam}
              className={cn(
                "flex min-h-16 w-full items-center justify-center gap-2 rounded-[18px] border-[1.5px] border-dashed border-[var(--personal-border-strong)] bg-[var(--personal-surface)] text-[15px] font-semibold text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] not-dark:border-[var(--personal-team-recent)]",
                hotZoneId === NEW_TEAM_ZONE_ID &&
                  "border-solid border-[var(--personal-primary)] bg-[color-mix(in_srgb,var(--personal-primary)_10%,var(--personal-surface))]",
              )}
            >
              <Plus aria-hidden="true" className="size-5" strokeWidth={2} />
              New team with {bot.name}
            </button>
          </li>
        </ul>
        {interactive ? (
          <button
            type="button"
            onClick={onCancel}
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-[var(--personal-radius-button)] text-[15px] font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {dragPoint === null ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none fixed z-50 grid size-14 place-items-center rounded-full bg-[var(--personal-surface)] shadow-[var(--personal-shadow-lift),0_0_0_2px_var(--personal-primary)]"
          style={{
            left: dragPoint.x + TOKEN_OFFSET.x,
            top: dragPoint.y + TOKEN_OFFSET.y,
            transform: "translate(-50%, -50%) rotate(-4deg)",
          }}
        >
          <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={40} label="" />
        </span>
      )}
    </div>
  );
}
