import type { JSX } from "react";
import { useId, useState } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { AvatarCometDefs, AvatarCometLayer } from "./BotAvatarComet";
import { isContinuousMotion, type AvatarMotion } from "./avatarMotion";
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
  /**
   * Draw the rainbow comet orbiting the head while the pose is `working`
   * (`avatarComet.ts`). Off by default: it is the costliest pose, so only the
   * callers that can afford it opt in.
   */
  comet?: boolean | undefined;
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
 * dots. The avatar is then drawn in layers (body, eye pair, each eye's pill and
 * a hidden happy arc) that `avatarMotion.generated.css` animates: the poses
 * authored in `avatarRemotion/avatarStates.ts`, sampled into CSS keyframes.
 * Transform and opacity only, so the avatar's box never moves; only `thinking`
 * and `working` repeat (see `personal.css` and `avatarMotion.ts`). Without
 * `motion` the markup is the flat, unlayered original.
 */
export function BotAvatar({
  shape,
  color,
  size,
  label,
  className,
  motion,
  comet = false,
}: BotAvatarProps): JSX.Element {
  // Work stopping is the one transition that needs its own pose: dropping a
  // continuous loop would snap the avatar back to rest mid-cycle, so `done`
  // plays a small hop that lands exactly on rest. Adjusted during render (no
  // effect, no timer) and cleared by the done animation ending.
  const [settling, setSettling] = useState(false);
  const [lastMotion, setLastMotion] = useState(motion);
  if (lastMotion !== motion) {
    setLastMotion(motion);
    setSettling(lastMotion !== undefined && isContinuousMotion(lastMotion) && motion === "idle");
  }
  const pose = motion === undefined ? undefined : settling ? "done" : motion;
  const silhouette = BOT_AVATAR_SILHOUETTES[shape];
  const eyes = BOT_AVATAR_EYES[shape];
  const eyeRx = BOT_AVATAR_EYE_WIDTH / 2;
  const halo = botAvatarNeedsHalo(color);
  // SVG ids are document-global; strip React's punctuation for url(#...).
  const idPrefix = `bot-avatar${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const showComet = comet && pose === "working";

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={BOT_AVATAR_VIEWBOX}
      data-motion={pose}
      onAnimationEnd={
        settling
          ? (event) => {
              // Every done layer ends together; any of them retires the pose.
              if (event.animationName.startsWith("bot-avatar-done-")) setSettling(false);
            }
          : undefined
      }
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
      {motion === undefined ? (
        <>
          {halo ? <SilhouetteHalo d={silhouette.d} roundCorners={silhouette.roundCorners} /> : null}
          <SilhouetteFill d={silhouette.d} roundCorners={silhouette.roundCorners} color={color} />
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
        </>
      ) : (
        // Posed layers. At rest (no animation running, e.g. idle or reduced
        // motion) they draw exactly the flat avatar above: the eye tilt moves
        // to the parent <g> so the pill's own CSS transform can scale it about
        // its centre, and the happy arc sits at opacity 0 until `done`. The
        // body's own motion moves the whole <svg> (compositor-friendly). The
        // working comet wraps the body: back half below, front half above.
        <>
          {showComet ? <AvatarCometDefs idPrefix={idPrefix} /> : null}
          {showComet ? (
            <AvatarCometLayer idPrefix={idPrefix} side="back" pixelsPerUnit={size / 100} />
          ) : null}
          {halo ? <SilhouetteHalo d={silhouette.d} roundCorners={silhouette.roundCorners} /> : null}
          <SilhouetteFill d={silhouette.d} roundCorners={silhouette.roundCorners} color={color} />
          <g className="bot-avatar-eyes">
            {eyes.map((eye) => (
              <g
                key={`${eye.cx}-${eye.cy}`}
                transform={`rotate(${BOT_AVATAR_EYE_TILT_DEG} ${eye.cx} ${eye.cy})`}
              >
                <rect
                  className="bot-avatar-pill"
                  x={eye.cx - BOT_AVATAR_EYE_WIDTH / 2}
                  y={eye.cy - BOT_AVATAR_EYE_HEIGHT / 2}
                  width={BOT_AVATAR_EYE_WIDTH}
                  height={BOT_AVATAR_EYE_HEIGHT}
                  rx={eyeRx}
                  fill={BOT_AVATAR_EYE_COLOR}
                />
                <path
                  className="bot-avatar-arc"
                  d={botAvatarHappyArcPath(eye.cx, eye.cy)}
                  fill="none"
                  stroke={BOT_AVATAR_EYE_COLOR}
                  strokeWidth={5}
                  strokeLinecap="round"
                  opacity={0}
                />
              </g>
            ))}
          </g>
          {showComet ? (
            <AvatarCometLayer idPrefix={idPrefix} side="front" pixelsPerUnit={size / 100} />
          ) : null}
        </>
      )}
    </svg>
  );
}

function SilhouetteHalo({ d, roundCorners }: { d: string; roundCorners: boolean }): JSX.Element {
  return (
    <path
      d={d}
      fill="none"
      stroke="var(--personal-avatar-halo)"
      strokeWidth={(roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0) + 6}
      strokeLinejoin="round"
    />
  );
}

function SilhouetteFill({
  d,
  roundCorners,
  color,
}: {
  d: string;
  roundCorners: boolean;
  color: string;
}): JSX.Element {
  return (
    <path
      d={d}
      fill={color}
      stroke={roundCorners ? color : "none"}
      strokeWidth={roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0}
      strokeLinejoin="round"
    />
  );
}
