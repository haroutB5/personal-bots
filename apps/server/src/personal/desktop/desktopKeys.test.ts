import { describe, expect, it } from "@effect/vitest";

import { DesktopKeyError, parseKeyCombos, planHold } from "./desktopKeys.ts";

describe("parseKeyCombos", () => {
  it("maps named keys and letters to virtual-key codes", () => {
    expect(parseKeyCombos("ctrl+shift+t")).toEqual([[0x11, 0x10, 0x54]]);
    expect(parseKeyCombos("Return")).toEqual([[0x0d]]);
    expect(parseKeyCombos("win+r")).toEqual([[0x5b, 0x52]]);
    expect(parseKeyCombos("alt+F4")).toEqual([[0x12, 0x73]]);
    expect(parseKeyCombos("Page_Down")).toEqual([[0x22]]);
  });

  it("presses space-separated combinations in order", () => {
    expect(parseKeyCombos("ctrl+a delete")).toEqual([[0x11, 0x41], [0x2e]]);
  });

  it("leaves layout-dependent symbols for the helper", () => {
    expect(parseKeyCombos("ctrl+/")).toEqual([[0x11, { char: "/" }]]);
    expect(parseKeyCombos("ctrl+plus")).toEqual([[0x11, 0xbb]]);
  });

  it("refuses unknown names", () => {
    expect(() => parseKeyCombos("ctrl+hyper")).toThrow(DesktopKeyError);
    expect(() => parseKeyCombos("   ")).toThrow(DesktopKeyError);
  });
});

describe("planHold", () => {
  it("holds modifiers and navigation keys for up to 30 s, repeating the non-modifier key", () => {
    expect(planHold("shift", 30_000)).toEqual({ combo: [0x10], repeat: false });
    expect(planHold("ctrl+shift", 50)).toEqual({ combo: [0x11, 0x10], repeat: false });
    expect(planHold("down", 30_000)).toEqual({ combo: [0x28], repeat: true });
    expect(planHold("pageup", 1000)).toEqual({ combo: [0x21], repeat: true });
    expect(planHold("f5", 1000)).toEqual({ combo: [0x74], repeat: true });
    expect(planHold("shift+down", 1000)).toEqual({ combo: [0x10, 0x28], repeat: true });
  });

  it("refuses a duration outside 50 ms to 30 s, or a fraction", () => {
    for (const durationMs of [0, 49, 30_001, 60_000, -5, 1.5, Number.NaN]) {
      expect(() => planHold("shift", durationMs), String(durationMs)).toThrow(DesktopKeyError);
    }
    expect(() => planHold("shift", 30_001)).toThrow(/30000/);
  });

  it("holds one chord only", () => {
    expect(() => planHold("ctrl a", 100)).toThrow(/one chord/);
    expect(() => planHold("", 100)).toThrow(DesktopKeyError);
    expect(() => planHold("a+b", 100)).toThrow(/at most one key besides the modifiers/);
    expect(() => planHold("down+up", 100)).toThrow(DesktopKeyError);
  });

  it("cannot be used to type: a plain printable key is pressed once, briefly", () => {
    // Letters, digits, space and symbols, alone or with shift only.
    for (const keys of ["a", "Z", "7", "space", "/", "shift+a", "shift+4", "plus", "minus"]) {
      expect(planHold(keys, 2000).repeat, keys).toBe(false);
      expect(() => planHold(keys, 2001), keys).toThrow(/computer_type/);
      expect(() => planHold(keys, 30_000), keys).toThrow(/cannot type text/);
    }
  });

  it("caps keys that repeat destructively: backspace, delete and enter", () => {
    for (const keys of ["backspace", "delete", "enter", "ctrl+backspace", "shift+delete"]) {
      expect(planHold(keys, 3000).repeat, keys).toBe(true);
      expect(() => planHold(keys, 3001), keys).toThrow(/computer_key/);
    }
    // Navigation keys keep the full 30 s.
    expect(planHold("tab", 30_000).repeat).toBe(true);
    expect(planHold("left", 30_000).repeat).toBe(true);
  });

  it("lets a shortcut hold a letter: ctrl, alt or win turn it into a command, not text", () => {
    expect(planHold("ctrl+z", 5000)).toEqual({ combo: [0x11, 0x5a], repeat: true });
    expect(planHold("alt+left", 5000)).toEqual({ combo: [0x12, 0x25], repeat: true });
    expect(planHold("win+d", 5000)).toEqual({ combo: [0x5b, 0x44], repeat: true });
  });
});
