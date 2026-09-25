/**
 * The pure half of zooming the live view: which part of the PC's monitor is
 * on the phone's screen (so the server can send just that, sharp), where a
 * frame of part of the monitor sits in the picture, and which monitor pixel
 * is under a finger. The component only wires these to the DOM.
 */
import type { PersonalDesktopViewRegion } from "@t3tools/contracts";

import { type BoxSize, IDENTITY_VIEW, type ViewTransform, zoomView } from "./desktopRemoteInput";

export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A rect in monitor pixels. */
export interface ScreenRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const WHOLE_REGION: PersonalDesktopViewRegion = { x: 0, y: 0, width: 1, height: 1 };

/** How far a double tap zooms in (view only). */
export const DOUBLE_TAP_SCALE = 2.5;

/** Fractions are sent to 5 places: well under a pixel on any monitor. */
const PLACES = 1e5;

/**
 * The part of the picture the viewer can see, as fractions of the monitor,
 * and how big it is on screen (CSS px). `picture` is the picture's on-screen
 * rect with the zoom applied; `container` clips it. Null when none of it is
 * visible. Rounded outwards, and exactly the whole monitor when all of it is
 * on screen, so an unzoomed view always asks for plain whole frames.
 */
export function visibleRegion(
  picture: ClientRect,
  container: ClientRect,
): {
  readonly region: PersonalDesktopViewRegion;
  readonly width: number;
  readonly height: number;
} | null {
  if (!(picture.width > 0 && picture.height > 0)) return null;
  const left = Math.max(picture.left, container.left);
  const top = Math.max(picture.top, container.top);
  const right = Math.min(picture.left + picture.width, container.left + container.width);
  const bottom = Math.min(picture.top + picture.height, container.top + container.height);
  if (!(right > left && bottom > top)) return null;
  const from = (value: number) => Math.max(0, Math.floor(value * PLACES) / PLACES);
  const to = (value: number) => Math.min(1, Math.ceil(value * PLACES) / PLACES);
  const x = from((left - picture.left) / picture.width);
  const y = from((top - picture.top) / picture.height);
  const x2 = to((right - picture.left) / picture.width);
  const y2 = to((bottom - picture.top) / picture.height);
  // Within half a CSS pixel of the whole picture is the whole picture.
  const slackX = 0.5 / picture.width;
  const slackY = 0.5 / picture.height;
  const whole = x <= slackX && y <= slackY && x2 >= 1 - slackX && y2 >= 1 - slackY;
  return {
    region: whole ? WHOLE_REGION : { x, y, width: x2 - x, height: y2 - y },
    width: right - left,
    height: bottom - top,
  };
}

/** Where a frame of `region` goes inside the picture, as CSS percentages. */
export function regionPlacement(
  region: ScreenRegion,
  screen: BoxSize,
): {
  readonly left: string;
  readonly top: string;
  readonly width: string;
  readonly height: string;
} {
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  return {
    left: percent(region.x, screen.width),
    top: percent(region.y, screen.height),
    width: percent(region.width, screen.width),
    height: percent(region.height, screen.height),
  };
}

/**
 * The monitor pixel under a client point on the (possibly zoomed) picture:
 * the same pixel whichever frame, whole or zoomed, is drawn there. Null off
 * the picture unless `clamp` pulls it to the nearest edge.
 */
export function screenPixel(
  clientX: number,
  clientY: number,
  picture: ClientRect,
  screen: BoxSize,
  clamp = false,
): { readonly x: number; readonly y: number } | null {
  if (!(picture.width > 0 && picture.height > 0 && screen.width > 0 && screen.height > 0)) {
    return null;
  }
  const u = (clientX - picture.left) / picture.width;
  const v = (clientY - picture.top) / picture.height;
  const inside = u >= 0 && v >= 0 && u < 1 && v < 1;
  if (!inside && !clamp) return null;
  const pixel = (fraction: number, total: number) =>
    Math.min(total - 1, Math.max(0, Math.floor(fraction * total)));
  return { x: pixel(u, screen.width), y: pixel(v, screen.height) };
}

/** A double tap: zoom in toward the point (unzoomed CSS px of the picture), or back out. */
export function toggleZoom(
  view: ViewTransform,
  cx: number,
  cy: number,
  size: BoxSize,
): ViewTransform {
  if (view.scale > 1) return IDENTITY_VIEW;
  return zoomView(view, DOUBLE_TAP_SCALE, cx, cy, size);
}
