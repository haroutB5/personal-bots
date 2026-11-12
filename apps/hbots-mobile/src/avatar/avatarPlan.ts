import {
  AVATAR_MOTION_TABLE,
  type AvatarTableState,
  type AvatarTrack,
} from "@hbots/personal-client/bots/avatarMotionTable.generated";
import {
  isContinuousMotion,
  type AvatarMotion,
} from "@hbots/personal-client/bots/avatarMotionState";

export interface AvatarPlayback {
  readonly key: string;
  readonly state: AvatarTableState;
  readonly mode: "loop" | "once";
}

/**
 * What the avatar plays now, or null for the static avatar. Nothing plays
 * unless the screen is in front, the app is active and motion is allowed. An
 * idle bot rests, except for the `done` hop that lands a stopped loop on rest.
 */
export function playbackFor(
  motion: AvatarMotion,
  runs: boolean,
  settling: boolean,
): AvatarPlayback | null {
  if (!runs) return null;
  if (motion === "idle") {
    return settling ? { key: "idle-settle", state: "done", mode: "once" } : null;
  }
  return {
    key: motion,
    state: motion,
    mode: AVATAR_MOTION_TABLE[motion].loop ? "loop" : "once",
  };
}

export function shouldSettle(previous: AvatarMotion, next: AvatarMotion): boolean {
  return isContinuousMotion(previous) && next === "idle";
}

export interface TrackRange {
  readonly inputRange: number[];
  readonly outputRange: number[];
}

export type RangeKind = "absolute" | "difference" | "ratio";

/**
 * Interpolation range for one channel of a track. A lead track is absolute.
 * A loop track is relative to its first keyframe so it adds to (difference) or
 * multiplies (ratio) whatever the lead track ended on.
 */
export function trackRange(
  track: AvatarTrack,
  channel: number,
  kind: RangeKind,
  scale = 1,
  map: (value: number) => number = (value) => value,
): TrackRange {
  const row = track.values[channel]!;
  const first = row[0]!;
  const outputRange = row.map((value) => {
    if (kind === "difference") return map(value - first) * scale;
    if (kind === "ratio") return map(value / first) * scale;
    return map(value) * scale;
  });
  return { inputRange: [...track.times], outputRange };
}
