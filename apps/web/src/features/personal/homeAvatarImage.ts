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
} from "./botAvatarShapes";

const cache = new Map<string, string>();

/** Same static SVG artwork, decoded as one image instead of four DOM nodes. */
export function homeAvatarImage(shape: BotAvatarShape, color: string): string {
  const key = `${shape}|${color}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const built = buildHomeAvatarImage(shape, color);
  cache.set(key, built);
  return built;
}

function buildHomeAvatarImage(shape: BotAvatarShape, color: string): string {
  const silhouette = BOT_AVATAR_SILHOUETTES[shape];
  const escapedColor = color
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  const fill = `<path d="${silhouette.d}" fill="${escapedColor}" stroke="${silhouette.roundCorners ? escapedColor : "none"}" stroke-width="${silhouette.roundCorners ? BOT_AVATAR_ROUND_CORNER_STROKE : 0}" stroke-linejoin="round"></path>`;
  const eyes = BOT_AVATAR_EYES[shape]
    .map(
      (eye) =>
        `<rect x="${eye.cx - BOT_AVATAR_EYE_WIDTH / 2}" y="${eye.cy - BOT_AVATAR_EYE_HEIGHT / 2}" width="${BOT_AVATAR_EYE_WIDTH}" height="${BOT_AVATAR_EYE_HEIGHT}" rx="${BOT_AVATAR_EYE_WIDTH / 2}" fill="${BOT_AVATAR_EYE_COLOR}" transform="rotate(${BOT_AVATAR_EYE_TILT_DEG} ${eye.cx} ${eye.cy})"></rect>`,
    )
    .join("");
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="${BOT_AVATAR_VIEWBOX}">${fill}${eyes}</svg>`)}`;
}
