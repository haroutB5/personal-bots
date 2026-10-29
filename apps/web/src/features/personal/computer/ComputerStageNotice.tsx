import { Globe, Monitor, PowerOff, type LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "~/lib/utils";

import { ICON_STROKE } from "./ComputerSourceRow";

const OUTLINED =
  "flex h-11 items-center justify-center gap-2 rounded-[10px] border border-[var(--personal-border-strong)] px-4 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50";

/** What the stage shows when there is nothing to stream. */
export function StageNotice(props: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <div
      className={cn(
        "flex min-h-[300px] flex-col items-center justify-center gap-2.5 px-6 py-9 text-center",
        props.className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-[52px] items-center justify-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]"
      >
        <Icon className="size-6" strokeWidth={ICON_STROKE} />
      </span>
      <p className="text-[16px] leading-5 font-semibold">{props.title}</p>
      <p className="max-w-[34ch] text-[14px] leading-5 text-[var(--personal-text-secondary)]">
        {props.detail}
      </p>
      {props.children}
    </div>
  );
}

/** Nobody has the browser or the desktop. */
export function IdleStage(props: {
  readonly canOpenBrave: boolean;
  readonly canViewDesktop: boolean;
  readonly onOpenBrave: () => void;
  readonly onViewDesktop: () => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <StageNotice
      icon={Monitor}
      title="Nothing on screen"
      detail="Bots open Brave or use the desktop when a task needs it. Watch here when they do."
      {...(props.className === undefined ? {} : { className: props.className })}
    >
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          disabled={!props.canOpenBrave}
          onClick={props.onOpenBrave}
          className={OUTLINED}
        >
          <Globe className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
          Open Brave
        </button>
        <button
          type="button"
          disabled={!props.canViewDesktop}
          onClick={props.onViewDesktop}
          className={OUTLINED}
        >
          <Monitor className="size-[18px]" strokeWidth={ICON_STROKE} aria-hidden />
          View desktop
        </button>
      </div>
    </StageNotice>
  );
}

/** The laptop itself cannot be reached. */
export function OfflineStage(props: { readonly className?: string }): JSX.Element {
  return (
    <StageNotice
      icon={PowerOff}
      title="Your laptop is offline"
      detail="The live view comes back by itself when it reconnects. Bots can't use the computer until then."
      {...(props.className === undefined ? {} : { className: props.className })}
    />
  );
}
