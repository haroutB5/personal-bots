import { describe, expect, it } from "@effect/vitest";

import {
  captureRegion,
  DesktopCoordinateError,
  type DesktopMonitor,
  fitImageSize,
  makeFrame,
  MAX_SCREENSHOT_LONG_EDGE,
  MAX_SCREENSHOT_PIXELS,
  toImage,
  toPhysical,
  toPhysicalRect,
} from "./desktopGeometry.ts";

const monitor = (overrides: Partial<DesktopMonitor> & Pick<DesktopMonitor, "index">) => ({
  primary: false,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  dpi: 96,
  name: `\\\\.\\DISPLAY${overrides.index + 1}`,
  ...overrides,
});

describe("fitImageSize", () => {
  it("keeps a small screen at its own size", () => {
    expect(fitImageSize(1024, 768)).toEqual({ width: 1024, height: 768 });
  });

  it("fits a 200% laptop panel (3072x1920) under both API limits", () => {
    const size = fitImageSize(3072, 1920);
    expect(size.width).toBeLessThanOrEqual(MAX_SCREENSHOT_LONG_EDGE);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_SCREENSHOT_PIXELS);
    expect(size).toEqual({ width: 1356, height: 847 });
  });

  it("caps the long edge of a very wide virtual screen", () => {
    const size = fitImageSize(5760, 1080);
    expect(size.width).toBe(MAX_SCREENSHOT_LONG_EDGE);
    expect(size.height).toBe(294);
  });
});

describe("toPhysical", () => {
  it("maps screenshot pixels to physical pixels on a 192-DPI screen", () => {
    const frame = makeFrame({ x: 0, y: 0, width: 3072, height: 1920 }, 0);
    // The image is 1356 wide, so one image pixel is ~2.27 physical pixels.
    expect(toPhysical(frame, { x: 0, y: 0 })).toEqual({ x: 1, y: 1 });
    expect(toPhysical(frame, { x: 678, y: 423 })).toEqual({ x: 1537, y: 960 });
    // The last image pixel lands on the centre of the physical block it covers.
    expect(toPhysical(frame, { x: 1355, y: 846 })).toEqual({ x: 3070, y: 1918 });
  });

  it("offsets into a monitor left of and above the primary (negative origin)", () => {
    const frame = makeFrame({ x: -1920, y: -200, width: 1920, height: 1080 }, 1);
    expect(frame.imageWidth).toBe(1429);
    const point = toPhysical(frame, { x: 0, y: 0 });
    expect(point.x).toBe(-1920);
    expect(point.y).toBe(-200);
    const far = toPhysical(frame, { x: frame.imageWidth - 1, y: frame.imageHeight - 1 });
    expect(far).toEqual({ x: -1, y: 879 });
  });

  it("refuses points outside the screenshot instead of clamping them", () => {
    const frame = makeFrame({ x: 0, y: 0, width: 1920, height: 1080 }, 0);
    expect(() => toPhysical(frame, { x: frame.imageWidth, y: 10 })).toThrow(DesktopCoordinateError);
    expect(() => toPhysical(frame, { x: -1, y: 10 })).toThrow(DesktopCoordinateError);
    expect(() => toPhysical(frame, { x: Number.NaN, y: 10 })).toThrow(DesktopCoordinateError);
  });

  it("round-trips through toImage within one image pixel", () => {
    const frame = makeFrame({ x: -1920, y: 0, width: 3840, height: 2160 }, 1);
    for (const point of [
      { x: 0, y: 0 },
      { x: 700, y: 400 },
      { x: frame.imageWidth - 1, y: frame.imageHeight - 1 },
    ]) {
      const back = toImage(frame, toPhysical(frame, point));
      expect(back).not.toBeNull();
      expect(Math.abs(back!.x - point.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(back!.y - point.y)).toBeLessThanOrEqual(1);
    }
  });

  it("reports a pointer on another monitor as not in the screenshot", () => {
    const frame = makeFrame({ x: 0, y: 0, width: 1920, height: 1080 }, 0);
    expect(toImage(frame, { x: -5, y: 100 })).toBeNull();
  });
});

describe("toPhysicalRect", () => {
  it("scales a zoom region to physical pixels", () => {
    const frame = makeFrame({ x: 0, y: 0, width: 3072, height: 1920 }, 0);
    const rect = toPhysicalRect(frame, { x: 100, y: 100, width: 200, height: 100 });
    expect(rect.x).toBe(227);
    expect(rect.y).toBe(227);
    expect(rect.width).toBeGreaterThanOrEqual(450);
    expect(rect.width).toBeLessThanOrEqual(455);
  });
});

describe("captureRegion", () => {
  const monitors = [
    monitor({ index: 0, primary: true, width: 3072, height: 1920, dpi: 192 }),
    monitor({ index: 1, x: -1920, y: -200 }),
  ];

  it("defaults to the primary monitor", () => {
    expect(captureRegion(monitors, undefined)).toEqual({
      region: { x: 0, y: 0, width: 3072, height: 1920 },
      monitor: 0,
    });
  });

  it("spans every monitor for all, negative origin included", () => {
    expect(captureRegion(monitors, "all").region).toEqual({
      x: -1920,
      y: -200,
      width: 4992,
      height: 2120,
    });
  });

  it("names the monitors when asked for one that does not exist", () => {
    expect(() => captureRegion(monitors, 5)).toThrow(/monitors are 0, 1/);
  });
});
