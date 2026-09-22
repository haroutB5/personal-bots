/**
 * The working avatar's "comet": a rainbow, tapered arc orbiting the head on a
 * tilted ellipse, passing behind the body on one half of the orbit and in
 * front of it on the other. The look is xAI's Grok Bot widget (particles with
 * `orbit: {lam, tilt, roll, rad}`, a 5-stop `hsl(hue + a * span, 56%,
 * 56..67%)` gradient from tail to head, a hue that drifts over time); the
 * engine is not. Theirs is a JS rAF loop; this one is static SVG that CSS
 * animates (see `avatarMotion.generated.css`):
 *
 * - the orbit frame is a static `<g>`: translate to the head centre, roll,
 *   then `scale(1, squash)` for the tilt;
 * - inside it, a `<g class="bot-avatar-comet">` spins with a CSS `rotate`, so
 *   the comet travels the ellipse;
 * - the comet is a few stroked arcs of the orbit circle (a taper), with
 *   `non-scaling-stroke` so the squash bends them but never thins them;
 * - it is drawn twice, clipped to the back and front halves of the orbit,
 *   below and above the body;
 * - the hue drift animates the gradient's `stop-color`s. No filters.
 *
 * Geometry is in the avatar's 0-100 viewBox, in the orbit frame before the
 * squash: the head of the comet sits at angle 0 (the top, which is the front
 * half, as in xAI's projection) and the tail trails back anticlockwise.
 *
 * No `remotion` import: `BotAvatar` (the app), `AvatarFace` (Studio) and the
 * keyframe generator all read this module.
 */

export interface AvatarCometSpec {
  /** Orbit radius before the squash. */
  readonly radius: number;
  /** Vertical squash of the orbit (sin of the tilt). */
  readonly squash: number;
  /** In-plane roll of the orbit, degrees. */
  readonly rollDeg: number;
  /** Trail length along the orbit, radians. */
  readonly arc: number;
  /** Stroke width at the head, viewBox units; the tail is about half (xAI's `.5 + .5 * t` taper). */
  readonly width: number;
  /** One full orbit. */
  readonly orbitSeconds: number;
  /** Where on the orbit the head starts, degrees. */
  readonly startDeg: number;
  /** Hue at the tail at time 0, degrees. */
  readonly hue: number;
  /** Hue change from tail to head, degrees (either direction). */
  readonly hueSpan: number;
}

/** Orbit centre: the middle of the silhouettes' common box. */
export const AVATAR_COMET_CENTER_X = 50;
export const AVATAR_COMET_CENTER_Y = 50;

/**
 * Two comets on flat, differently rolled planes, seeded from xAI's palette
 * (#f9705c coral, #5b95f0 blue). Their orbit radius is 116 on a 114-radius
 * head and the trail is ~5% of the head across; ours keeps both ratios on
 * the ~90-unit head.
 */
export const AVATAR_COMETS: readonly AvatarCometSpec[] = [
  {
    radius: 45,
    squash: 0.26,
    rollDeg: -8,
    arc: 2.8,
    width: 6,
    orbitSeconds: 1.8,
    startDeg: 0,
    hue: 7,
    hueSpan: 70,
  },
  {
    radius: 46,
    squash: 0.34,
    rollDeg: 18,
    arc: 2.2,
    width: 4.6,
    orbitSeconds: 2.7,
    startDeg: 190,
    hue: 217,
    hueSpan: -60,
  },
];

/** A full trip round the hue wheel (xAI drifts 18-42 deg/s; this is 36). */
export const AVATAR_COMET_HUE_SECONDS = 10;

/** Gradient stops from tail (0) to head (1), as in xAI's widget. */
export const AVATAR_COMET_STOPS = 5;

/** Fade-in when working starts (xAI grows a comet in over ~0.26s). */
export const AVATAR_COMET_FADE_SECONDS = 0.4;

function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function point(radius: number, angle: number): string {
  return `${round(radius * Math.sin(angle))} ${round(-radius * Math.cos(angle))}`;
}

/** Stroke segments per comet: each a little wider, tail to head. */
export const AVATAR_COMET_SEGMENTS = 4;

export interface AvatarCometSegment {
  /** An arc of the orbit circle (orbit frame, before the squash). */
  readonly d: string;
  /** Stroke width in viewBox units, on screen (the stroke ignores the squash). */
  readonly width: number;
}

/**
 * The comet as stroked arcs of the orbit circle, from the tail (angle `-arc`)
 * to the head (angle 0), each segment wider than the last (xAI's taper runs
 * from half to full width). They are stroked with `vector-effect:
 * non-scaling-stroke`, so the tilt squash bends the path onto the ellipse but
 * never thins the trail, as in xAI's projected 2D trail. Round caps overlap
 * the joins.
 */
export function avatarCometSegments(spec: AvatarCometSpec): AvatarCometSegment[] {
  const slice = spec.arc / AVATAR_COMET_SEGMENTS;
  return Array.from({ length: AVATAR_COMET_SEGMENTS }, (_, index) => {
    const from = -spec.arc + index * slice;
    const to = from + slice;
    return {
      d: `M${point(spec.radius, from)}A${spec.radius} ${spec.radius} 0 0 1 ${point(spec.radius, to)}`,
      width: round(spec.width * (0.5 + (0.5 * (index + 1)) / AVATAR_COMET_SEGMENTS)),
    };
  });
}

/** Gradient axis (userSpaceOnUse, orbit frame): from the tail to the head. */
export function avatarCometGradientAxis(spec: AvatarCometSpec): {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
} {
  return {
    x1: round(spec.radius * Math.sin(-spec.arc)),
    y1: round(-spec.radius * Math.cos(-spec.arc)),
    x2: 0,
    y2: round(-spec.radius),
  };
}

/** Static orbit-frame transform (SVG attribute syntax). */
export function avatarCometOrbitTransform(spec: AvatarCometSpec): string {
  return (
    `translate(${AVATAR_COMET_CENTER_X} ${AVATAR_COMET_CENTER_Y}) ` +
    `rotate(${spec.rollDeg}) scale(1 ${spec.squash})`
  );
}

/** Lightness of stop `index`: 56% at the tail to 67% at the head. */
export function avatarCometStopLightness(index: number): number {
  return Math.round(56 + (11 * index) / (AVATAR_COMET_STOPS - 1));
}

/** Hue of stop `index` at time 0. */
export function avatarCometStopHue(spec: AvatarCometSpec, index: number): number {
  return spec.hue + (spec.hueSpan * index) / (AVATAR_COMET_STOPS - 1);
}

/** Stop colour at `seconds` into the working state (Studio, and the CSS's frame 0). */
export function avatarCometStopColor(
  spec: AvatarCometSpec,
  index: number,
  seconds: number,
): string {
  const hue = avatarCometStopHue(spec, index) + (360 * seconds) / AVATAR_COMET_HUE_SECONDS;
  const wrapped = ((Math.round(hue) % 360) + 360) % 360;
  return `hsl(${wrapped} 56% ${avatarCometStopLightness(index)}%)`;
}

/** Comet rotation (degrees, clockwise) at `seconds` into the working state. */
export function avatarCometAngle(spec: AvatarCometSpec, seconds: number): number {
  return spec.startDeg + (360 * seconds) / spec.orbitSeconds;
}

/** Half-plane of the orbit frame on one side of the head: back (below) or front (above). */
export function avatarCometClipRect(
  spec: AvatarCometSpec,
  side: "back" | "front",
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  // The stroke keeps its on-screen width through the squash, so reach
  // further vertically in the squashed frame.
  const across = spec.radius + spec.width + 2;
  const reach = spec.radius + spec.width / spec.squash + 2;
  return { x: -across, y: side === "front" ? -reach : 0, width: 2 * across, height: reach };
}
