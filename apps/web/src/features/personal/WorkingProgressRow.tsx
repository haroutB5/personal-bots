import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar, type BotAvatarShape } from "./BotAvatar";
import { THINKING_LABEL } from "./conversationModel";
import { formatWorkingElapsed, spokenWorkingElapsed } from "./workingElapsed";

/** The fold at the end of a turn (SPEC 2.9, D2): height and opacity, 220 ms. */
export const PROGRESS_FOLD_MS = 220;
/** At most one step change this often; the steps in between are skipped (SPEC 2.9, D3). */
export const PROGRESS_STEP_THROTTLE_MS = 1_500;

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
 * The latest step, moved on at most once per {@link PROGRESS_STEP_THROTTLE_MS}:
 * a tool-heavy turn writes steps far faster than anyone reads them, and every
 * change is a line of text the eye has to catch. The newest step wins - the
 * ones in between are skipped, never queued.
 */
function useThrottledStep(step: string | null): string | null {
  const [shown, setShown] = useState(step);
  // The row's first step counts as a change: a step written a moment after it
  // waits for the throttle like any other.
  const lastChangeRef = useRef(Date.now());
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (step === shown || step === null) return;
    const wait = Math.max(0, lastChangeRef.current + PROGRESS_STEP_THROTTLE_MS - Date.now());
    const apply = () => {
      pendingRef.current = null;
      lastChangeRef.current = Date.now();
      setShown(step);
    };
    if (wait === 0) {
      apply();
      return;
    }
    if (pendingRef.current !== null) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(apply, wait);
    return () => {
      if (pendingRef.current !== null) clearTimeout(pendingRef.current);
      pendingRef.current = null;
    };
  }, [step, shown]);
  return shown;
}

/**
 * The working chat's progress row, docked above the composer (SPEC 2.9): the
 * latest real step from the running turn, "Working · 4m 12s" ticking every
 * second from `latestTurn.startedAt`, and the comet avatar. No fake numbers:
 * with no step yet it says Thinking/Working, and with no start time it shows
 * no elapsed. A step change is throttled to one per 1.5 s, and the row folds
 * (height + opacity) when the turn ends.
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
  const shownStep = useThrottledStep(step);
  if (!mounted) return null;

  const label = shownStep ?? (thinking ? THINKING_LABEL : "Working");
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
        <span
          // A new step rises in from 6 px below (SPEC 2.9); the key restarts it.
          key={label}
          className="personal-progress-step truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]"
        >
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
