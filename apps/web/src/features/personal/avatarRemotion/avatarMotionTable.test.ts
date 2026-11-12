// @effect-diagnostics-next-line nodeBuiltinImport:off - reads the checked-in generated table off disk.
import * as NodeFS from "node:fs";

import {
  AVATAR_MOTION_TABLE,
  type AvatarTrack,
} from "@hbots/personal-client/bots/avatarMotionTable.generated";
import { describe, expect, it } from "vite-plus/test";

import {
  AVATAR_TABLE_STATES,
  avatarMotionTableSource,
  pivotedTranslate,
} from "./avatarMotionTable";
import { avatarPoseAtTime, avatarStateTiming } from "./avatarStates";
import { AVATAR_BODY_PIVOT_X, AVATAR_BODY_PIVOT_Y, REST_POSE, type AvatarPose } from "./pose";

const tableUrl = new URL(
  "../../../../../../packages/personal-client/src/bots/avatarMotionTable.generated.ts",
  import.meta.url,
);

function valueAt(track: AvatarTrack, channel: number, progress: number): number {
  const { times } = track;
  const row = track.values[channel]!;
  if (progress <= times[0]!) return row[0]!;
  for (let index = 1; index < times.length; index += 1) {
    if (progress <= times[index]!) {
      const span = times[index]! - times[index - 1]!;
      const t = span === 0 ? 1 : (progress - times[index - 1]!) / span;
      return row[index - 1]! + (row[index]! - row[index - 1]!) * t;
    }
  }
  return row[row.length - 1]!;
}

function bodyChannels(pose: AvatarPose): number[] {
  return [...pivotedTranslate(pose), pose.bodyRotate, pose.bodyScaleX, pose.bodyScaleY];
}

const POSE: AvatarPose = {
  ...REST_POSE,
  bodyX: 3,
  bodyY: -2,
  bodyRotate: 14,
  bodyScaleX: 1.06,
  bodyScaleY: 0.94,
};

function apply(
  pose: AvatarPose,
  origin: readonly [number, number],
  translate: readonly [number, number],
  point: readonly [number, number],
): [number, number] {
  const angle = (pose.bodyRotate * Math.PI) / 180;
  const x = (point[0] - origin[0]) * pose.bodyScaleX;
  const y = (point[1] - origin[1]) * pose.bodyScaleY;
  return [
    origin[0] + translate[0] + x * Math.cos(angle) - y * Math.sin(angle),
    origin[1] + translate[1] + x * Math.sin(angle) + y * Math.cos(angle),
  ];
}

describe("avatarMotionTable.generated.ts", () => {
  it("matches the motion module byte for byte (run scripts/generate-avatar-motion-table.ts)", () => {
    expect(NodeFS.readFileSync(tableUrl, "utf8")).toBe(avatarMotionTableSource());
  });

  it("has every non-idle state, looping only thinking and working", () => {
    expect(Object.keys(AVATAR_MOTION_TABLE).toSorted()).toEqual(
      [...AVATAR_TABLE_STATES].toSorted(),
    );
    for (const state of AVATAR_TABLE_STATES) {
      expect(AVATAR_MOTION_TABLE[state].loop).toBe(avatarStateTiming(state).loop);
    }
    expect(AVATAR_TABLE_STATES.filter((state) => AVATAR_MOTION_TABLE[state].loop)).toEqual([
      "thinking",
      "working",
    ]);
  });

  it("keeps every track well formed: times rise from 0 to 1, one value per time", () => {
    for (const state of AVATAR_TABLE_STATES) {
      for (const layer of [AVATAR_MOTION_TABLE[state].body, AVATAR_MOTION_TABLE[state].eyes]) {
        for (const track of [layer.lead, layer.loop]) {
          if (track === null) continue;
          expect(track.times[0]).toBe(0);
          expect(track.times[track.times.length - 1]).toBe(1);
          expect(track.times.every((time, i) => i === 0 || time >= track.times[i - 1]!)).toBe(true);
          expect(track.values).toHaveLength(5);
          for (const row of track.values) expect(row).toHaveLength(track.times.length);
        }
      }
    }
  });

  it("gives loops a spring-in and a steady track on the authored periods, one-shots only a lead", () => {
    for (const state of AVATAR_TABLE_STATES) {
      const timing = avatarStateTiming(state);
      const { body, eyes } = AVATAR_MOTION_TABLE[state];
      if (timing.loop) {
        expect(body.lead?.seconds).toBe(timing.introSeconds);
        expect(body.loop?.seconds).toBe(timing.bodySeconds);
        expect(eyes.lead?.seconds).toBe(timing.introSeconds);
        expect(eyes.loop?.seconds).toBe(timing.eyeSeconds);
      } else {
        expect(body.loop).toBeNull();
        expect(eyes.loop).toBeNull();
        expect(body.lead?.seconds ?? timing.seconds).toBe(timing.seconds);
      }
    }
  });

  it("reproduces the authored poses at sampled times", () => {
    for (const state of AVATAR_TABLE_STATES) {
      const timing = avatarStateTiming(state);
      const { body, eyes } = AVATAR_MOTION_TABLE[state];
      const pairs: ReadonlyArray<
        readonly [AvatarTrack | null, number, (p: AvatarPose) => number[]]
      > = timing.loop
        ? [
            [body.lead, 0, bodyChannels],
            [body.loop, timing.introSeconds, bodyChannels],
            [eyes.lead, 0, eyeChannels],
            [eyes.loop, timing.introSeconds, eyeChannels],
          ]
        : [
            [body.lead, 0, bodyChannels],
            [eyes.lead, 0, eyeChannels],
          ];
      for (const [track, from, channels] of pairs) {
        if (track === null) continue;
        for (const progress of [0, 0.13, 0.37, 0.5, 0.71, 0.93, 1]) {
          const expected = channels(avatarPoseAtTime(state, from + track.seconds * progress));
          expected.forEach((want, channel) => {
            expect(Math.abs(valueAt(track, channel, progress) - want)).toBeLessThan(0.1);
          });
        }
      }
    }
  });

  it("lands done on rest, so holding its last frame is the rest pose", () => {
    const rest = bodyChannels(REST_POSE);
    const lead = AVATAR_MOTION_TABLE.done.body.lead;
    expect(lead).not.toBeNull();
    lead!.values.forEach((row, channel) => {
      expect(row[row.length - 1]).toBeCloseTo(rest[channel]!, 2);
    });
  });
});

function eyeChannels(pose: AvatarPose): number[] {
  return [pose.gazeX, pose.gazeY, pose.eyeWiden, pose.eyeOpen, pose.happy];
}

describe("pivotedTranslate", () => {
  it("is zero at rest", () => {
    expect(pivotedTranslate(REST_POSE)).toEqual([0, 0]);
  });

  it("puts a point where the pose about the head centre puts it, when turning about the box centre", () => {
    for (const point of [
      [50, 52],
      [20, 30],
      [78, 71],
    ] as const) {
      const about = apply(
        POSE,
        [AVATAR_BODY_PIVOT_X, AVATAR_BODY_PIVOT_Y],
        [POSE.bodyX, POSE.bodyY],
        point,
      );
      const centred = apply(POSE, [50, 50], pivotedTranslate(POSE), point);
      expect(centred[0]).toBeCloseTo(about[0], 6);
      expect(centred[1]).toBeCloseTo(about[1], 6);
    }
  });
});
