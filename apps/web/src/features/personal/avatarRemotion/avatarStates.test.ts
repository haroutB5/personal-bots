import { describe, expect, it } from "vite-plus/test";

import {
  AVATAR_STATE_SPECS,
  avatarFinalPose,
  avatarPoseAt,
  REST_POSE,
  type AvatarPose,
} from "./avatarStates";
import {
  AVATAR_ANIM_STATES,
  avatarPlayerMode,
  isContinuousAvatarState,
  staticMotionFor,
  type AvatarPlayerModeInput,
} from "./playerMode";

const POSE_KEYS = Object.keys(REST_POSE) as (keyof AvatarPose)[];

function maxDelta(a: AvatarPose, b: AvatarPose): number {
  return Math.max(...POSE_KEYS.map((key) => Math.abs(a[key] - b[key])));
}

describe("avatarPoseAt", () => {
  it("loops seamlessly: the frame after the last equals frame 0 and steps stay small", () => {
    for (const state of AVATAR_ANIM_STATES) {
      const { durationInFrames, loop } = AVATAR_STATE_SPECS[state];
      if (!loop) continue;
      const last = avatarPoseAt(state, durationInFrames - 1);
      const wrapped = avatarPoseAt(state, durationInFrames);
      expect(maxDelta(wrapped, avatarPoseAt(state, 0))).toBe(0);
      // The seam is no bigger than an ordinary frame-to-frame step.
      expect(maxDelta(last, wrapped)).toBeLessThan(1);
    }
  });

  it("holds the final pose after a one-shot ends", () => {
    for (const state of AVATAR_ANIM_STATES) {
      const { durationInFrames, loop } = AVATAR_STATE_SPECS[state];
      if (loop) continue;
      expect(avatarPoseAt(state, durationInFrames + 40)).toEqual(avatarFinalPose(state));
      // Settled: the last two frames are (almost) identical, so the swap to a
      // static SVG cannot jump.
      const beforeLast = avatarPoseAt(state, durationInFrames - 2);
      expect(maxDelta(beforeLast, avatarFinalPose(state))).toBeLessThan(0.15);
    }
  });

  it("ends done exactly on the rest pose, so idle takes over invisibly", () => {
    expect(maxDelta(avatarFinalPose("done"), REST_POSE)).toBeLessThan(1e-9);
  });

  it("keeps every pose within a few viewBox units of rest", () => {
    for (const state of AVATAR_ANIM_STATES) {
      const { durationInFrames } = AVATAR_STATE_SPECS[state];
      for (let frame = 0; frame < durationInFrames; frame += 1) {
        const pose = avatarPoseAt(state, frame);
        expect(Math.abs(pose.bodyY)).toBeLessThanOrEqual(4.5);
        expect(Math.abs(pose.bodyRotate)).toBeLessThanOrEqual(5);
        expect(Math.abs(pose.gazeX)).toBeLessThanOrEqual(3.5);
        expect(Math.abs(pose.gazeY)).toBeLessThanOrEqual(5); // waiting overshoots a touch
        expect(pose.eyeOpen).toBeGreaterThan(0);
        expect(pose.eyeOpen).toBeLessThanOrEqual(1.35);
        expect(pose.happy).toBeGreaterThanOrEqual(0);
        expect(pose.happy).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives each state a distinct signature", () => {
    expect(avatarFinalPose("waiting").gazeY).toBeLessThan(-3); // looking up
    expect(avatarFinalPose("blocked").eyeOpen).toBeLessThan(0.6); // drooped lids
    expect(avatarFinalPose("blocked").bodyY).toBeGreaterThan(1.5); // sunk
    expect(avatarPoseAt("done", 12).happy).toBe(1); // happy squint mid-hop
    expect(avatarPoseAt("working", 18).bodyY).toBeLessThan(-2.9); // top of the bob
    expect(avatarPoseAt("thinking", 18).gazeX).toBeGreaterThan(2.9); // scanning
  });
});

describe("avatarPlayerMode", () => {
  const base: AvatarPlayerModeInput = {
    state: "working",
    reducedMotion: false,
    documentHidden: false,
    continuousAllowed: true,
  };

  it("never mounts a Player for idle", () => {
    expect(avatarPlayerMode({ ...base, state: "idle" })).toBe("static");
  });

  it("is fully static under reduced motion and when the document is hidden", () => {
    for (const state of AVATAR_ANIM_STATES) {
      expect(avatarPlayerMode({ ...base, state, reducedMotion: true })).toBe("static");
      expect(avatarPlayerMode({ ...base, state, documentHidden: true })).toBe("static");
    }
  });

  it("loops thinking/working only for the holder of the continuous slot", () => {
    expect(avatarPlayerMode({ ...base, state: "working" })).toBe("loop");
    expect(avatarPlayerMode({ ...base, state: "thinking" })).toBe("loop");
    expect(avatarPlayerMode({ ...base, continuousAllowed: false })).toBe("static");
    expect(avatarPlayerMode({ ...base, state: "thinking", continuousAllowed: false })).toBe(
      "static",
    );
  });

  it("plays waiting/blocked/done once, whatever the slot", () => {
    for (const state of ["waiting", "blocked", "done"] as const) {
      expect(avatarPlayerMode({ ...base, state, continuousAllowed: false })).toBe("once");
      expect(isContinuousAvatarState(state)).toBe(false);
    }
  });

  it("never falls back to a CSS bob for a looping state that lost its slot", () => {
    expect(staticMotionFor("working", false)).toBe("idle");
    expect(staticMotionFor("thinking", true)).toBe("idle");
    expect(staticMotionFor("working", true)).toBe("working");
    expect(staticMotionFor("blocked", false)).toBe("blocked");
  });
});
