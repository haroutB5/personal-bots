import type { AnimationEvent, JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { AvatarOrbitLayer } from "./BotAvatarComet";
import { isContinuousMotion, type AvatarMotion } from "./avatarMotion";
import { pauseWhileOffscreen } from "./avatarOffscreen";
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
 * dots. The avatar is then a stack of HTML boxes (body, silhouette, eye pair,
 * each eye's pill, the happy arcs while `done`, the comet's pieces) that
 * `avatarMotion.generated.css` animates: the poses authored in
 * `avatarRemotion/avatarStates.ts`, sampled into CSS keyframes. Boxes, not SVG
 * children, and `transform`, `opacity` and `filter` only: those run on the
 * compositor, so a busy avatar costs the main thread no style, layout or paint
 * per frame however many are on screen (an animation on an SVG child repaints
 * the avatar every frame, on the main thread). The avatar's own box never
 * moves; only `thinking` and `working` repeat, and pause while scrolled out of
 * view (see `personal.css`, `avatarMotion.ts` and `avatarOffscreen.ts`).
 * Without `motion` the markup is the flat SVG original.
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
  const showComet = comet && pose === "working";
  // A loop scrolled out of view pauses (every busy bot in a long list moves).
  const rootRef = useRef<Element | null>(null);
  const setRoot = useCallback((node: Element | null) => {
    rootRef.current = node;
  }, []);
  const looping = pose !== undefined && isContinuousMotion(pose);
  useEffect(() => {
    const element = rootRef.current;
    if (!looping || element === null) return;
    return pauseWhileOffscreen(element);
  }, [looping]);
  const onAnimationEnd = settling
    ? (event: AnimationEvent<Element>) => {
        // Every done layer ends together; any of them retires the pose.
        if (event.animationName.startsWith("bot-avatar-done-")) setSettling(false);
      }
    : undefined;

  if (motion !== undefined) {
    return (
      <span
        ref={setRoot}
        role="img"
        aria-label={label}
        data-motion={pose}
        onAnimationEnd={onAnimationEnd}
        className={cn("bot-avatar shrink-0", className)}
        style={{ width: size, height: size }}
      >
        <span className="bot-avatar-body">
          <svg className="bot-avatar-shape" viewBox={BOT_AVATAR_VIEWBOX} aria-hidden="true">
            {halo ? (
              <SilhouetteHalo d={silhouette.d} roundCorners={silhouette.roundCorners} />
            ) : null}
            <SilhouetteFill d={silhouette.d} roundCorners={silhouette.roundCorners} color={color} />
          </svg>
          {eyes.map((eye) => (
            <span
              key={`${eye.cx}-${eye.cy}`}
              className="bot-avatar-eye"
              style={{
                left: `${eye.cx - BOT_AVATAR_EYE_WIDTH / 2}%`,
                top: `${eye.cy - BOT_AVATAR_EYE_HEIGHT / 2}%`,
                width: `${BOT_AVATAR_EYE_WIDTH}%`,
                height: `${BOT_AVATAR_EYE_HEIGHT}%`,
              }}
            >
              <span className="bot-avatar-pill" style={{ backgroundColor: BOT_AVATAR_EYE_COLOR }} />
              {pose === "done" ? (
                <svg
                  className="bot-avatar-arc"
                  viewBox={`${eye.cx - BOT_AVATAR_EYE_WIDTH / 2} ${eye.cy - BOT_AVATAR_EYE_HEIGHT / 2} ${BOT_AVATAR_EYE_WIDTH} ${BOT_AVATAR_EYE_HEIGHT}`}
                  aria-hidden="true"
                >
                  <path
                    d={botAvatarHappyArcPath(eye.cx, eye.cy)}
                    fill="none"
                    stroke={BOT_AVATAR_EYE_COLOR}
                    strokeWidth={5}
                    strokeLinecap="round"
                  />
                </svg>
              ) : null}
            </span>
          ))}
          {/* A working avatar's comet circles the body: the ring masks hide the stretch behind it. */}
          {showComet ? <AvatarOrbitLayer shape={shape} /> : null}
        </span>
      </span>
    );
  }

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={BOT_AVATAR_VIEWBOX}
      ref={setRoot}
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
