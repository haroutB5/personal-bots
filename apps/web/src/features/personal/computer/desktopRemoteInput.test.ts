import { describe, expect, it } from "vite-plus/test";

import {
  clampView,
  comboString,
  framePoint,
  IDENTITY_VIEW,
  keyEventInput,
  MAX_VIEW_SCALE,
  mouseButton,
  mouseWheelUnits,
  panView,
  textInputs,
  touchScrollWheel,
  zoomView,
} from "./desktopRemoteInput";

const key = (
  value: string,
  modifiers: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
) => ({
  key: value,
  ctrlKey: modifiers.ctrl === true,
  altKey: modifiers.alt === true,
  shiftKey: modifiers.shift === true,
  metaKey: modifiers.meta === true,
});

describe("keyEventInput", () => {
  it("types printable characters as text, whatever the layout", () => {
    expect(keyEventInput(key("a"))).toEqual({ _tag: "Text", text: "a" });
    expect(keyEventInput(key("A", { shift: true }))).toEqual({ _tag: "Text", text: "A" });
    expect(keyEventInput(key("é"))).toEqual({ _tag: "Text", text: "é" });
    expect(keyEventInput(key(" "))).toEqual({ _tag: "Text", text: " " });
    // AltGr (Ctrl+Alt with a character) is text too.
    expect(keyEventInput(key("@", { ctrl: true, alt: true }))).toEqual({ _tag: "Text", text: "@" });
  });

  it("sends named keys and shortcuts as combinations the server allows", () => {
    expect(keyEventInput(key("Enter"))).toEqual({ _tag: "Keys", keys: "enter" });
    expect(keyEventInput(key("Escape"))).toEqual({ _tag: "Keys", keys: "esc" });
    expect(keyEventInput(key("ArrowLeft", { shift: true }))).toEqual({
      _tag: "Keys",
      keys: "shift+left",
    });
    expect(keyEventInput(key("c", { ctrl: true }))).toEqual({ _tag: "Keys", keys: "ctrl+c" });
    expect(keyEventInput(key("T", { ctrl: true, shift: true }))).toEqual({
      _tag: "Keys",
      keys: "ctrl+shift+t",
    });
    expect(keyEventInput(key("Tab", { alt: true }))).toEqual({ _tag: "Keys", keys: "alt+tab" });
    expect(keyEventInput(key("F4", { alt: true }))).toEqual({ _tag: "Keys", keys: "alt+f4" });
    expect(keyEventInput(key("+", { ctrl: true }))).toEqual({ _tag: "Keys", keys: "ctrl+plus" });
    expect(keyEventInput(key(" ", { ctrl: true }))).toEqual({ _tag: "Keys", keys: "ctrl+space" });
    expect(keyEventInput(key("r", { meta: true }))).toEqual({ _tag: "Keys", keys: "win+r" });
  });

  it("ignores bare modifiers and dead keys", () => {
    for (const value of ["Control", "Shift", "Alt", "Meta", "Dead", "CapsLock", "Unidentified"]) {
      expect(keyEventInput(key(value))).toBeNull();
    }
    expect(keyEventInput(key("MediaPlayPause"))).toBeNull();
  });

  it("applies the sticky modifiers from the special-keys row", () => {
    expect(keyEventInput(key("c"), new Set(["ctrl"]))).toEqual({ _tag: "Keys", keys: "ctrl+c" });
    expect(keyEventInput(key("Tab"), new Set(["alt"]))).toEqual({ _tag: "Keys", keys: "alt+tab" });
    expect(keyEventInput(key("Delete"), new Set(["ctrl", "alt"]))).toEqual({
      _tag: "Keys",
      keys: "ctrl+alt+delete",
    });
  });
});

describe("textInputs", () => {
  it("types plain text, in chunks the server accepts", () => {
    expect(textInputs("hello")).toEqual([{ _tag: "Text", text: "hello" }]);
    const long = textInputs("x".repeat(1_100));
    expect(long.map((input) => (input._tag === "Text" ? input.text.length : 0))).toEqual([
      500, 500, 100,
    ]);
    expect(textInputs("")).toEqual([]);
  });

  it("presses the first character with the sticky modifiers, then types the rest", () => {
    expect(textInputs("c", new Set(["ctrl"]))).toEqual([{ _tag: "Keys", keys: "ctrl+c" }]);
    expect(textInputs("Vx", new Set(["ctrl"]))).toEqual([
      { _tag: "Keys", keys: "ctrl+shift+v" },
      { _tag: "Text", text: "x" },
    ]);
    expect(textInputs("r", new Set(["win"]))).toEqual([{ _tag: "Keys", keys: "win+r" }]);
  });
});

describe("comboString", () => {
  it("orders the modifiers and names the awkward keys", () => {
    expect(comboString(["win", "ctrl", "shift"], "s")).toBe("ctrl+shift+win+s");
    expect(comboString(["win"], null)).toBe("win");
  });
});

describe("view zoom and pan", () => {
  const box = { width: 400, height: 250 };

  it("zooms around the fingers' centre and keeps that point still", () => {
    const zoomed = zoomView(IDENTITY_VIEW, 2, 100, 50, box);
    expect(zoomed).toEqual({ scale: 2, x: -100, y: -50 });
    // The box point (100, 50) still shows the same content point: (100 - x) / scale.
    expect((100 - zoomed.x) / zoomed.scale).toBe(100);
  });

  it("never zooms out past the whole screen or in past the maximum", () => {
    expect(zoomView(IDENTITY_VIEW, 0.5, 100, 50, box)).toEqual(IDENTITY_VIEW);
    expect(zoomView(IDENTITY_VIEW, 100, 0, 0, box).scale).toBe(MAX_VIEW_SCALE);
  });

  it("pans only as far as the picture's edges", () => {
    const zoomed = zoomView(IDENTITY_VIEW, 2, 0, 0, box);
    expect(panView(zoomed, 50, 50, box)).toEqual({ scale: 2, x: 0, y: 0 });
    expect(panView(zoomed, -1_000, -1_000, box)).toEqual({ scale: 2, x: -400, y: -250 });
    // Unzoomed there is nothing to pan.
    expect(panView(IDENTITY_VIEW, 30, 30, box)).toEqual(IDENTITY_VIEW);
    expect(clampView({ scale: 0.4, x: 10, y: 10 }, box)).toEqual(IDENTITY_VIEW);
  });
});

describe("framePoint", () => {
  const rect = { left: 10, top: 20, width: 390, height: 243.75 };
  const frame = { width: 1170, height: 731 };

  it("maps a client point on the picture onto the frame's pixels", () => {
    expect(framePoint(10, 20, rect, frame)).toEqual({ x: 0, y: 0 });
    expect(framePoint(205, 141.875, rect, frame)).toEqual({ x: 585, y: 365.5 });
  });

  it("maps through a zoomed picture using its on-screen rect", () => {
    const zoomed = { left: -380, top: -223.75, width: 780, height: 487.5 };
    expect(framePoint(10, 20, zoomed, frame)).toEqual({ x: 585, y: 365.5 });
  });

  it("refuses points off the picture, or pulls a drag to the nearest edge", () => {
    expect(framePoint(5, 30, rect, frame)).toBeNull();
    expect(framePoint(401, 30, rect, frame)).toBeNull();
    expect(framePoint(5, 30, rect, frame, true)?.x).toBe(0);
    expect(framePoint(999, 999, rect, frame, true)).toEqual({ x: 1169.99, y: 730.99 });
  });
});

describe("wheel units", () => {
  it("scales a two-finger scroll by the zoom so the page follows the fingers", () => {
    // Unzoomed on a phone: 1 client px covers 3 frame px.
    expect(touchScrollWheel(40, 243.67, 731)).toBe(180);
    // Zoomed 3x the same finger travel scrolls a third as far.
    expect(touchScrollWheel(40, 731, 731)).toBe(60);
    expect(touchScrollWheel(10_000, 243, 731)).toBe(2_400);
    expect(touchScrollWheel(5, 0, 731)).toBe(0);
  });

  it("turns browser wheel deltas into notches", () => {
    expect(mouseWheelUnits(100, 0)).toBe(120);
    expect(mouseWheelUnits(-3, 1)).toBe(-120);
    expect(mouseWheelUnits(1, 2)).toBe(360);
  });

  it("maps mouse buttons", () => {
    expect([0, 1, 2].map(mouseButton)).toEqual(["left", "middle", "right"]);
  });
});
