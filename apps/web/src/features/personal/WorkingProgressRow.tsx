import type { JSX } from "react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar, type BotAvatarShape } from "./BotAvatar";
import { THINKING_LABEL } from "./conversationModel";
import { formatWorkingElapsed, spokenWorkingElapsed } from "./workingElapsed";

/** The fold at the end of a turn (SPEC 2.9, D2): height and opacity, 220 ms. */
export const PROGRESS_FOLD_MS = 220;

/** A clock that ticks once a second while the row is live. */
function useSecondNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * The working chat's progress row, docked above the composer (SPEC 2.9): the
 * latest real step from the running turn, "Working · 4m 12s" ticking every
 * second from `latestTurn.startedAt`, and the comet avatar. No fake numbers:
 * with no step yet it says Thinking/Working, and with no start time it shows
 * no elapsed. The row folds (height + opacity) when the turn ends.
 */
export function WorkingProgressRow({
  botName,
  face,
  motion,
  comet,
  step,
  thinking,
  startedAtMs,
  working,
}: {
  botName: string;
  face: { readonly shape: BotAvatarShape; readonly color: string } | null;
  motion: AvatarMotion;
  comet: boolean;
  /** The running turn's latest real step, or null before it has one. */
  step: string | null;
  thinking: boolean;
  startedAtMs: number | null;
  working: boolean;
}): JSX.Element | null {
  const [mounted, setMounted] = useState(working);
  const [open, setOpen] = useState(working);
  useEffect(() => {
    if (working) {
      setMounted(true);
      setOpen(true);
      return;
    }
    setOpen(false);
    const timer = window.setTimeout(() => setMounted(false), PROGRESS_FOLD_MS);
    return () => window.clearTimeout(timer);
  }, [working]);

  const now = useSecondNow(mounted && working);
  if (!mounted) return null;

  const label = step ?? (thinking ? THINKING_LABEL : "Working");
  const elapsedMs = startedAtMs === null ? null : Math.max(0, now - startedAtMs);
  const elapsed = elapsedMs === null ? null : formatWorkingElapsed(elapsedMs);
  const spoken = elapsedMs === null ? "" : `, ${spokenWorkingElapsed(elapsedMs)}`;

  return (
    <div
      data-testid="working-progress"
      data-open={open ? "true" : "false"}
      role="status"
      // The label carries the state for VoiceOver, but this text changes every
      // second: a polite live region would announce it on every tick.
      aria-live="off"
      aria-label={`${botName} is working: ${label}${spoken}`}
      className="personal-progress flex items-center gap-3 pr-4 pl-3"
    >
      {face === null ? (
        <span
          aria-hidden="true"
          className="size-8 shrink-0 rounded-full bg-[var(--personal-fill-muted)]"
        />
      ) : (
        <BotAvatar
          shape={face.shape}
          color={face.color}
          size={32}
          label={botName}
          motion={motion}
          comet={comet}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
          {label}
        </span>
        <span className="text-[13px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
          <span className="font-semibold text-[var(--personal-state-working)]">Working</span>
          {elapsed === null ? null : ` · ${elapsed}`}
        </span>
      </span>
    </div>
  );
}
