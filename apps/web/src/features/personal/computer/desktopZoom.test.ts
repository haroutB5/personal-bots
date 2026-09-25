import { describe, expect, it } from "vite-plus/test";

import { IDENTITY_VIEW } from "./desktopRemoteInput";
import {
  DOUBLE_TAP_SCALE,
  regionPlacement,
  screenPixel,
  toggleZoom,
  visibleRegion,
  WHOLE_REGION,
} from "./desktopZoom";

/** A phone in portrait: the picture letterboxed 390 x 243.75 into a 390 x 700 box. */
const BOX = { left: 0, top: 50, width: 390, height: 700 };
const SCREEN = { width: 3072, height: 1920 };

describe("visibleRegion", () => {
  it("is the whole monitor while the picture is all on screen", () => {
    const picture = { left: 0, top: 278, width: 390, height: 243.75 };
    expect(visibleRegion(picture, BOX)).toEqual({
      region: WHOLE_REGION,
      width: 390,
      height: 243.75,
    });
  });

  it("zoomed 3x into the middle is the middle third, at the visible size", () => {
    // Scaled 3x about the picture's centre, then clipped by a box as tall as the picture.
    const box = { left: 0, top: 0, width: 390, height: 243.75 };
    const picture = { left: -390, top: -243.75, width: 1170, height: 731.25 };
    const visible = visibleRegion(picture, box)!;
    expect(visible.region.x).toBeCloseTo(1 / 3, 4);
    expect(visible.region.y).toBeCloseTo(1 / 3, 4);
    expect(visible.region.width).toBeCloseTo(1 / 3, 4);
    expect(visible.region.height).toBeCloseTo(1 / 3, 4);
    expect(visible.width).toBe(390);
    expect(visible.height).toBe(243.75);
    // Rounded outwards: never a sliver short of what is on screen.
    expect(visible.region.x).toBeLessThanOrEqual(1 / 3);
    expect(visible.region.x + visible.region.width).toBeGreaterThanOrEqual(2 / 3);
  });

  it("zoomed in a letterboxed box, the picture also fills the bars it grows into", () => {
    const picture = { left: -195, top: 156.125, width: 780, height: 487.5 };
    const visible = visibleRegion(picture, BOX)!;
    expect(visible.region.x).toBeCloseTo(0.25, 4);
    expect(visible.region.width).toBeCloseTo(0.5, 4);
    expect(visible.region).toMatchObject({ y: 0, height: 1 });
    expect(visible.height).toBe(487.5);
  });

  it("is null when nothing of the picture is visible or it has no size", () => {
    expect(visibleRegion({ left: 500, top: 0, width: 100, height: 100 }, BOX)).toBeNull();
    expect(visibleRegion({ left: 0, top: 0, width: 0, height: 0 }, BOX)).toBeNull();
  });
});

describe("regionPlacement", () => {
  it("places a region frame as percentages of the picture", () => {
    const placed = regionPlacement({ x: 1024, y: 640, width: 1024, height: 640 }, SCREEN);
    expect(parseFloat(placed.left)).toBeCloseTo(100 / 3);
    expect(parseFloat(placed.top)).toBeCloseTo(100 / 3);
    expect(parseFloat(placed.width)).toBeCloseTo(100 / 3);
    expect(parseFloat(placed.height)).toBeCloseTo(100 / 3);
  });
});

describe("screenPixel", () => {
  it("maps a point on the zoomed picture to the monitor pixel under it", () => {
    const picture = { left: -390, top: -243.75, width: 1170, height: 731.25 };
    // The centre of the phone's picture box is the centre of the monitor.
    expect(screenPixel(195, 121.875, picture, SCREEN)).toEqual({ x: 1536, y: 960 });
    // The top-left of the box is a third of the way in.
    expect(screenPixel(0, 0, picture, SCREEN)).toEqual({ x: 1024, y: 640 });
  });

  it("refuses points off the picture unless clamped onto its edge", () => {
    const picture = { left: 0, top: 0, width: 390, height: 243.75 };
    expect(screenPixel(-1, 10, picture, SCREEN)).toBeNull();
    expect(screenPixel(390, 10, picture, SCREEN)).toBeNull();
    expect(screenPixel(400, 300, picture, SCREEN, true)).toEqual({ x: 3071, y: 1919 });
    expect(screenPixel(-5, -5, picture, SCREEN, true)).toEqual({ x: 0, y: 0 });
  });
});

describe("toggleZoom", () => {
  it("zooms in toward the point, and back out from any zoom", () => {
    const size = { width: 390, height: 243.75 };
    const zoomed = toggleZoom(IDENTITY_VIEW, 195, 121.875, size);
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE);
    // The tapped point stays under the finger.
    expect(zoomed.x + 195 * zoomed.scale).toBeCloseTo(195);
    expect(zoomed.y + 121.875 * zoomed.scale).toBeCloseTo(121.875);
    expect(toggleZoom(zoomed, 10, 10, size)).toEqual(IDENTITY_VIEW);
  });
});
