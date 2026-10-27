import {
  ChevronRight,
  Download,
  Globe,
  Hand,
  Monitor,
  MousePointer2,
  Shield,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type JSX, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  groupActivity,
  type ActivityGroup,
  type ActivityIcon,
  type ActivityRow,
} from "./computerActivity";
import type { ComputerActivityEvent } from "./computerContract";
import { formatActivityTime } from "./computerModel";
import { ComputerSheet } from "./ComputerSheet";
import { ICON_STROKE } from "./ComputerSourceRow";

const ICONS: Record<ActivityIcon, LucideIcon> = {
  globe: Globe,
  type: Type,
  pointer: MousePointer2,
  monitor: Monitor,
  hand: Hand,
  shield: Shield,
  download: Download,
};

export const EMPTY_ACTIVITY =
  "No activity yet. Each step a bot takes on the computer shows here, newest first.";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

function Row(props: {
  readonly row: ActivityRow;
  readonly more?: number;
  readonly onMore?: () => void;
  readonly onOpenFiles: () => void;
  readonly nested?: boolean;
}): JSX.Element {
  const { row } = props;
  const Icon = ICONS[row.icon];
  const content = (
    <>
      <Icon
        className="size-4 shrink-0 text-[var(--personal-text-secondary)]"
        strokeWidth={ICON_STROKE}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[14px]">
        {row.actor === null ? null : <b className="font-semibold">{row.actor} </b>}
        {row.text}
        {row.outcome !== null ? (
          <span
            className={
              row.failed ? "text-[var(--personal-danger)]" : "text-[var(--personal-text-secondary)]"
            }
          >
            {" "}
            · {row.outcome}
          </span>
        ) : null}
        {props.more ? (
          <span className="text-[var(--personal-text-secondary)]"> · +{props.more} more</span>
        ) : null}
      </span>
      <time
        dateTime={row.at}
        className="shrink-0 text-[13px] text-[var(--personal-text-tertiary)] tabular-nums"
      >
        {formatActivityTime(row.at)}
      </time>
    </>
  );
  const className = cn(
    "flex min-h-11 w-full items-center gap-2.5 px-3.5 text-left",
    props.nested && "pl-8",
    FOCUS,
  );
  if (props.more && props.onMore) {
    return (
      <button type="button" onClick={props.onMore} aria-expanded={false} className={className}>
        {content}
      </button>
    );
  }
  if (row.isDownload) {
    return (
      <button type="button" onClick={props.onOpenFiles} className={className}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

function Group(props: {
  readonly group: ActivityGroup;
  readonly onOpenFiles: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { head, rest } = props.group;
  return (
    <li>
      <Row
        row={head}
        onOpenFiles={props.onOpenFiles}
        {...(rest.length > 0 && !open ? { more: rest.length, onMore: () => setOpen(true) } : {})}
      />
      {open
        ? rest.map((row) => <Row key={row.id} row={row} nested onOpenFiles={props.onOpenFiles} />)
        : null}
    </li>
  );
}

export function ActivityList(props: {
  readonly groups: ReadonlyArray<ActivityGroup>;
  readonly onOpenFiles: () => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <ul className={cn("flex flex-col", props.className)}>
      {props.groups.map((group) => (
        <Group key={group.key} group={group} onOpenFiles={props.onOpenFiles} />
      ))}
    </ul>
  );
}

/** The merged, newest-first timeline of both sources. */
export function ComputerActivityCard(props: {
  readonly events: ReadonlyArray<ComputerActivityEvent>;
  /** Rows to show: 5 on the phone card, 4 beside a chat. */
  readonly limit: number;
  readonly onSeeAll: () => void;
  readonly onOpenFiles: () => void;
  readonly className?: string;
}): JSX.Element {
  const groups = useMemo(
    () => groupActivity(props.events).slice(0, props.limit),
    [props.events, props.limit],
  );
  return (
    <section
      aria-label="Recent activity"
      className={cn(
        "rounded-[14px] border border-[var(--personal-border)] bg-[var(--personal-surface)] pb-1",
        props.className,
      )}
    >
      <div className="flex items-center justify-between pr-1 pl-3.5">
        <h2 className="text-[15px] font-semibold">Recent activity</h2>
        <button
          type="button"
          onClick={props.onSeeAll}
          className={cn(
            "flex h-11 items-center gap-0.5 rounded-[10px] px-3 text-[14px] text-[var(--personal-text-secondary)]",
            FOCUS,
          )}
        >
          See all
          <ChevronRight className="size-4" strokeWidth={ICON_STROKE} aria-hidden />
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="px-3.5 pt-1 pb-3 text-[13px] text-[var(--personal-text-secondary)]">
          {EMPTY_ACTIVITY}
        </p>
      ) : (
        <ActivityList groups={groups} onOpenFiles={props.onOpenFiles} />
      )}
    </section>
  );
}

type SheetTab = "activity" | "files";

/** The last 30 steps, and the browser's saved files (what the Files segment held). */
export function ComputerActivitySheet(props: {
  readonly events: ReadonlyArray<ComputerActivityEvent>;
  readonly files: ReactNode;
  readonly onClose: () => void;
  readonly onOpenFiles: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<SheetTab>("activity");
  const groups = useMemo(() => groupActivity(props.events.slice(0, 30)), [props.events]);
  return (
    <ComputerSheet
      title="Recent activity"
      subtitle="Browser and desktop, newest first"
      onClose={props.onClose}
      testId="computer-activity-sheet"
      toolbar={
        <div
          role="tablist"
          aria-label="Activity or files"
          className="mx-5 mb-2 grid h-11 shrink-0 grid-cols-2 rounded-[10px] bg-[var(--personal-fill-muted)]"
        >
          {(["activity", "files"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex h-11 rounded-[10px] border-2 border-transparent text-[14px]",
                FOCUS,
              )}
            >
              <span
                className={cn(
                  "flex flex-1 items-center justify-center rounded-[8px]",
                  tab === value
                    ? "bg-[var(--personal-surface)] font-semibold shadow-[inset_0_0_0_1px_var(--personal-border)]"
                    : "text-[var(--personal-text-secondary)]",
                )}
              >
                {value === "activity" ? "Activity" : "Files"}
              </span>
            </button>
          ))}
        </div>
      }
    >
      {tab === "files" ? (
        props.files
      ) : groups.length === 0 ? (
        <p className="py-6 text-center text-[14px] text-[var(--personal-text-secondary)]">
          {EMPTY_ACTIVITY}
        </p>
      ) : (
        <ActivityList groups={groups} onOpenFiles={props.onOpenFiles} className="-mx-3.5" />
      )}
    </ComputerSheet>
  );
}
