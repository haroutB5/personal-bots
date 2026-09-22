import type { JSX } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

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
} from "../botAvatarShapes";
import {
  AVATAR_BODY_PIVOT_X as PIVOT_X,
  AVATAR_BODY_PIVOT_Y as PIVOT_Y,
  type AvatarPose,
} from "./pose";

export interface AvatarFaceProps {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly pose: AvatarPose;
  /**
   * Halo stroke for dark-failing colours. The app passes
   * `var(--personal-avatar-halo)`; renders pass the theme's resolved value.
   */
  readonly haloColor: string;
}

/**
 * The bot's own parametric avatar (same silhouette, colour, eyes and halo rule
 * as `BotAvatar`) drawn in a given pose. Pure: no hooks, no timing. Studio and
 * renders only; the app draws `BotAvatar` and animates it with the generated
 * keyframes (`avatarMotion.generated.css`).
 * Decorative - the caller carries the accessible label.
 */
export function AvatarFace({ shape, color, pose, haloColor }: AvatarFaceProps): JSX.Element {
  const silhouette = BOT_AVATAR_SILHOUETTES[shape];
  const eyes = BOT_AVATAR_EYES[shape];
  const halo = botAvatarNeedsHalo(color);
  const bodyTransform =
    `translate(${pose.bodyX} ${pose.bodyY}) ` +
    `translate(${PIVOT_X} ${PIVOT_Y}) rotate(${pose.bodyRotate}) ` +
    `scale(${pose.bodyScaleX} ${pose.bodyScaleY}) translate(${-PIVOT_X} ${-PIVOT_Y})`;
  const pillOpacity = 1 - pose.happy;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="100%"
      height="100%"
      viewBox={BOT_AVATAR_VIEWBOX}
      overflow="visible"
      style={{ display: "block" }}
    >
      <g transform={bodyTransform}>
        {halo ? (
          <path
            d={silhouette.d}
            fill="none"
            stroke={haloColor}
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
        <g transform={`translate(${pose.gazeX} ${pose.gazeY})`}>
          {eyes.map((eye) => (
            <g
              key={`${eye.cx}-${eye.cy}`}
              transform={`rotate(${BOT_AVATAR_EYE_TILT_DEG} ${eye.cx} ${eye.cy})`}
            >
              {pillOpacity > 0.001 ? (
                <rect
                  x={eye.cx - BOT_AVATAR_EYE_WIDTH / 2}
                  y={eye.cy - BOT_AVATAR_EYE_HEIGHT / 2}
                  width={BOT_AVATAR_EYE_WIDTH}
                  height={BOT_AVATAR_EYE_HEIGHT}
                  rx={BOT_AVATAR_EYE_WIDTH / 2}
                  fill={BOT_AVATAR_EYE_COLOR}
                  opacity={pillOpacity}
                  transform={
                    `translate(${eye.cx} ${eye.cy}) scale(${pose.eyeWiden} ${pose.eyeOpen}) ` +
                    `translate(${-eye.cx} ${-eye.cy})`
                  }
                />
              ) : null}
              {pose.happy > 0.001 ? (
                // Happy squint: an upward-bowed stroke ("^") in the pill's place.
                <path
                  d={`M${eye.cx - 4} ${eye.cy + 3}Q${eye.cx} ${eye.cy - 9} ${eye.cx + 4} ${eye.cy + 3}`}
                  fill="none"
                  stroke={BOT_AVATAR_EYE_COLOR}
                  strokeWidth={5}
                  strokeLinecap="round"
                  opacity={pose.happy}
                />
              ) : null}
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}
