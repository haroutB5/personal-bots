import { Easing, interpolate, spring } from "remotion";

import { REST_POSE, type AvatarPose } from "./pose";
import type { AvatarAnimState } from "./playerMode";

export { REST_POSE, type AvatarPose } from "./pose";

/**
 * Frame-driven poses for the Remotion bot avatar.
 *
 * Every state is a pure function of the frame number, so the Player, the
 * Studio and `remotion render` all draw exactly the same thing and a frame can
 * be unit-tested. No CSS animation or transition is involved (Remotion renders
 * frame by frame and would never see them).
 *
 * Units are the avatar's 0-100 viewBox. At a 56px list avatar one unit is about
 * 0.56px, so the ranges below are deliberately small: the silhouette never
 * leaves its box by more than ~4 units and the eyes never leave the body.
 */

export const AVATAR_FPS = 30;

export interface AvatarStateSpec {
  readonly durationInFrames: number;
  /** Looping states repeat seamlessly; the others play once and hold. */
  readonly loop: boolean;
}

export const AVATAR_STATE_SPECS: Record<AvatarAnimState, AvatarStateSpec> = {
  // Idle never mounts a Player in the app; this exists for the Studio/previews.
  idle: { durationInFrames: 120, loop: true },
  thinking: { durationInFrames: 72, loop: true },
  working: { durationInFrames: 36, loop: true },
  waiting: { durationInFrames: 27, loop: false },
  blocked: { durationInFrames: 27, loop: false },
  done: { durationInFrames: 36, loop: false },
};

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const TAU = Math.PI * 2;

/** Multiplier for eye openness: a quick close/open dip starting at `at`. */
function blink(frame: number, at: number, length = 6): number {
  const half = length / 2;
  return interpolate(frame, [at, at + half, at + length], [1, 0.1, 1], {
    ...CLAMP,
    easing: Easing.inOut(Easing.quad),
  });
}

/** Calm and slightly curious: one blink and one sideways glance per 4s loop. */
function idlePose(frame: number): AvatarPose {
  const glance = interpolate(frame, [48, 56, 80, 88], [0, 1, 1, 0], {
    ...CLAMP,
    easing: Easing.inOut(Easing.cubic),
  });
  return {
    ...REST_POSE,
    gazeX: 2.5 * glance,
    gazeY: -0.8 * glance,
    eyeOpen: blink(frame, 18) * blink(frame, 100),
  };
}

/**
 * Thinking: eyes raised and scanning side to side, the head tilting a touch
 * with them, one blink as the gaze crosses centre. Everything is a whole period of a
 * sine over the loop, so frame N and frame 0 meet exactly.
 */
function thinkingPose(frame: number, duration: number): AvatarPose {
  const phase = (frame / duration) * TAU;
  return {
    ...REST_POSE,
    bodyRotate: 1.5 * Math.sin(phase),
    gazeX: 3 * Math.sin(phase),
    gazeY: -2.2,
    eyeOpen: 0.85 * blink(frame, duration / 2 - 3),
    eyeWiden: 1,
  };
}

/**
 * Working: kicked into gear. A 1.2s bob with a hint of stretch at the top,
 * eyes narrowed and looking down-forward at the task, trailing the body a
 * little (secondary motion). Periodic, so it loops without a seam.
 */
function workingPose(frame: number, duration: number): AvatarPose {
  const phase = (frame / duration) * TAU;
  const lift = (1 - Math.cos(phase)) / 2; // 0 at rest, 1 at the top
  return {
    ...REST_POSE,
    bodyY: -3 * lift,
    bodyScaleX: 1 - 0.015 * lift,
    bodyScaleY: 1 + 0.025 * lift,
    gazeX: 1.5,
    gazeY: 1 + 0.8 * Math.sin(phase - 0.6),
    eyeOpen: 0.78,
    eyeWiden: 1.05,
  };
}

/** Waiting / needs you: eyes spring up and widen, a blink, then hold. */
function waitingPose(frame: number): AvatarPose {
  const s = spring({ frame, fps: AVATAR_FPS, config: { damping: 11, stiffness: 170 } });
  return {
    ...REST_POSE,
    bodyY: -1.2 * s,
    gazeY: -4 * s,
    gazeX: 0.8 * s,
    eyeOpen: (1 + 0.22 * s) * blink(frame, 19, 5),
  };
}

/** Blocked: a slow, un-bouncy droop - body sinks and tips, eyes half-lidded. */
function blockedPose(frame: number): AvatarPose {
  const s = spring({ frame, fps: AVATAR_FPS, config: { damping: 22, stiffness: 90 } });
  return {
    ...REST_POSE,
    bodyY: 2 * s,
    bodyRotate: -5 * s,
    bodyScaleY: 1 - 0.03 * s,
    gazeX: -1 * s,
    gazeY: 2.5 * s,
    eyeOpen: 1 - 0.45 * s,
  };
}

/**
 * Done: a small hop with a happy squint, a landing squash, and a settle that
 * ends exactly on the rest pose so the hand-off to the static idle SVG is
 * invisible.
 */
function donePose(frame: number, duration: number): AvatarPose {
  const hop = frame < 12 ? Math.sin((Math.PI * frame) / 12) : 0;
  const rebound = frame >= 12 && frame < 20 ? Math.sin((Math.PI * (frame - 12)) / 8) : 0;
  const squash = interpolate(frame, [11, 13, 17], [0, 1, 0], CLAMP);
  const happy = interpolate(frame, [2, 8, duration - 12, duration - 3], [0, 1, 1, 0], {
    ...CLAMP,
    easing: Easing.inOut(Easing.quad),
  });
  return {
    ...REST_POSE,
    bodyY: -4 * hop - 0.8 * rebound,
    bodyScaleX: 1 + 0.035 * squash,
    bodyScaleY: 1 - 0.045 * squash,
    gazeY: -1 * happy,
    eyeOpen: 1 - 0.6 * happy,
    happy,
  };
}

/**
 * Pose for `state` at `frame`. Looping states wrap the frame; one-shots clamp
 * it, so any frame past the end is the held final pose.
 */
export function avatarPoseAt(state: AvatarAnimState, frame: number): AvatarPose {
  const { durationInFrames: duration, loop } = AVATAR_STATE_SPECS[state];
  const f = loop
    ? ((frame % duration) + duration) % duration
    : Math.min(Math.max(frame, 0), duration - 1);
  switch (state) {
    case "idle":
      return idlePose(f);
    case "thinking":
      return thinkingPose(f, duration);
    case "working":
      return workingPose(f, duration);
    case "waiting":
      return waitingPose(f);
    case "blocked":
      return blockedPose(f);
    case "done":
      return donePose(f, duration);
  }
}

/** The pose a one-shot state holds once it has played. */
export function avatarFinalPose(state: AvatarAnimState): AvatarPose {
  return avatarPoseAt(state, AVATAR_STATE_SPECS[state].durationInFrames - 1);
}
