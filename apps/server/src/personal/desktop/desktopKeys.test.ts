import { describe, expect, it } from "@effect/vitest";

import { DesktopKeyError, parseKeyCombos } from "./desktopKeys.ts";

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
