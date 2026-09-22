import { describe, expect, it } from "vite-plus/test";

import { AVATAR_MOTIONS } from "../avatarMotion";
import {
  avatarFinalPose,
  avatarPoseAtTime,
  avatarStateTiming,
  REST_POSE,
  type AvatarPose,
} from "./avatarStates";

const POSE_KEYS = Object.keys(REST_POSE) as (keyof AvatarPose)[];
const BODY_KEYS: readonly (keyof AvatarPose)[] = [
  "bodyX",
  "bodyY",
  "bodyRotate",
  "bodyScaleX",
  "bodyScaleY",
];
const EYE_KEYS = POSE_KEYS.filter((key) => !BODY_KEYS.includes(key));

function maxDelta(
  a: AvatarPose,
  b: AvatarPose,
  keys: readonly (keyof AvatarPose)[] = POSE_KEYS,
): number {
  return Math.max(...keys.map((key) => Math.abs(a[key] - b[key])));
}

function samples(state: (typeof AVATAR_MOTIONS)[number]): AvatarPose[] {
  const timing = avatarStateTiming(state);
  const end = timing.loop
    ? timing.introSeconds + Math.max(timing.bodySeconds, timing.eyeSeconds)
    : timing.seconds;
  return Array.from({ length: Math.ceil(end * 60) + 1 }, (_, index) =>
    avatarPoseAtTime(state, index / 60),
  );
}

describe("avatarPoseAtTime", () => {
  it("starts every state from rest, so entering one never jumps", () => {
    for (const state of AVATAR_MOTIONS) {
      expect(maxDelta(avatarPoseAtTime(state, 0), REST_POSE)).toBeLessThan(1e-9);
    }
  });

  it("loops seamlessly: each layer's steady state wraps on its own period", () => {
    for (const state of AVATAR_MOTIONS) {
      const timing = avatarStateTiming(state);
      if (!timing.loop) continue;
      const start = timing.introSeconds;
      const at = (t: number) => avatarPoseAtTime(state, t);
      // The simulated steady state is periodic: one period on is the same pose.
      expect(
        maxDelta(at(start + 0.01), at(start + 0.01 + timing.bodySeconds), BODY_KEYS),
      ).toBeLessThan(1e-3);
      expect(maxDelta(at(start + 0.3), at(start + 0.3 + timing.eyeSeconds), EYE_KEYS)).toBeLessThan(
        1e-3,
      );
      // The spring-in hands over to the steady state without a visible step.
      expect(maxDelta(at(start - 1e-4), at(start + 1e-4))).toBeLessThan(0.15);
    }
  });

  it("holds the final pose after a one-shot ends, settled", () => {
    for (const state of AVATAR_MOTIONS) {
      const timing = avatarStateTiming(state);
      if (timing.loop) continue;
      expect(avatarPoseAtTime(state, timing.seconds + 5)).toEqual(avatarFinalPose(state));
      expect(
        maxDelta(avatarPoseAtTime(state, timing.seconds - 0.1), avatarFinalPose(state)),
      ).toBeLessThan(0.05);
    }
  });

  it("ends done exactly on the rest pose, so idle takes over invisibly", () => {
    expect(maxDelta(avatarFinalPose("done"), REST_POSE)).toBeLessThan(1e-9);
  });

  it("keeps every pose within a few viewBox units of rest, eyes on the body", () => {
    for (const state of AVATAR_MOTIONS) {
      for (const pose of samples(state)) {
        expect(Math.abs(pose.bodyX)).toBeLessThanOrEqual(3);
        expect(Math.abs(pose.bodyY)).toBeLessThanOrEqual(3.5);
        expect(Math.abs(pose.bodyRotate)).toBeLessThanOrEqual(9);
        expect(Math.abs(pose.gazeX)).toBeLessThanOrEqual(6);
        expect(Math.abs(pose.gazeY)).toBeLessThanOrEqual(3.6);
        expect(pose.eyeOpen).toBeGreaterThan(0.05);
        expect(pose.eyeOpen).toBeLessThanOrEqual(1.3);
        expect(pose.happy).toBeGreaterThanOrEqual(0);
        expect(pose.happy).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives each state xAI's signature", () => {
    const thinking = samples("thinking");
    // Thinking: head tilted one way the whole time, eyes wandering up.
    expect(Math.max(...thinking.slice(60).map((pose) => pose.bodyRotate))).toBeLessThan(-1);
    expect(Math.min(...thinking.map((pose) => pose.gazeY))).toBeLessThan(-2);
    expect(Math.max(...thinking.map((pose) => pose.gazeY))).toBeLessThanOrEqual(0.01);
    // Working: eyes down at the work.
    expect(Math.max(...samples("working").map((pose) => pose.gazeY))).toBeGreaterThan(2);
    // Waiting (bored): half-lidded, sunk a little.
    expect(avatarFinalPose("waiting").eyeOpen).toBeLessThan(0.62);
    expect(avatarFinalPose("waiting").bodyY).toBeGreaterThan(1.5);
    // Blocked: drooped with heavy lids.
    expect(avatarFinalPose("blocked").eyeOpen).toBeLessThan(0.6);
    // Done: hops with big eyes, then a happy squint.
    const done = samples("done");
    expect(Math.min(...done.map((pose) => pose.bodyY))).toBeLessThan(-1.5);
    expect(Math.max(...done.map((pose) => pose.eyeWiden))).toBeGreaterThan(1.08);
    expect(Math.max(...done.map((pose) => pose.happy))).toBeGreaterThan(0.9);
  });

  it("blinks at random times rather than on a beat", () => {
    const working = samples("working");
    const closedAt = working
      .map((pose, index) => ({ index, closed: pose.eyeOpen < 0.3 }))
      .filter(({ closed }, position, all) => closed && !all[position - 1]?.closed)
      .map(({ index }) => index);
    expect(closedAt.length).toBeGreaterThanOrEqual(2);
    const gaps = closedAt.slice(1).map((index, position) => index - closedAt[position]!);
    expect(new Set(gaps).size).toBe(gaps.length);
  });
});
