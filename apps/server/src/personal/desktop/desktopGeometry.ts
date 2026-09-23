/**
 * Screenshot space <-> physical desktop pixels.
 *
 * The helper is per-monitor DPI aware, so everything it reports and takes is
 * a physical pixel on the virtual screen (origin can be negative). A bot only
 * ever sees downscaled screenshots, and gives coordinates in the pixel space
 * of the screenshot it last took; this module owns that mapping so it is
 * tested once instead of trusted at every call site.
 */

/** Anthropic's vision guidance: longer images are resized server-side, which would shift clicks. */
export const MAX_SCREENSHOT_LONG_EDGE = 1568;
/** ~1.15 MP: past this the API also resizes. */
export const MAX_SCREENSHOT_PIXELS = 1_150_000;

export interface DesktopRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopMonitor extends DesktopRect {
  readonly index: number;
  readonly primary: boolean;
  readonly dpi: number;
  readonly name: string;
}

/** What one screenshot showed, so later coordinates can be mapped back. */
export interface ScreenFrame {
  /** Physical rect captured. */
  readonly region: DesktopRect;
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** `"all"` for the whole virtual screen, else the monitor index. */
  readonly monitor: number | "all";
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Largest size within both limits, keeping the aspect ratio; never upscales. */
export function fitImageSize(
  width: number,
  height: number,
  maxLongEdge = MAX_SCREENSHOT_LONG_EDGE,
  maxPixels = MAX_SCREENSHOT_PIXELS,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(
    1,
    maxLongEdge / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    // The epsilon keeps 5760 * (1568 / 5760) from flooring to 1567.
    width: Math.max(1, Math.floor(width * scale + 1e-9)),
    height: Math.max(1, Math.floor(height * scale + 1e-9)),
  };
}

export function makeFrame(region: DesktopRect, monitor: number | "all"): ScreenFrame {
  const size = fitImageSize(region.width, region.height);
  return { region, imageWidth: size.width, imageHeight: size.height, monitor };
}

/** Smallest rect holding every monitor: the virtual screen. */
export function unionRect(rects: ReadonlyArray<DesktopRect>): DesktopRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export class DesktopCoordinateError extends Error {}

/**
 * A screenshot pixel to the physical pixel under its centre. Refuses points
 * outside the screenshot rather than clamping them: a bot aiming off-screen
 * has misread the image, and clicking the nearest edge would hide that.
 */
export function toPhysical(frame: ScreenFrame, point: Point): Point {
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new DesktopCoordinateError("Coordinates must be numbers.");
  }
  if (x < 0 || y < 0 || x >= frame.imageWidth || y >= frame.imageHeight) {
    throw new DesktopCoordinateError(
      `(${x}, ${y}) is outside the last screenshot, which is ${frame.imageWidth}x${frame.imageHeight}. Use coordinates from that image.`,
    );
  }
  const scaleX = frame.region.width / frame.imageWidth;
  const scaleY = frame.region.height / frame.imageHeight;
  return {
    x: Math.min(
      frame.region.x + frame.region.width - 1,
      frame.region.x + Math.floor((x + 0.5) * scaleX),
    ),
    y: Math.min(
      frame.region.y + frame.region.height - 1,
      frame.region.y + Math.floor((y + 0.5) * scaleY),
    ),
  };
}

/** A physical pixel in screenshot space, or null when that screenshot did not show it. */
export function toImage(frame: ScreenFrame, point: Point): Point | null {
  const relX = point.x - frame.region.x;
  const relY = point.y - frame.region.y;
  if (relX < 0 || relY < 0 || relX >= frame.region.width || relY >= frame.region.height) {
    return null;
  }
  return {
    x: Math.floor((relX * frame.imageWidth) / frame.region.width),
    y: Math.floor((relY * frame.imageHeight) / frame.region.height),
  };
}

/** A rect given in screenshot space, as the physical rect it covers. */
export function toPhysicalRect(frame: ScreenFrame, rect: DesktopRect): DesktopRect {
  if (rect.width <= 0 || rect.height <= 0) {
    throw new DesktopCoordinateError("The region needs a positive width and height.");
  }
  const topLeft = toPhysical(frame, { x: rect.x, y: rect.y });
  const right = Math.min(rect.x + rect.width, frame.imageWidth);
  const bottom = Math.min(rect.y + rect.height, frame.imageHeight);
  const scaleX = frame.region.width / frame.imageWidth;
  const scaleY = frame.region.height / frame.imageHeight;
  const physicalRight = frame.region.x + Math.round(right * scaleX);
  const physicalBottom = frame.region.y + Math.round(bottom * scaleY);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(1, physicalRight - topLeft.x),
    height: Math.max(1, physicalBottom - topLeft.y),
  };
}

/** The rect a screenshot of `monitor` covers: a monitor index, or "all" for the virtual screen. */
export function captureRegion(
  monitors: ReadonlyArray<DesktopMonitor>,
  monitor: number | "all" | undefined,
): { readonly region: DesktopRect; readonly monitor: number | "all" } {
  if (monitors.length === 0) {
    throw new DesktopCoordinateError("No monitors were found.");
  }
  if (monitor === "all") return { region: unionRect(monitors), monitor: "all" };
  const index = monitor ?? monitors.find((entry) => entry.primary)?.index ?? 0;
  const found = monitors.find((entry) => entry.index === index);
  if (found === undefined) {
    throw new DesktopCoordinateError(
      `There is no monitor ${index}; monitors are ${monitors.map((entry) => entry.index).join(", ")}.`,
    );
  }
  return {
    region: { x: found.x, y: found.y, width: found.width, height: found.height },
    monitor: found.index,
  };
}
