import type { JSX } from "react";

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
 * The working comet's SVG (see `avatarComet.ts` for the design). One markup
 * for both callers: `BotAvatar` leaves `seconds` out and the generated CSS
 * spins the comets and drifts their hue; the Remotion Studio passes the time,
 * which bakes the same rotation and colours into attributes, so previews
 * match the app frame for frame.
 */
interface CometTimeProps {
  /** Studio only: time since working began. Omitted in the app (CSS animates). */
  readonly seconds?: number | undefined;
}

/** Gradients and half-orbit clips; `idPrefix` must be unique per avatar. */
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
                className={
                  seconds === undefined ? `bot-avatar-comet-stop-${index}-${stop}` : undefined
                }
                offset={stop / (AVATAR_COMET_STOPS - 1)}
                stopColor={avatarCometStopColor(spec, stop, seconds ?? 0)}
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
 * One half of every comet's orbit: `back` goes under the body, `front` over
 * it. `pixelsPerUnit` is the avatar's rendered size / 100: the strokes ignore
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
  const fade =
    seconds === undefined
      ? undefined
      : Math.min(1, Math.max(0, seconds / AVATAR_COMET_FADE_SECONDS));
  return (
    <g className="bot-avatar-orbit" opacity={fade} aria-hidden="true">
      {AVATAR_COMETS.map((spec, index) => (
        <g
          key={`c${spec.hue}-${spec.rollDeg}`}
          transform={avatarCometOrbitTransform(spec)}
          clipPath={`url(#${idPrefix}-${side}-${index})`}
        >
          <g
            className={
              seconds === undefined ? `bot-avatar-comet bot-avatar-comet-${index}` : undefined
            }
            transform={
              seconds === undefined ? undefined : `rotate(${avatarCometAngle(spec, seconds) % 360})`
            }
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
