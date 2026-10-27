import { Crosshair, Globe, Monitor } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { BotAvatar } from "../BotAvatar";
import type { ComputerSource } from "./computerContract";
import type { DriverState } from "./computerDrivers";
import type { BotFace } from "./useBotFaces";

export const ICON_STROKE = 1.75;

export interface SourceBadge {
  readonly face: BotFace | null;
  readonly state: DriverState;
  /** The driver acted while this source is not on screen: pulse the dot once. */
  readonly pulse: boolean;
}

const LABELS: Record<ComputerSource, string> = { browser: "Browser", desktop: "Desktop" };

function dotColor(state: DriverState): string {
  if (state === "using") return "var(--personal-live)";
  if (state === "you") return "var(--personal-control)";
  return "var(--personal-text-tertiary)";
}

/** The driver's avatar with its status dot, at the size the row needs. */
export function DriverAvatar(props: {
  readonly face: BotFace | null;
  readonly state: DriverState;
  readonly size: number;
  readonly dotSize: number;
  readonly pulse?: boolean;
  /** Pose the avatar while its bot works (the driver card only: small ones stay still). */
  readonly animate?: boolean;
}): JSX.Element | null {
  const { face } = props;
  if (face === null) return null;
  return (
    <span
      className="relative inline-flex shrink-0"
      style={{ width: props.size, height: props.size }}
    >
      <BotAvatar
        shape={face.shape}
        color={face.color}
        size={props.size}
        label=""
        {...(props.animate === true && props.state === "using"
          ? { motion: "working" as const }
          : {})}
      />
      <span
        aria-hidden
        data-pulse={props.pulse ? "" : undefined}
        className="computer-driver-dot absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-[var(--personal-bg)]"
        style={{
          width: props.dotSize,
          height: props.dotSize,
          backgroundColor: dotColor(props.state),
        }}
      />
    </span>
  );
}

/**
 * Browser / Desktop segments, each carrying its driver's avatar, and the Auto
 * toggle. The segments are a tablist: the stage under them is the panel.
 */
export function ComputerSourceRow(props: {
  readonly shown: ComputerSource;
  readonly auto: boolean;
  readonly badges: Record<ComputerSource, SourceBadge>;
  readonly desktopAvailable: boolean;
  /** Why Desktop is unavailable, when the server says; shown as the tab's tooltip. */
  readonly desktopUnavailableReason?: string | null;
  readonly disabled: boolean;
  readonly onSelect: (source: ComputerSource) => void;
  readonly onToggleAuto: () => void;
  /** Sits at the right of the row (the Hand back pill while you control the desktop). */
  readonly trailing?: ReactNode | undefined;
  /** Extra classes for the tab list, e.g. a max width on the wide page. */
  readonly tabsClassName?: string | undefined;
  readonly className?: string;
}): JSX.Element {
  const sources: ReadonlyArray<ComputerSource> = ["browser", "desktop"];
  return (
    <div
      className={cn("flex items-center gap-2", props.disabled && "opacity-[.45]", props.className)}
    >
      <div
        role="tablist"
        aria-label="Computer view"
        className={cn(
          "grid h-11 min-w-0 flex-1 grid-cols-2 rounded-[10px] bg-[var(--personal-fill-muted)]",
          props.tabsClassName,
        )}
      >
        {sources.map((source) => {
          const badge = props.badges[source];
          const selected = props.shown === source;
          const unavailable = source === "desktop" && !props.desktopAvailable;
          const driver =
            badge.face !== null && badge.state === "using"
              ? `, ${badge.face.name} using it`
              : badge.face !== null && badge.state === "idle"
                ? `, ${badge.face.name} left it open`
                : "";
          return (
            <button
              key={source}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={`${LABELS[source]}${driver}`}
              disabled={props.disabled || unavailable}
              title={unavailable ? (props.desktopUnavailableReason ?? undefined) : undefined}
              onClick={() => props.onSelect(source)}
              className="flex h-11 min-w-0 rounded-[10px] border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-inset disabled:cursor-not-allowed"
            >
              <span
                className={cn(
                  "flex min-w-0 flex-1 items-center justify-center gap-[7px] rounded-[8px] text-[14px]",
                  selected
                    ? "bg-[var(--personal-surface)] font-semibold shadow-[inset_0_0_0_1px_var(--personal-border)]"
                    : "text-[var(--personal-text-secondary)]",
                  unavailable && "opacity-60",
                )}
              >
                {source === "browser" ? (
                  <Globe className="size-[18px] shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
                ) : (
                  <Monitor className="size-[18px] shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
                )}
                <span className="truncate">{LABELS[source]}</span>
                <DriverAvatar
                  face={badge.face}
                  state={badge.state}
                  size={18}
                  dotSize={6}
                  pulse={badge.pulse}
                />
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-pressed={props.auto}
        disabled={props.disabled}
        onClick={props.onToggleAuto}
        className={cn(
          "flex h-11 min-w-[76px] shrink-0 items-center justify-center gap-2 rounded-[10px] border px-3 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
          props.auto
            ? "border-[var(--personal-border-strong)] bg-[var(--personal-surface)] font-semibold text-[var(--personal-text)]"
            : "border-[var(--personal-border)] bg-transparent text-[var(--personal-text-secondary)]",
        )}
      >
        <Crosshair className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
        Auto
      </button>
      {props.trailing === undefined || props.trailing === null ? null : (
        <div className="ml-auto flex min-w-0 items-center gap-3 pl-2">{props.trailing}</div>
      )}
    </div>
  );
}
