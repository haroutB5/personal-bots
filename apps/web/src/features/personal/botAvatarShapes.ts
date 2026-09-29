import type { BotAvatarShape } from "@t3tools/contracts";

/**
 * Geometry for the geometric bot avatars (see `.plans/ui-spec.md`).
 *
 * All silhouettes live in a `0 0 100 100` viewBox. The `Record<BotAvatarShape, …>`
 * typings are the exhaustiveness guarantee: adding a literal to the contract
 * breaks the web typecheck until its artwork lands here.
 */

export const BOT_AVATAR_VIEWBOX = "0 0 100 100";

/** Eye pill size in viewBox units, shared by every shape (~22% of height). */
export const BOT_AVATAR_EYE_WIDTH = 9;
export const BOT_AVATAR_EYE_HEIGHT = 22;
/** Clockwise tilt of the eyes (top leans right), in degrees. */
export const BOT_AVATAR_EYE_TILT_DEG = 15;
export const BOT_AVATAR_EYE_COLOR = "#111111";
/**
 * Stroke weight that rounds the sharp vertices of the `roundCorners` shapes,
 * in viewBox units. Shared so the notification icon rounds them identically.
 */
export const BOT_AVATAR_ROUND_CORNER_STROKE = 7;
/** Side of the square viewBox, in its own units. */
export const BOT_AVATAR_VIEWBOX_SIZE = 100;

export interface BotAvatarSilhouette {
  /** Single flat-fill silhouette path (`d` attribute). */
  d: string;
  /**
   * When true the path is also stroked with its own fill colour (round joins)
   * so sharp vertices (triangle, hexagon) render with soft rounded corners.
   */
  roundCorners: boolean;
}

export interface BotAvatarEyeCenter {
  cx: number;
  cy: number;
}

/** Display order for the shape picker (contract order). */
export const BOT_AVATAR_SHAPE_ORDER: readonly BotAvatarShape[] = [
  "blob",
  "roundedSquare",
  "pill",
  "triangle",
  "roundedHexagon",
  "scallopedCloud",
  "droplet",
];

export const BOT_AVATAR_SILHOUETTES: Record<BotAvatarShape, BotAvatarSilhouette> = {
  // Slightly irregular round blob (control points deliberately off-circle).
  blob: {
    d: "M50 9C66 7 88 24 90 48C92 72 70 91 49 92C28 93 9 74 10 50C11 27 33 11 50 9Z",
    roundCorners: false,
  },
  // Rounded square, corner radius ~28% of size.
  roundedSquare: {
    d: "M38 10H62Q90 10 90 38V62Q90 90 62 90H38Q10 90 10 62V38Q10 10 38 10Z",
    roundCorners: false,
  },
  // Horizontal capsule.
  pill: {
    d: "M30 26H70Q94 26 94 50Q94 74 70 74H30Q6 74 6 50Q6 26 30 26Z",
    roundCorners: false,
  },
  // Rounded-corner triangle, point at top.
  triangle: {
    d: "M50 14Q52 14 53.2 16.2L84.6 79.4Q89.6 88 80.4 88H19.6Q10.4 88 15.4 79.4L46.8 16.2Q48 14 50 14Z",
    roundCorners: true,
  },
  // Pointy-top hexagon; corners are rounded via stroke (see `roundCorners`).
  roundedHexagon: {
    d: "M50 8L84.6 28V72L50 92L15.4 72V28Z",
    roundCorners: true,
  },
  // Six-lobe scalloped cloud centred on (50, 53). Shallow valleys
  // (r ~33) keep the visual mass close to the other shapes; quadratic
  // controls pushed past each lobe tip keep the lobes round and soft.
  scallopedCloud: {
    d: "M33.5 24.4Q50 1.8 66.5 24.4Q94.4 27.4 83 53Q94.4 78.6 66.5 81.6Q50 104.3 33.5 81.6Q5.6 78.6 17 53Q5.6 27.4 33.5 24.4Z",
    roundCorners: false,
  },
  // Droplet: pointed top, round bottom (circle centre (50, 62), r 28).
  droplet: {
    d: "M50 6C58 22 78 42 78 62A28 28 0 1 1 22 62C22 42 42 22 50 6Z",
    roundCorners: false,
  },
};

/**
 * Eye centres per shape. The pair sits slightly left of centre and just below
 * the vertical middle; triangle/droplet shift down so the eyes stay inside the
 * narrower silhouette.
 */
export const BOT_AVATAR_EYES: Record<
  BotAvatarShape,
  readonly [BotAvatarEyeCenter, BotAvatarEyeCenter]
> = {
  blob: [
    { cx: 38, cy: 57 },
    { cx: 54, cy: 57 },
  ],
  roundedSquare: [
    { cx: 38, cy: 57 },
    { cx: 54, cy: 57 },
  ],
  pill: [
    { cx: 38, cy: 57 },
    { cx: 54, cy: 57 },
  ],
  triangle: [
    { cx: 38, cy: 64 },
    { cx: 54, cy: 64 },
  ],
  roundedHexagon: [
    { cx: 38, cy: 57 },
    { cx: 54, cy: 57 },
  ],
  scallopedCloud: [
    { cx: 38, cy: 57 },
    { cx: 54, cy: 57 },
  ],
  droplet: [
    { cx: 38, cy: 60 },
    { cx: 54, cy: 60 },
  ],
};

export const BOT_AVATAR_SHAPE_LABELS: Record<BotAvatarShape, string> = {
  blob: "Blob",
  roundedSquare: "Square",
  pill: "Pill",
  triangle: "Triangle",
  roundedHexagon: "Hexagon",
  scallopedCloud: "Cloud",
  droplet: "Droplet",
};

/**
 * Twelve colour swatches for the picker. Includes the four seed-bot colours
 * (Assistant blue, Developer orange, Researcher pink, Planner red).
 */
export const BOT_AVATAR_SWATCHES: readonly string[] = [
  "#1A73E8",
  "#F26A1B",
  "#F0457E",
  "#E5323B",
  "#34A853",
  "#0D9488",
  "#7C3AED",
  "#EAB308",
  "#8A5A3B",
  "#64748B",
  "#171717",
  "#65A30D",
];

/**
 * The darkest surface an avatar is painted on in the dark appearance:
 * `--personal-surface` (#1a1a19), the card behind the pinned box, the avatar
 * picker and every sheet. Duplicated from `personal.css` because the decision
 * below is made in JS; `botAvatarShapes.test.ts` pins the pair so the two
 * cannot drift apart silently.
 */
const DARK_CARD_SURFACE = "#1a1a19";

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance of a `#rgb`/`#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const value = hex.trim().replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const [r, g, b] = [0, 2, 4].map((i) =>
    srgbToLinear(Number.parseInt(full.slice(i, i + 2), 16) / 255),
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Whether a bot's stored colour needs the contrast halo (`--personal-avatar-halo`)
 * to be a visible shape on the dark surface.
 *
 * Bot colours are user data and are never rewritten for the theme, so the fix
 * for a near-black bot on a near-black card is an outline. But the outline is
 * only drawn for the colours that need it: it has to be strong enough (3.5:1)
 * to read against #171717's silhouette, and at that strength every saturated
 * avatar in the chats list would look deliberately bordered.
 *
 * The bar is WCAG 2.x 1.4.11 — 3:1 for a meaningful non-text graphic — measured
 * against the *lightest* surface the avatar sits on, which is the worst case.
 * Of the twelve swatches only `#171717` (1.03:1) and `#8A5A3B` (2.99:1) fail;
 * the slate `#64748B` clears it at 3.66:1. Returns false in the light
 * appearance's terms too — the caller does not branch on appearance, because
 * `--personal-avatar-halo` is `transparent` in light, so the extra path paints
 * nothing there.
 */
/**
 * The whole avatar geometry as plain JSON-safe data.
 *
 * The service worker draws the sending bot's avatar into the push notification
 * icon, and a service worker cannot import from `src/`: it is a standalone
 * script served from `public/`. Rather than copy the silhouettes into it - a
 * second set of paths that would drift the first time a shape is retouched -
 * this object is serialised to `public/bot-avatar-shapes.json`, which the
 * worker fetches. `botAvatarGeometryAsset.test.ts` fails if the checked-in
 * file and this module disagree, so the drift cannot survive a test run;
 * regenerate with `node apps/web/scripts/generate-bot-avatar-shapes.ts`.
 */
export interface BotAvatarGeometry {
  readonly viewBoxSize: number;
  readonly roundCornerStroke: number;
  readonly eye: {
    readonly width: number;
    readonly height: number;
    readonly tiltDeg: number;
    readonly color: string;
  };
  readonly silhouettes: Record<BotAvatarShape, BotAvatarSilhouette>;
  readonly eyes: Record<BotAvatarShape, readonly [BotAvatarEyeCenter, BotAvatarEyeCenter]>;
}

export const BOT_AVATAR_GEOMETRY: BotAvatarGeometry = {
  viewBoxSize: BOT_AVATAR_VIEWBOX_SIZE,
  roundCornerStroke: BOT_AVATAR_ROUND_CORNER_STROKE,
  eye: {
    width: BOT_AVATAR_EYE_WIDTH,
    height: BOT_AVATAR_EYE_HEIGHT,
    tiltDeg: BOT_AVATAR_EYE_TILT_DEG,
    color: BOT_AVATAR_EYE_COLOR,
  },
  silhouettes: BOT_AVATAR_SILHOUETTES,
  eyes: BOT_AVATAR_EYES,
};

/** Exactly the bytes `public/bot-avatar-shapes.json` must contain. */
export function botAvatarGeometryJson(): string {
  return `${JSON.stringify(BOT_AVATAR_GEOMETRY, null, 2)}\n`;
}

/**
 * The happy squint: an upward-bowed stroke ("^") drawn in a pill eye's place
 * (`done`'s landing). Stroke it 5 units wide with round caps.
 */
export function botAvatarHappyArcPath(cx: number, cy: number): string {
  return `M${cx - 4} ${cy + 3}Q${cx} ${cy - 9} ${cx + 4} ${cy + 3}`;
}

export function botAvatarNeedsHalo(color: string): boolean {
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim())) return true;
  return contrastRatio(color, DARK_CARD_SURFACE) < 3;
}

/**
 * Where the thinking pose's thought cloud sits (Designer spec B · Cloud,
 * `dev-team/design/hbots/thinking-bubbles/SPEC-b-cloud.md`). Only the three
 * animated places get one; task cards and Team nodes stay static.
 */
export type BotAvatarThoughtPlace = "row" | "pinned" | "header";

/**
 * The cloud's fixed box per place, the same for every shape: `top` is px
 * above (negative) the avatar box, `right` how far past its right edge the
 * cloud reaches, `dot` the inner dots' diameter (0: the mini cloud, no dots),
 * `tail` the two tail dots' diameters, small one first.
 */
export const BOT_AVATAR_THOUGHT_CLOUDS: Record<
  BotAvatarThoughtPlace,
  {
    readonly w: number;
    readonly h: number;
    readonly dot: number;
    readonly tail: readonly [number, number];
    readonly top: number;
    readonly right: number;
  }
> = {
  row: { w: 26, h: 17, dot: 3, tail: [3.5, 5], top: -14.5, right: 12 },
  pinned: { w: 22, h: 14.5, dot: 2.5, tail: [3, 4.5], top: -13.5, right: 12 },
  header: { w: 17, h: 11, dot: 0, tail: [2.5, 3.5], top: -6.2, right: 10 },
};

/** The small tail dot's centre per shape, in viewBox units: just off the right shoulder, 2-4 units clear of the silhouette. */
export const BOT_AVATAR_THOUGHT_ANCHORS: Record<BotAvatarShape, readonly [number, number]> = {
  blob: [91, 29],
  roundedSquare: [96, 31],
  pill: [93, 24],
  triangle: [70, 30],
  roundedHexagon: [93, 26],
  scallopedCloud: [90, 28],
  droplet: [72, 30],
};

/** A 5-bump thought cloud in a `0 0 100 66` box, a flat fill. */
export const BOT_AVATAR_THOUGHT_CLOUD_PATH =
  "M22 60C9 60 2 52 4 43C5 36 11 32 17 32C15 21 24 12 35 15C40 5 55 3 62 11C70 5 84 9 85 20C95 21 99 31 96 39C100 48 93 58 82 58C78 64 68 66 61 61C55 66 44 66 38 61C33 63 27 63 22 60Z";

/** A box in px from the avatar box's top-left. */
export interface BotAvatarThoughtBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface BotAvatarThoughtGeometry {
  readonly t1: BotAvatarThoughtBox;
  readonly t2: BotAvatarThoughtBox;
  readonly cloud: BotAvatarThoughtBox;
  /** The inner dots, relative to the cloud box; empty for the mini cloud. */
  readonly dots: ReadonlyArray<BotAvatarThoughtBox>;
  readonly mini: boolean;
  /** t1's centre as a percentage of the avatar box: the leave's transform origin. */
  readonly origin: string;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const circle = (x: number, y: number, d: number): BotAvatarThoughtBox => ({
  left: round2(x - d / 2),
  top: round2(y - d / 2),
  width: d,
  height: d,
});

/**
 * The thought layer's layout for one avatar, in px. Pure and computed during
 * render; nothing here is animated. A port of the prototype's `cloudGeometry`:
 * the cloud is pinned to the box's top-right corner, the tail runs from the
 * shape's shoulder (t1) halfway (t2) to the bottom of the cloud's lower-left bump.
 */
export function avatarThoughtCloud(
  shape: BotAvatarShape,
  size: number,
  place: BotAvatarThoughtPlace,
): BotAvatarThoughtGeometry {
  const spec = BOT_AVATAR_THOUGHT_CLOUDS[place];
  const unit = size / BOT_AVATAR_VIEWBOX_SIZE;
  const cloudLeft = size + spec.right - spec.w;
  const tip = { x: cloudLeft + 0.3 * spec.w, y: spec.top + 0.92 * spec.h };
  const [ax, ay] = BOT_AVATAR_THOUGHT_ANCHORS[shape];
  const t1 = { x: ax * unit, y: ay * unit };
  const t2 = { x: (t1.x + tip.x) / 2, y: (t1.y + tip.y) / 2 };
  const mini = spec.dot === 0;
  return {
    t1: circle(t1.x, t1.y, spec.tail[0]),
    t2: circle(t2.x, t2.y, spec.tail[1]),
    cloud: { left: cloudLeft, top: spec.top, width: spec.w, height: spec.h },
    dots: mini ? [] : [0.3, 0.5, 0.7].map((f) => circle(spec.w * f, spec.h * 0.52, spec.dot)),
    mini,
    origin: `${((t1.x / size) * 100).toFixed(1)}% ${((t1.y / size) * 100).toFixed(1)}%`,
  };
}
