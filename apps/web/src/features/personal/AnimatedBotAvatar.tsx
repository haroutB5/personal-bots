import type { JSX } from "react";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { AvatarFace } from "./avatarRemotion/AvatarFace";
import {
  avatarPlayerMode,
  isContinuousAvatarState,
  staticMotionFor,
  type AvatarAnimState,
} from "./avatarRemotion/playerMode";
import { REST_POSE } from "./avatarRemotion/pose";
import { BotAvatar } from "./BotAvatar";

// The only path from the app into Remotion. Idle screens never fetch it.
const AvatarPlayer = lazy(() => import("./avatarRemotion/AvatarPlayer"));

export interface AnimatedBotAvatarProps {
  shape: BotAvatarShape;
  color: string;
  size: number;
  /** Bot name; the accessible label. The animation itself is decorative. */
  label: string;
  className?: string;
  state: AvatarAnimState;
  /**
   * Whether this avatar holds its list's single continuous-motion slot (from
   * `capContinuousMotion`). Defaults to true for one-off avatars such as the
   * conversation header.
   */
  continuousAllowed?: boolean;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

// Server snapshots assume the cheapest case: static.
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true,
  );
}

function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.hidden,
    () => true,
  );
}

/**
 * Bot avatar animated by Remotion (phase A prototype; not wired into screens).
 *
 * Guardrails (see `avatarPlayerMode`): idle, reduced motion, a hidden document
 * and a looping state without the list's continuous slot all render the plain
 * static `BotAvatar` with no Player mounted. Otherwise a lazily loaded Player
 * runs the state's composition: thinking/working loop, waiting/blocked/done
 * play once and then drop the Player for a static final frame.
 *
 * Accessibility is unchanged: this element carries `role="img"` + the bot name
 * exactly like `BotAvatar`; status dots and sr-only labels stay the state
 * channel.
 */
export function AnimatedBotAvatar({
  shape,
  color,
  size,
  label,
  className,
  state,
  continuousAllowed = true,
}: AnimatedBotAvatarProps): JSX.Element {
  // Work stopping plays `done` instead of snapping to rest (as BotAvatar does).
  // Adjusted during render, cleared by the one-shot's `ended`.
  const [settling, setSettling] = useState(false);
  const [lastState, setLastState] = useState(state);
  if (lastState !== state) {
    setLastState(state);
    setSettling(isContinuousAvatarState(lastState) && state === "idle");
  }
  const effective: AvatarAnimState = settling ? "done" : state;

  const reducedMotion = usePrefersReducedMotion();
  const documentHidden = useDocumentHidden();
  const mode = avatarPlayerMode({
    state: effective,
    reducedMotion,
    documentHidden,
    continuousAllowed,
  });

  if (mode === "static" || effective === "idle") {
    return (
      <BotAvatar
        shape={shape}
        color={color}
        size={size}
        label={label}
        {...(className === undefined ? {} : { className })}
        motion={staticMotionFor(effective, continuousAllowed)}
      />
    );
  }

  const rest = (
    <AvatarFace
      shape={shape}
      color={color}
      pose={REST_POSE}
      haloColor="var(--personal-avatar-halo)"
    />
  );
  return (
    <span
      role="img"
      aria-label={label}
      data-avatar-state={effective}
      className={cn("inline-block shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <span aria-hidden="true" style={{ display: "block", width: size, height: size }}>
        <Suspense fallback={rest}>
          <AvatarPlayer
            key={effective}
            shape={shape}
            color={color}
            state={effective}
            size={size}
            loop={mode === "loop"}
            onEnded={effective === "done" ? () => setSettling(false) : undefined}
          />
        </Suspense>
      </span>
    </span>
  );
}
