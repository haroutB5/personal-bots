import { describe, expect, it } from "vite-plus/test";

import { pulseRuns } from "./pulseGate";

describe("pulseRuns", () => {
  it("runs on a focused screen in the foreground", () => {
    expect(pulseRuns({ focused: true, appState: "active", reduced: false })).toBe(true);
  });

  it("stops when the screen is not the one in front", () => {
    expect(pulseRuns({ focused: false, appState: "active", reduced: false })).toBe(false);
  });

  it("stops when the app is in the background or inactive", () => {
    expect(pulseRuns({ focused: true, appState: "background", reduced: false })).toBe(false);
    expect(pulseRuns({ focused: true, appState: "inactive", reduced: false })).toBe(false);
  });

  it("never starts under reduced motion", () => {
    expect(pulseRuns({ focused: true, appState: "active", reduced: true })).toBe(false);
  });
});
