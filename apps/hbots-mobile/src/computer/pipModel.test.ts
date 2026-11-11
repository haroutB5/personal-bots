import { describe, expect, it } from "vite-plus/test";
import {
  effectivelyActive,
  fullScreenVisible,
  inlinePaused,
  pipEnabled,
  samePipRequest,
} from "./pipModel";

const playing = { streaming: true, focused: true, appActive: true, inPip: false };

describe("picture-in-picture state", () => {
  it("is on while the live view plays on the focused screen", () => {
    expect(pipEnabled(playing)).toBe(true);
  });

  it("is off with a placeholder instead of a stream", () => {
    expect(pipEnabled({ ...playing, streaming: false })).toBe(false);
  });

  it("is off when another screen is focused", () => {
    expect(pipEnabled({ ...playing, focused: false })).toBe(false);
  });

  it("is off once the app is in the background", () => {
    expect(pipEnabled({ ...playing, appActive: false })).toBe(false);
  });

  it("stays on inside the PiP window although AppState reads background", () => {
    expect(pipEnabled({ ...playing, appActive: false, inPip: true })).toBe(true);
    expect(effectivelyActive({ appActive: false, inPip: true })).toBe(true);
  });
});

describe("which live view plays", () => {
  const base = { focused: true, appActive: true, fullScreen: false, inPip: false };

  it("plays the inline view normally", () => {
    expect(inlinePaused(base)).toBe(false);
  });

  it("pauses the inline view under full screen", () => {
    expect(inlinePaused({ ...base, fullScreen: true })).toBe(true);
  });

  it("pauses the inline view while the PiP window has its own", () => {
    expect(inlinePaused({ ...base, inPip: true })).toBe(true);
  });

  it("hides full screen in PiP and brings it back after", () => {
    expect(fullScreenVisible({ fullScreen: true, inPip: true })).toBe(false);
    expect(fullScreenVisible({ fullScreen: true, inPip: false })).toBe(true);
    expect(fullScreenVisible({ fullScreen: false, inPip: false })).toBe(false);
  });
});

describe("repeated requests", () => {
  const a = { enabled: true, frame: { width: 1280, height: 720 } };

  it("treats an equal request as the same", () => {
    expect(samePipRequest(a, { enabled: true, frame: { width: 1280, height: 720 } })).toBe(true);
  });

  it("treats a changed flag or shape as new", () => {
    expect(samePipRequest(a, { ...a, enabled: false })).toBe(false);
    expect(samePipRequest(a, { ...a, frame: { width: 1280, height: 800 } })).toBe(false);
  });
});
