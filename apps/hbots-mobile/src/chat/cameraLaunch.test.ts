import { describe, expect, it } from "vite-plus/test";

import {
  cameraFailure,
  cameraLaunchDecision,
  cameraLaunchNotice,
  isStuckLauncherFailure,
  photoLaunchNotice,
} from "./cameraLaunch";

const failure = { code: "ERR_IMAGE_PICKER", message: "launch failed" };

describe("cameraLaunchDecision", () => {
  it("accepts a photo the system camera returned", () => {
    expect(cameraLaunchDecision({ kind: "succeeded" })).toEqual({ kind: "accept" });
  });

  it("does nothing when the user cancelled the system camera", () => {
    expect(cameraLaunchDecision({ kind: "cancelled" })).toEqual({ kind: "stop" });
  });

  it("falls back to the in-app camera when the launch rejects", () => {
    expect(cameraLaunchDecision({ kind: "rejected", failure })).toEqual({
      kind: "fallback",
      reason: "System camera failed (ERR_IMAGE_PICKER).",
    });
  });

  it("falls back to the in-app camera when the launch stalls in the app", () => {
    expect(cameraLaunchDecision({ kind: "stalled" })).toEqual({
      kind: "fallback",
      reason: "System camera did not open.",
    });
  });
});

describe("cameraFailure", () => {
  it("keeps the Expo error code and message", () => {
    const error = Object.assign(new Error("unregistered ActivityResultLauncher"), {
      code: "ERR_IMAGE_PICKER",
    });
    expect(cameraFailure(error)).toEqual({
      code: "ERR_IMAGE_PICKER",
      message: "unregistered ActivityResultLauncher",
    });
  });

  it("names an error without a code", () => {
    expect(cameraFailure("boom")).toEqual({ code: "unknown", message: "boom" });
  });
});

describe("isStuckLauncherFailure", () => {
  it("recognises the unregistered launcher rejection", () => {
    expect(
      isStuckLauncherFailure({
        code: "ERR_IMAGE_PICKER",
        message: "Attempting to launch an unregistered ActivityResultLauncher",
      }),
    ).toBe(true);
  });

  it("does not mark an ordinary camera failure as stuck", () => {
    expect(
      isStuckLauncherFailure({ code: "ERR_IMAGE_PICKER", message: "Camera is unavailable" }),
    ).toBe(false);
  });
});

describe("launch notices", () => {
  it("shows the camera code", () => {
    expect(cameraLaunchNotice(failure)).toEqual({
      message: "Couldn't open the camera (ERR_IMAGE_PICKER).",
      openSettings: false,
    });
  });

  it("shows the photo code and the restart line", () => {
    expect(photoLaunchNotice(failure)).toEqual({
      message:
        "Couldn't open the photo picker (ERR_IMAGE_PICKER). Close and reopen hbots to fix this.",
      openSettings: false,
    });
  });
});
