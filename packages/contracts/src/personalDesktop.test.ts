import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  clampPersonalDesktopViewBox,
  PERSONAL_DESKTOP_REMOTE_TEXT_MAX,
  PERSONAL_DESKTOP_VIEW_MAX_EDGE,
  PersonalDesktopViewInput,
  PersonalDesktopViewMessage,
} from "./personalDesktop.ts";

describe("personal desktop live view contracts", () => {
  it("caps the long edge at the maximum and keeps the aspect", () => {
    expect(clampPersonalDesktopViewBox({ width: 1170, height: 2532 })).toEqual({
      width: 591,
      height: PERSONAL_DESKTOP_VIEW_MAX_EDGE,
    });
    expect(clampPersonalDesktopViewBox({ width: 3840, height: 2160 })).toEqual({
      width: 1280,
      height: 720,
    });
    expect(clampPersonalDesktopViewBox({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("raises tiny boxes and replaces nonsense with the maximum", () => {
    expect(clampPersonalDesktopViewBox({ width: 40, height: 30 })).toEqual({
      width: 240,
      height: 240,
    });
    expect(clampPersonalDesktopViewBox({ width: Number.NaN, height: 0 })).toEqual({
      width: 1280,
      height: 1280,
    });
  });

  it("accepts Ack and Viewport from a viewer", () => {
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewInput));
    expect(decode(JSON.stringify({ _tag: "Ack" }))._tag).toBe("Some");
    expect(decode(JSON.stringify({ _tag: "Viewport", width: 1170, height: 731 }))._tag).toBe(
      "Some",
    );
    expect(decode(JSON.stringify({ _tag: "Viewport", width: -5, height: 10 }))._tag).toBe("None");
  });

  it("validates remote control input: shapes, ranges, buttons, modifiers and text length", () => {
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewInput));
    const ok = (value: unknown) => decode(JSON.stringify(value))._tag === "Some";
    const point = { x: 10, y: 20, frameWidth: 1170, frameHeight: 731 };
    expect(ok({ _tag: "Control", on: true })).toBe(true);
    expect(ok({ _tag: "Pointer", action: "click", ...point, count: 2 })).toBe(true);
    expect(ok({ _tag: "Pointer", action: "down", ...point, button: "right" })).toBe(true);
    expect(ok({ _tag: "Pointer", action: "click", ...point, modifiers: ["ctrl", "shift"] })).toBe(
      true,
    );
    // The old browser-style tap, unknown buttons, triple clicks and odd modifiers are refused.
    expect(ok({ _tag: "Pointer", action: "tap", ...point })).toBe(false);
    expect(ok({ _tag: "Pointer", action: "click", ...point, button: "x1" })).toBe(false);
    expect(ok({ _tag: "Pointer", action: "click", ...point, count: 3 })).toBe(false);
    expect(ok({ _tag: "Pointer", action: "click", ...point, modifiers: ["hyper"] })).toBe(false);
    expect(ok({ _tag: "Pointer", action: "move", ...point, x: -1 })).toBe(false);
    expect(ok({ _tag: "Pointer", action: "move", ...point, x: Number.NaN })).toBe(false);
    expect(ok({ _tag: "Pointer", action: "move", ...point, frameWidth: 0 })).toBe(false);
    expect(ok({ _tag: "Scroll", ...point, deltaX: 0, deltaY: -240 })).toBe(true);
    expect(ok({ _tag: "Scroll", ...point, deltaX: 0, deltaY: 99_999 })).toBe(false);
    expect(ok({ _tag: "Keys", keys: "ctrl+c" })).toBe(true);
    expect(ok({ _tag: "Keys", keys: "" })).toBe(false);
    expect(ok({ _tag: "Text", text: "hello" })).toBe(true);
    expect(ok({ _tag: "Text", text: "x".repeat(PERSONAL_DESKTOP_REMOTE_TEXT_MAX + 1) })).toBe(
      false,
    );
  });

  it("round-trips the control and refusal messages", () => {
    const codec = Schema.fromJsonString(PersonalDesktopViewMessage);
    for (const message of [
      { _tag: "Control", on: true },
      { _tag: "Control", on: false, detail: "Remote control ended after 2 minutes without input." },
      { _tag: "InputRefused", detail: "PC is locked; it can't be unlocked remotely." },
    ] as const) {
      const text = Schema.encodeSync(codec)(message);
      expect(Schema.decodeUnknownSync(codec)(text)).toEqual(message);
    }
  });

  it("round-trips the view state message", () => {
    const codec = Schema.fromJsonString(PersonalDesktopViewMessage);
    const text = Schema.encodeSync(codec)({ _tag: "ViewState", state: "locked" });
    expect(Schema.decodeUnknownSync(codec)(text)).toEqual({ _tag: "ViewState", state: "locked" });
  });
});
