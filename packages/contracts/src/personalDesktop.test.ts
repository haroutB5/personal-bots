import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { decodePersonalBrowserFrame } from "./personalBrowser.ts";
import {
  clampPersonalDesktopViewBox,
  decodePersonalDesktopFrame,
  encodePersonalDesktopFrame,
  PERSONAL_DESKTOP_REMOTE_TEXT_MAX,
  PERSONAL_DESKTOP_VIEW_MAX_EDGE,
  PersonalDesktopViewInput,
  PersonalDesktopViewMessage,
} from "./personalDesktop.ts";

describe("personal desktop live view contracts", () => {
  it("caps each edge at the maximum", () => {
    expect(clampPersonalDesktopViewBox({ width: 1290, height: 2796 })).toEqual({
      width: 1290,
      height: PERSONAL_DESKTOP_VIEW_MAX_EDGE,
    });
    // A wide landscape phone keeps its height: a 16:10 screen fits by height.
    expect(clampPersonalDesktopViewBox({ width: 2796, height: 1290 })).toEqual({
      width: PERSONAL_DESKTOP_VIEW_MAX_EDGE,
      height: 1290,
    });
    expect(clampPersonalDesktopViewBox({ width: 3840, height: 2160 })).toEqual({
      width: 2560,
      height: 2160,
    });
    // A phone-width box is no longer squeezed to 1280.
    expect(clampPersonalDesktopViewBox({ width: 1290, height: 730 })).toEqual({
      width: 1290,
      height: 730,
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
      width: PERSONAL_DESKTOP_VIEW_MAX_EDGE,
      height: PERSONAL_DESKTOP_VIEW_MAX_EDGE,
    });
  });

  it("accepts Ack and Viewport from a viewer", () => {
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewInput));
    expect(decode(JSON.stringify({ _tag: "Ack" }))._tag).toBe("Some");
    expect(decode(JSON.stringify({ _tag: "Viewport", width: 1170, height: 731 }))._tag).toBe(
      "Some",
    );
    expect(decode(JSON.stringify({ _tag: "Viewport", width: -5, height: 10 }))._tag).toBe("None");
    const region = { x: 0.25, y: 0.3, width: 1 / 3, height: 1 / 3 };
    expect(
      decode(JSON.stringify({ _tag: "Viewport", width: 1290, height: 730, region }))._tag,
    ).toBe("Some");
    expect(
      decode(
        JSON.stringify({
          _tag: "Viewport",
          width: 1290,
          height: 730,
          region: { ...region, x: 1.5 },
        }),
      )._tag,
    ).toBe("None");
  });

  it("carries the region and monitor size on every region frame", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3]);
    const meta = {
      width: 1024,
      height: 640,
      region: { x: 1024, y: 640, width: 1024, height: 640 },
      screenWidth: 3072,
      screenHeight: 1920,
    };
    const frame = encodePersonalDesktopFrame(jpeg, meta);
    const decoded = decodePersonalDesktopFrame(frame);
    expect(decoded?.meta).toEqual(meta);
    expect(Array.from(decoded!.jpeg)).toEqual(Array.from(jpeg));
    // The browser decoder refuses it, so an older app never misplaces it.
    expect(decodePersonalBrowserFrame(frame)).toBeNull();
    // A region that runs off the monitor is refused.
    expect(
      decodePersonalDesktopFrame(
        encodePersonalDesktopFrame(jpeg, { ...meta, region: { ...meta.region, x: 2500 } }),
      ),
    ).toBeNull();
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
