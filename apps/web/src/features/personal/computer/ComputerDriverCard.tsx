import { Bot, Globe, MessageSquare, Monitor, MousePointer2, Square } from "lucide-react";
import { useState, type JSX } from "react";

import { cn } from "~/lib/utils";

import { BotAvatar } from "../BotAvatar";
import type { ComputerSource } from "./computerContract";
import type { DriverQueue, DriverState, QueueEntry } from "./computerDrivers";
import { DriverAvatar, ICON_STROKE } from "./ComputerSourceRow";
import type { BotFace, BotRef } from "./useBotFaces";

const CARD = "rounded-[14px] border border-[var(--personal-border)] bg-[var(--personal-surface)]";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const SECTION_LABEL = "text-[13px] font-semibold text-[var(--personal-section-label)]";
export const QUEUE_PREVIEW = 3;

function SourceGlyph({ source }: { readonly source: ComputerSource }) {
  return source === "desktop" ? (
    <Monitor className="size-3.5 shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
  ) : (
    <Globe className="size-3.5 shrink-0" strokeWidth={ICON_STROKE} aria-hidden />
  );
}

/** "Up next" and, while you drive, the bot you paused. */
export function UpNext(props: {
  readonly queue: DriverQueue;
  readonly resolveFace: (ref: BotRef) => BotFace | null;
}): JSX.Element | null {
  const { queue } = props;
  const [expanded, setExpanded] = useState(false);
  if (queue.paused === null && queue.next.length === 0) return null;
  const shown = expanded ? queue.next : queue.next.slice(0, QUEUE_PREVIEW);
  const hidden = queue.next.length - shown.length;
  const row = (entry: QueueEntry, position: number | null, note: string) => {
    const face = props.resolveFace(entry);
    return (
      <li key={`${entry.source}:${entry.threadId}`} className="flex min-h-11 items-center gap-3">
        <span className="w-4 text-[13px] text-[var(--personal-text-tertiary)] tabular-nums">
          {position ?? ""}
        </span>
        {face === null ? (
          <span className="size-6 shrink-0" />
        ) : (
          <BotAvatar shape={face.shape} color={face.color} size={24} label="" />
        )}
        <span className="min-w-0 flex-1 truncate text-[14px]">{entry.botName}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
          <SourceGlyph source={entry.source} />
          {note}
        </span>
      </li>
    );
  };
  return (
    <div className="border-t border-[var(--personal-border)] px-3.5 py-2.5">
      {queue.paused !== null ? (
        <>
          <p className={SECTION_LABEL}>Paused</p>
          <ul>{row(queue.paused, null, "resumes after you")}</ul>
        </>
      ) : null}
      {queue.next.length > 0 ? (
        <>
          <p className={cn(SECTION_LABEL, queue.paused !== null && "mt-1.5")}>Up next</p>
          <ul>
            {shown.map((entry, index) =>
              row(entry, index + 1, entry.source === "desktop" ? "Desktop" : "Browser"),
            )}
          </ul>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className={cn(
                "flex min-h-11 w-full items-center text-[13px] text-[var(--personal-text-secondary)]",
                FOCUS,
              )}
            >
              +{hidden} more
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Who is driving the source on screen: avatar, name and model, one status
 * line, a chat button, then the queue. `muted` is the other source's card on
 * the Computer page rail ("in the background"), tapped to switch to it.
 */
export function ComputerDriverCard(props: {
  readonly face: BotFace | null;
  readonly state: DriverState;
  readonly line: string;
  readonly heading?: string;
  /** Replaces the bot's name, e.g. "Last used by Assistant". */
  readonly title?: string;
  readonly queue?: DriverQueue;
  readonly resolveFace: (ref: BotRef) => BotFace | null;
  readonly onOpenChat?: (() => void) | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly className?: string;
}): JSX.Element | null {
  const { face } = props;
  const queued =
    props.queue !== undefined && (props.queue.paused !== null || props.queue.next.length > 0);
  if (face === null && !queued) return null;
  const body = (
    <>
      <DriverAvatar face={face} state={props.state} size={40} dotSize={12} animate />
      <div className="min-w-0 flex-1 text-left">
        <p className="flex items-baseline gap-2">
          <span className="truncate text-[16px] leading-5 font-semibold">
            {props.title ?? face?.name}
          </span>
          {props.title === undefined && face?.model ? (
            <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
              {face.model}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-[var(--personal-text-secondary)]">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{
              backgroundColor:
                props.state === "using" ? "var(--personal-live)" : "var(--personal-text-tertiary)",
            }}
          />
          <span className="truncate">{props.line}</span>
        </p>
      </div>
    </>
  );
  return (
    <section aria-label={props.heading ?? "Driver"} className={cn(CARD, props.className)}>
      {face === null ? null : (
        <div className="flex items-center gap-3 p-3.5">
          {props.onClick === undefined ? (
            <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
          ) : (
            <button
              type="button"
              onClick={props.onClick}
              className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-[10px]", FOCUS)}
            >
              {body}
            </button>
          )}
          {props.onOpenChat === undefined ? null : (
            <button
              type="button"
              aria-label={`Open ${face.name} chat`}
              onClick={props.onOpenChat}
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--personal-border)]",
                FOCUS,
              )}
            >
              <MessageSquare className="size-5" strokeWidth={ICON_STROKE} />
            </button>
          )}
        </div>
      )}
      {!queued || props.queue === undefined ? null : (
        <UpNext queue={props.queue} resolveFace={props.resolveFace} />
      )}
    </section>
  );
}

/** Take control / Hand back and Stop, for whichever source is on screen. */
export function ComputerActions(props: {
  readonly inControl: boolean;
  readonly takeDisabled: boolean;
  readonly takeLabel?: string;
  /** "Hand back to Assistant" when it fits, else "Hand back". */
  readonly handBackLabel: string;
  readonly onTake: () => void;
  readonly onHandBack: () => void;
  readonly stopLabel: string | null;
  readonly onStop: () => void;
  readonly stopDisabled?: boolean;
  readonly note?: string | null;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex items-center gap-2", props.className)}>
      {props.inControl ? (
        <button
          type="button"
          onClick={props.onHandBack}
          className={cn(
            "flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] bg-[var(--personal-primary)] px-4 text-[16px] font-semibold text-[var(--personal-primary-text)]",
            FOCUS,
          )}
        >
          <Bot className="size-[18px] shrink-0" strokeWidth={ICON_STROKE} />
          <span className="truncate">{props.handBackLabel}</span>
        </button>
      ) : (
        <button
          type="button"
          disabled={props.takeDisabled}
          onClick={props.onTake}
          className={cn(
            "flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] bg-[var(--personal-primary)] px-4 text-[16px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-50",
            FOCUS,
          )}
        >
          <MousePointer2 className="size-[18px] shrink-0" strokeWidth={ICON_STROKE} />
          <span className="truncate">{props.takeLabel ?? "Take control"}</span>
        </button>
      )}
      {props.stopLabel === null ? null : (
        <button
          type="button"
          aria-label={props.stopLabel}
          disabled={props.stopDisabled === true}
          onClick={props.onStop}
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-[10px] border border-[var(--personal-border-strong)] disabled:opacity-50",
            FOCUS,
          )}
        >
          <Square className="size-[18px]" strokeWidth={ICON_STROKE} />
        </button>
      )}
      {props.note ? (
        <p className="hidden min-w-0 flex-1 text-[13px] text-[var(--personal-text-secondary)] xl:block">
          {props.note}
        </p>
      ) : null}
    </div>
  );
}
