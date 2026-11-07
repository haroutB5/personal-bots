import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo", () => ({ requireNativeView: () => null }));

import { browserInput, desktopInput } from "./liveView";

describe("browserInput", () => {
  it("encodes a navigation as the contract's JSON", () => {
    expect(browserInput({ _tag: "Navigate", url: "https://example.com/a" })).toBe(
      '{"_tag":"Navigate","url":"https://example.com/a"}',
    );
  });

  it("omits an optional focus sequence and keeps the pointer fields", () => {
    expect(browserInput({ _tag: "Pointer", action: "tap", x: 12, y: 34 })).toBe(
      '{"_tag":"Pointer","action":"tap","x":12,"y":34}',
    );
  });

  it("refuses a message the contract would reject", () => {
    expect(() => browserInput({ _tag: "Navigate", url: "" })).toThrow();
  });
});

describe("desktopInput", () => {
  it("encodes the viewport box in device pixels", () => {
    expect(desktopInput({ _tag: "Viewport", width: 1080, height: 2400 })).toBe(
      '{"_tag":"Viewport","width":1080,"height":2400}',
    );
  });

  it("encodes a whole press and release", () => {
    expect(
      desktopInput({
        _tag: "Pointer",
        action: "click",
        x: 4,
        y: 8,
        frameWidth: 320,
        frameHeight: 640,
      }),
    ).toBe('{"_tag":"Pointer","action":"click","x":4,"y":8,"frameWidth":320,"frameHeight":640}');
  });

  it("refuses a viewport the contract would reject", () => {
    expect(() => desktopInput({ _tag: "Viewport", width: 0, height: 2400 })).toThrow();
  });
});
