import type { BotAvatarShape } from "@t3tools/contracts";

/**
 * Geometry for the geometric bot avatars (see `.plans/ui-spec.md`).
 *
 * All silhouettes live in a `0 0 100 100` viewBox. The `Record<BotAvatarShape, …>`
 * typings are the exhaustiveness guarantee: adding a literal to the contract
 * breaks the web typecheck until its artwork lands here.
 */

export const BOT_AVATAR_VIEWBOX = "0 0 100 100";

/** Eye pill size in viewBox units, shared by every shape. */
export const BOT_AVATAR_EYE_WIDTH = 7;
export const BOT_AVATAR_EYE_HEIGHT = 18;
/** Clockwise tilt of the eyes (top leans right), in degrees. */
export const BOT_AVATAR_EYE_TILT_DEG = 15;
export const BOT_AVATAR_EYE_COLOR = "#111111";

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
  // Six-lobe scalloped cloud centred on (50, 52).
  scallopedCloud: {
    d: "M50 24Q74 10.4 74.2 38Q98 52 74.2 66Q74 93.6 50 80Q26 93.6 25.8 66Q2 52 25.8 38Q26 10.4 50 24Z",
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
    { cx: 38, cy: 54 },
    { cx: 54, cy: 54 },
  ],
  roundedSquare: [
    { cx: 38, cy: 54 },
    { cx: 54, cy: 54 },
  ],
  pill: [
    { cx: 38, cy: 54 },
    { cx: 54, cy: 54 },
  ],
  triangle: [
    { cx: 38, cy: 62 },
    { cx: 54, cy: 62 },
  ],
  roundedHexagon: [
    { cx: 38, cy: 54 },
    { cx: 54, cy: 54 },
  ],
  scallopedCloud: [
    { cx: 38, cy: 54 },
    { cx: 54, cy: 54 },
  ],
  droplet: [
    { cx: 38, cy: 58 },
    { cx: 54, cy: 58 },
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
