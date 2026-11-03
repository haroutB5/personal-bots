import { describe, expect, it } from "vite-plus/test";

import type { AndroidRelease } from "./compat";
import type { UpdateSnapshot } from "./updater";
import { describeLastCheck, describeUpdate } from "./updateView";

const latest: AndroidRelease = {
  version: "1.66.111",
  sha256: "a".repeat(64),
  size: 46_000_000,
  notes: "",
};

const snapshot = (overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  installedVersion: "1.66.110",
  installedCode: 1_066_110,
  state: "idle",
  target: null,
  rejected: null,
  lastCheckAt: null,
  testPin: true,
  ...overrides,
});

describe("describeUpdate", () => {
  it("says up to date when the latest is not newer", () => {
    expect(describeUpdate(snapshot(), { ...latest, version: "1.66.110" })).toEqual({
      title: "Up to date",
      detail: "hbots 1.66.110 is the latest version.",
      action: "none",
    });
  });

  it("offers a newer release", () => {
    expect(describeUpdate(snapshot(), latest)).toEqual({
      title: "hbots 1.66.111 is available",
      detail: "The download starts with the next check.",
      action: "check",
    });
  });

  it("asks for the install permission", () => {
    expect(describeUpdate(snapshot({ state: "needsPermission", target: latest }), latest)).toEqual({
      title: "Allow app installs",
      detail: "Android needs your permission before hbots can update itself.",
      action: "permission",
    });
  });

  it("offers an install for a ready file", () => {
    expect(describeUpdate(snapshot({ state: "ready", target: latest }), latest).action).toBe(
      "install",
    );
  });

  it("names a rejected download", () => {
    expect(describeUpdate(snapshot({ rejected: "1.66.111" }), latest)).toEqual({
      title: "Update blocked",
      detail: "hbots rejected the last download. Check now to fetch it again.",
      action: "check",
    });
  });
});

describe("describeLastCheck", () => {
  const now = 1_700_000_000_000;

  it("reads as a short relative time", () => {
    expect(describeLastCheck(null, now)).toBe("Not checked yet");
    expect(describeLastCheck(now - 20_000, now)).toBe("Checked just now");
    expect(describeLastCheck(now - 5 * 60_000, now)).toBe("Checked 5 min ago");
    expect(describeLastCheck(now - 3 * 60 * 60_000, now)).toBe("Checked 3 h ago");
    expect(describeLastCheck(now - 2 * 24 * 60 * 60_000, now)).toBe("Checked 2 d ago");
  });
});
