import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  clampPersonalDesktopViewBox,
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

  it("accepts only Ack and Viewport from the viewer: there is no input for the PC", () => {
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewInput));
    expect(decode(JSON.stringify({ _tag: "Ack" }))._tag).toBe("Some");
    expect(decode(JSON.stringify({ _tag: "Viewport", width: 1170, height: 731 }))._tag).toBe(
      "Some",
    );
    expect(decode(JSON.stringify({ _tag: "Pointer", action: "tap", x: 1, y: 1 }))._tag).toBe(
      "None",
    );
    expect(decode(JSON.stringify({ _tag: "Viewport", width: -5, height: 10 }))._tag).toBe("None");
  });

  it("round-trips the view state message", () => {
    const codec = Schema.fromJsonString(PersonalDesktopViewMessage);
    const text = Schema.encodeSync(codec)({ _tag: "ViewState", state: "locked" });
    expect(Schema.decodeUnknownSync(codec)(text)).toEqual({ _tag: "ViewState", state: "locked" });
  });
});
