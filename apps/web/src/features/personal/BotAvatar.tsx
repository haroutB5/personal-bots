import type { JSX } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import {
  BOT_AVATAR_EYE_COLOR,
  BOT_AVATAR_EYE_HEIGHT,
  BOT_AVATAR_EYE_TILT_DEG,
  BOT_AVATAR_EYE_WIDTH,
  BOT_AVATAR_EYES,
  BOT_AVATAR_SILHOUETTES,
  BOT_AVATAR_VIEWBOX,
} from "./botAvatarShapes";

export type { BotAvatarShape } from "@t3tools/contracts";

export interface BotAvatarProps {
  shape: BotAvatarShape;
  color: string;
  size: number;
  /** Bot name; used as the accessible label. */
  label: string;
  className?: string;
}

/**
 * Flat geometric bot avatar: single-colour silhouette + two black slanted pill
 * eyes. No mouth, gradient, shadow or 3D (see `.plans/ui-spec.md`). The status
 * dot is rendered next to the name by the row, never on the avatar.
 * Deterministic: same props always produce the same SVG.
 */
export function BotAvatar({ shape, color, size, label, className }: BotAvatarProps): JSX.Element {
  const silhouette = BOT_AVATAR_SILHOUETTES[shape];
  const eyes = BOT_AVATAR_EYES[shape];
  const eyeRx = BOT_AVATAR_EYE_WIDTH / 2;

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={BOT_AVATAR_VIEWBOX}
      className={cn("shrink-0", className)}
    >
      <path
        d={silhouette.d}
        fill={color}
        stroke={silhouette.roundCorners ? color : "none"}
        strokeWidth={silhouette.roundCorners ? 7 : 0}
        strokeLinejoin="round"
      />
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
    </svg>
  );
}
