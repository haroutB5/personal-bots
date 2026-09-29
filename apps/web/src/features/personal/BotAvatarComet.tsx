import type { JSX } from "react";

import type { BotAvatarShape } from "@t3tools/contracts";

import {
  AVATAR_COMET_FADE_SECONDS,
  AVATAR_COMET_STOPS,
  AVATAR_COMETS,
  avatarCometAngle,
  avatarCometClipRect,
  avatarCometGradientAxis,
  avatarCometOrbitTransform,
  avatarCometSegments,
  avatarCometStopColor,
} from "./avatarComet";

/**
 * The working comet, for the app: HTML boxes that only ever move by
 * `transform` and `filter`, so the compositor animates them and the main
 * thread does nothing per frame (`avatarComet.ts`, "Compositor renderer"; the
 * pieces are styled by `avatarMotion.generated.css`). Drawn above the body:
 * each ring's mask already hides the stretch of orbit behind it.
 */
export function AvatarOrbitLayer({ shape }: { readonly shape: BotAvatarShape }): JSX.Element {
  return (
    <span className="bot-avatar-orbit" aria-hidden="true">
      {AVATAR_COMETS.map((spec, index) => (
        <span
          key={`${spec.hue}-${spec.rollDeg}`}
          className={`bot-avatar-ring bot-avatar-ring-${shape}-${index}`}
        >
          <span className={`bot-avatar-frame bot-avatar-frame-${index}`}>
            <span className={`bot-avatar-conic bot-avatar-conic-${index}`} />
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The working comet's SVG (see `avatarComet.ts` for the design), for the
 * Remotion Studio only: it passes the time, which bakes the rotation and
 * colours into attributes, frame by frame. The app draws `AvatarOrbitLayer`.
 */
interface CometTimeProps {
  /** Time since working began. */
  readonly seconds: number;
}

/** Gradients and half-orbit clips (Studio); `idPrefix` must be unique per avatar. */
export function AvatarCometDefs({
  idPrefix,
  seconds,
}: CometTimeProps & { readonly idPrefix: string }): JSX.Element {
  return (
    <defs>
      {AVATAR_COMETS.map((spec, index) => {
        const axis = avatarCometGradientAxis(spec);
        return (
          <linearGradient
            key={`g${spec.hue}-${spec.rollDeg}`}
            id={`${idPrefix}-comet-${index}`}
            gradientUnits="userSpaceOnUse"
            x1={axis.x1}
            y1={axis.y1}
            x2={axis.x2}
            y2={axis.y2}
          >
            {Array.from({ length: AVATAR_COMET_STOPS }, (_, stop) => (
              <stop
                key={stop}
                offset={stop / (AVATAR_COMET_STOPS - 1)}
                stopColor={avatarCometStopColor(spec, stop, seconds)}
              />
            ))}
          </linearGradient>
        );
      })}
      {AVATAR_COMETS.flatMap((spec, index) =>
        (["back", "front"] as const).map((side) => {
          const rect = avatarCometClipRect(spec, side);
          return (
            <clipPath key={`${side}${index}`} id={`${idPrefix}-${side}-${index}`}>
              <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} />
            </clipPath>
          );
        }),
      )}
    </defs>
  );
}

/**
 * One half of every comet's orbit (Studio): `back` goes under the body,
 * `front` over it. `pixelsPerUnit` is the avatar's rendered size / 100: the strokes ignore
 * transforms (`non-scaling-stroke`), so their width is given in screen pixels.
 */
export function AvatarCometLayer({
  idPrefix,
  side,
  pixelsPerUnit,
  seconds,
}: CometTimeProps & {
  readonly idPrefix: string;
  readonly side: "back" | "front";
  readonly pixelsPerUnit: number;
}): JSX.Element {
  const fade = Math.min(1, Math.max(0, seconds / AVATAR_COMET_FADE_SECONDS));
  return (
    <g opacity={fade} aria-hidden="true">
      {AVATAR_COMETS.map((spec, index) => (
        <g
          key={`c${spec.hue}-${spec.rollDeg}`}
          transform={avatarCometOrbitTransform(spec)}
          clipPath={`url(#${idPrefix}-${side}-${index})`}
        >
          <g
            transform={`rotate(${avatarCometAngle(spec, seconds) % 360})`}
            fill="none"
            stroke={`url(#${idPrefix}-comet-${index})`}
            strokeLinecap="round"
          >
            {avatarCometSegments(spec).map((segment) => (
              <path
                key={segment.d}
                d={segment.d}
                strokeWidth={Math.round(segment.width * pixelsPerUnit * 100) / 100}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        </g>
      ))}
    </g>
  );
}
