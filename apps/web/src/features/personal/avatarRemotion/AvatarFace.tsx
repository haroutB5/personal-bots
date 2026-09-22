import type { JSX } from "react";
import { useId } from "react";

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
  botAvatarHappyArcPath,
  botAvatarNeedsHalo,
} from "../botAvatarShapes";
import { AvatarCometDefs, AvatarCometLayer } from "../BotAvatarComet";
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
  /**
   * Seconds into the working state: draws the orbiting comet at that time,
   * exactly as the app's CSS would. Omitted for every other state.
   */
  readonly cometSeconds?: number | undefined;
  /** Rendered width in px: the comet's strokes are sized in screen pixels. */
  readonly sizePx?: number | undefined;
}

/**
 * The bot's own parametric avatar (same silhouette, colour, eyes and halo rule
 * as `BotAvatar`) drawn in a given pose. No timing of its own. Studio and
 * renders only; the app draws `BotAvatar` and animates it with the generated
 * keyframes (`avatarMotion.generated.css`).
 * Decorative - the caller carries the accessible label.
 */
export function AvatarFace({
  shape,
  color,
  pose,
  haloColor,
  cometSeconds,
  sizePx = 100,
}: AvatarFaceProps): JSX.Element {
  const idPrefix = `face${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
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
      {cometSeconds === undefined ? null : (
        <>
          <AvatarCometDefs idPrefix={idPrefix} seconds={cometSeconds} />
          <AvatarCometLayer
            idPrefix={idPrefix}
            side="back"
            seconds={cometSeconds}
            pixelsPerUnit={sizePx / 100}
          />
        </>
      )}
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
                  d={botAvatarHappyArcPath(eye.cx, eye.cy)}
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
      {cometSeconds === undefined ? null : (
        <AvatarCometLayer
          idPrefix={idPrefix}
          side="front"
          seconds={cometSeconds}
          pixelsPerUnit={sizePx / 100}
        />
      )}
    </svg>
  );
}
