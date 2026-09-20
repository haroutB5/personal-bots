import type { JSX } from "react";
import { useState } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import {
  BOT_AVATAR_EYE_COLOR,
  BOT_AVATAR_EYE_HEIGHT,
  BOT_AVATAR_EYE_TILT_DEG,
  BOT_AVATAR_EYE_WIDTH,
  BOT_AVATAR_EYES,
  BOT_AVATAR_ROUND_CORNER_STROKE,
  BOT_AVATAR_SILHOUETTES,
  BOT_AVATAR_VIEWBOX,
  botAvatarNeedsHalo,
} from "./botAvatarShapes";

export type { BotAvatarShape } from "@t3tools/contracts";

export interface BotAvatarProps {
  shape: BotAvatarShape;
  color: string;
  size: number;
  /** Bot name; used as the accessible label. */
  label: string;
  className?: string;
  /**
   * Express the bot's state in the avatar's pose. Omitted (the default) renders
   * the plain static avatar — pickers, the team diagram and settings pass
   * nothing and are unaffected.
   */
  motion?: AvatarMotion | undefined;
}

/**
 * Flat geometric bot avatar: single-colour silhouette + two black slanted pill
 * eyes. No mouth, gradient, shadow or 3D (see `.plans/ui-spec.md`). The status
 * dot is rendered next to the name by the row, never on the avatar.
 * Deterministic: same props always produce the same SVG.
 *
 * On a dark surface the silhouette gets a hairline halo (see below) so the
 * near-black swatches stay visible. The stored colour is never changed.
 *
 * With `motion`, the pose carries the bot's state as decoration on top of those
 * dots. Everything is transform-only, so the avatar's box never moves, and only
 * `working` repeats (see `personal.css` and `avatarMotion.ts`).
 */
export function BotAvatar({
  shape,
  color,
  size,
  label,
  className,
  motion,
}: BotAvatarProps): JSX.Element {
  // Work stopping is the one transition that needs its own pose: dropping the
  // continuous bob would snap the avatar back to rest mid-cycle, so `done`
  // plays it out. Adjusted during render (no effect, no timer) and cleared by
  // the settle animation ending.
  const [settling, setSettling] = useState(false);
  const [lastMotion, setLastMotion] = useState(motion);
  if (lastMotion !== motion) {
    setLastMotion(motion);
    setSettling(lastMotion === "working" && motion === "idle");
  }
  const pose = motion === undefined ? undefined : settling ? "done" : motion;
  const silhouette = BOT_AVATAR_SILHOUETTES[shape];
  const eyes = BOT_AVATAR_EYES[shape];
  const eyeRx = BOT_AVATAR_EYE_WIDTH / 2;
  const halo = botAvatarNeedsHalo(color);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={BOT_AVATAR_VIEWBOX}
      data-motion={pose}
      onAnimationEnd={settling ? () => setSettling(false) : undefined}
      className={cn("bot-avatar shrink-0", className)}
    >
      {/*
        Contrast halo. Bot colours are user data and are never rewritten for
        the theme, so a near-black bot would otherwise be a black shape on a
        black card. Same path, stroked only — the fill covers the inner half,
        so all that shows is a hairline outside the silhouette, and the
        artwork's geometry is untouched. `--personal-avatar-halo` is
        `transparent` in light mode, where every swatch already separates.

        Only the colours that fail 3:1 against the dark card get it
        (`botAvatarNeedsHalo`): the halo is strong enough to read against
        #171717, and at that strength an unconditional one would make every
        saturated avatar in the chats list look deliberately bordered.
      */}
      {halo ? (
        <path
          d={silhouette.d}
          fill="none"
          stroke="var(--personal-avatar-halo)"
          strokeWidth={(silhouette.roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0) + 6}
          strokeLinejoin="round"
        />
      ) : null}
      <path
        d={silhouette.d}
        fill={color}
        stroke={silhouette.roundCorners ? color : "none"}
        strokeWidth={silhouette.roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0}
        strokeLinejoin="round"
      />
      <g className="bot-avatar-eyes">
        {eyes.map((eye) => (
          <rect
            key={`${eye.cx}-${eye.cy}`}
            x={eye.cx - BOT_AVATAR_EYE_WIDTH / 2}
            y={eye.cy - BOT_AVATAR_EYE_HEIGHT / 2}
            width={BOT_AVATAR_EYE_WIDTH}
            height={BOT_AVATAR_EYE_HEIGHT}
            rx={eyeRx}
            fill={BOT_AVATAR_EYE_COLOR}
            transform={`rotate(${BOT_AVATAR_EYE_TILT_DEG} ${eye.cx} ${eye.cy})`}
          />
        ))}
      </g>
    </svg>
  );
}
