import { describe, expect, it } from "@effect/vitest";

import { DesktopHelperError } from "../DesktopHelper.ts";
import { isModifierEntry, keysymName } from "./keyMap.ts";

describe("keysymName", () => {
  it("maps the tool layer's virtual keys to XKB names", () => {
    expect(keysymName(0x11)).toBe("Control_L");
    expect(keysymName(0x10)).toBe("Shift_L");
    expect(keysymName(0x12)).toBe("Alt_L");
    expect(keysymName(0x5b)).toBe("Super_L");
    expect(keysymName(0x0d)).toBe("Return");
    expect(keysymName(0x1b)).toBe("Escape");
    expect(keysymName(0x21)).toBe("Page_Up");
    expect(keysymName(0xbb)).toBe("plus");
    expect(keysymName(0xaf)).toBe("XF86AudioRaiseVolume");
  });

  it("maps letters, digits and function keys", () => {
    expect(keysymName(0x41)).toBe("a");
    expect(keysymName(0x5a)).toBe("z");
    expect(keysymName(0x30)).toBe("0");
    expect(keysymName(0x70)).toBe("F1");
    expect(keysymName(0x87)).toBe("F24");
  });

  it("passes a literal symbol through unchanged", () => {
    expect(keysymName({ char: "/" })).toBe("/");
    expect(keysymName({ char: "?" })).toBe("?");
  });

  it("refuses a virtual key it has no Linux equivalent for", () => {
    expect(() => keysymName(0x01)).toThrow(DesktopHelperError);
    try {
      keysymName(0x01);
    } catch (error) {
      expect((error as DesktopHelperError).code).toBe("invalid");
    }
  });

  it("knows exactly the four modifiers the pointer tools may hold", () => {
    expect(isModifierEntry(0x10)).toBe(true);
    expect(isModifierEntry(0x11)).toBe(true);
    expect(isModifierEntry(0x12)).toBe(true);
    expect(isModifierEntry(0x5b)).toBe(true);
    expect(isModifierEntry(0x41)).toBe(false);
    expect(isModifierEntry({ char: "a" })).toBe(false);
  });
});
