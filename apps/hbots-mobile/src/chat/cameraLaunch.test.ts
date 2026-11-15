import { describe, expect, it, vi } from "vite-plus/test";

import {
  BLACK_PHOTO_LUMA,
  cameraFailure,
  cameraLaunchDecision,
  cameraLaunchKey,
  cameraLaunchNotice,
  isBlackPhoto,
  isStuckLauncherFailure,
  pendingLaunchOwner,
  photoLaunchNotice,
  watchCameraLaunch,
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

  it("falls back to the in-app camera when a pending launch runs out of foreground time", () => {
    expect(cameraLaunchDecision({ kind: "timeout", launchSettled: false })).toEqual({
      kind: "fallback",
      reason: "System camera did not open.",
    });
  });

  it("never treats a launch that settled before the timeout as stalled", () => {
    expect(cameraLaunchDecision({ kind: "timeout", launchSettled: true })).toEqual({
      kind: "stop",
    });
  });
});

describe("watchCameraLaunch", () => {
  const watch = (isForeground: () => boolean) => watchCameraLaunch({ stallMs: 1500, isForeground });

  const pending = async (outcome: Promise<unknown>) =>
    await Promise.race([outcome, Promise.resolve("pending")]);

  it("never stalls a launch that settled first", async () => {
    vi.useFakeTimers();
    try {
      const timer = watch(() => true);
      timer.settle({ kind: "succeeded" });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(timer.outcome).resolves.toEqual({ kind: "succeeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stalls only a launch that stayed in the foreground for the whole wait", async () => {
    vi.useFakeTimers();
    try {
      const timer = watch(() => true);
      await vi.advanceTimersByTimeAsync(1499);
      expect(await pending(timer.outcome)).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(timer.outcome).resolves.toEqual({ kind: "timeout", launchSettled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the wait when the app leaves the foreground", async () => {
    vi.useFakeTimers();
    try {
      const timer = watch(() => false);
      await vi.advanceTimersByTimeAsync(500);
      timer.background();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending(timer.outcome)).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart the wait when the app comes back", async () => {
    let foreground = true;
    vi.useFakeTimers();
    try {
      const timer = watch(() => foreground);
      await vi.advanceTimersByTimeAsync(500);
      foreground = false;
      timer.background();
      await vi.advanceTimersByTimeAsync(300);
      foreground = true;
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending(timer.outcome)).toBe("pending");
      timer.settle({ kind: "succeeded" });
      await expect(timer.outcome).resolves.toEqual({ kind: "succeeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stall when the timeout fires while the app is not active", async () => {
    vi.useFakeTimers();
    try {
      const timer = watch(() => false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending(timer.outcome)).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timeout when the camera answers late", async () => {
    vi.useFakeTimers();
    try {
      const timer = watch(() => true);
      await vi.advanceTimersByTimeAsync(1500);
      timer.settle({ kind: "succeeded" });
      await expect(timer.outcome).resolves.toEqual({ kind: "timeout", launchSettled: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isBlackPhoto", () => {
  it("flags the black captures the in-app camera saved", () => {
    expect(isBlackPhoto(0.0012)).toBe(true);
    expect(isBlackPhoto(0)).toBe(true);
    expect(isBlackPhoto(BLACK_PHOTO_LUMA)).toBe(true);
  });

  it("keeps a photo of a real scene", () => {
    expect(isBlackPhoto(0.02)).toBe(false);
    expect(isBlackPhoto(0.4)).toBe(false);
  });

  it("keeps the photo when the check cannot read it", () => {
    expect(isBlackPhoto(null)).toBe(false);
  });
});

describe("pending camera result ownership", () => {
  it("claims a pending result when the launch recorded no chat", () => {
    expect(pendingLaunchOwner(null, "thread-1")).toBe("claim");
  });

  it("claims a pending result in the chat that launched the camera", () => {
    expect(pendingLaunchOwner("thread-1", "thread-1")).toBe("claim");
  });

  it("skips a pending result in another chat", () => {
    expect(pendingLaunchOwner("thread-1", "thread-2")).toBe("skip");
  });

  it("keys the launch per server", () => {
    expect(cameraLaunchKey("env-1")).toBe("t3code:camera-launch:v1:env-1");
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
