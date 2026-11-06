import { describe, expect, it } from "vite-plus/test";

import type { UpdateSnapshot } from "../updater";
import { createUpdaterStateTracker, updaterStateBody } from "./updaterDiag";

const snapshot = (overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  installedVersion: "1.66.117",
  installedCode: 1_066_117,
  state: "idle",
  target: null,
  rejected: null,
  lastCheckAt: 1_700_000_000_000,
  sessionGeneration: 4,
  testPin: false,
  ...overrides,
});

const target = { version: "1.66.118", sha256: "a".repeat(64), size: 42_000_000 };

describe("updater-state client diag", () => {
  it("carries the state and the two versions and nothing else", () => {
    expect(updaterStateBody(snapshot({ state: "needsPermission", target }))).toEqual({
      event: "updater-state",
      state: "needsPermission",
      targetVersion: "1.66.118",
      currentVersion: "1.66.117",
    });
  });

  it("leaves the target out when the updater has none", () => {
    expect(updaterStateBody(snapshot())).toEqual({
      event: "updater-state",
      state: "idle",
      currentVersion: "1.66.117",
    });
  });

  it("reports a state once, then only when the state or target changes", () => {
    const tracker = createUpdaterStateTracker();
    const stalled = snapshot({ state: "needsPermission", target });
    expect(tracker.next(stalled)?.state).toBe("needsPermission");
    expect(tracker.next({ ...stalled, lastCheckAt: 1_700_000_100_000 })).toBeNull();
    expect(tracker.next(snapshot({ state: "downloading", target }))?.state).toBe("downloading");
    const newer = { ...target, version: "1.66.119" };
    expect(tracker.next(snapshot({ state: "downloading", target: newer }))?.targetVersion).toBe(
      "1.66.119",
    );
    expect(tracker.next(snapshot())?.state).toBe("idle");
  });

  it("stays silent for a launch that finds the updater idle", () => {
    expect(createUpdaterStateTracker().next(snapshot())).toBeNull();
  });
});
