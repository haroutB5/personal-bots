import {
  AVATAR_MOTION_TABLE,
  type AvatarTrack,
} from "@hbots/personal-client/bots/avatarMotionTable.generated";
import { describe, expect, it } from "vite-plus/test";

import { playbackFor, shouldSettle, trackRange } from "./avatarPlan";

const track: AvatarTrack = {
  seconds: 2,
  times: [0, 0.5, 1],
  values: [
    [1, 2, 3],
    [10, 20, 30],
  ],
};

describe("playbackFor", () => {
  it("shows the static avatar when nothing runs", () => {
    expect(playbackFor("working", false, false)).toBeNull();
    expect(playbackFor("done", false, true)).toBeNull();
  });

  it("shows the static avatar for an idle bot", () => {
    expect(playbackFor("idle", true, false)).toBeNull();
  });

  it("loops thinking and working", () => {
    expect(playbackFor("thinking", true, false)).toEqual({
      key: "thinking",
      state: "thinking",
      mode: "loop",
    });
    expect(playbackFor("working", true, false)?.mode).toBe("loop");
  });

  it("plays waiting, blocked and done once", () => {
    expect(playbackFor("waiting", true, false)?.mode).toBe("once");
    expect(playbackFor("blocked", true, false)?.mode).toBe("once");
    expect(playbackFor("done", true, false)?.mode).toBe("once");
  });

  it("lands an idle bot on rest through the done hop while settling", () => {
    expect(playbackFor("idle", true, true)).toEqual({
      key: "idle-settle",
      state: "done",
      mode: "once",
    });
  });
});

describe("shouldSettle", () => {
  it("hops to rest when a loop stops, and only then", () => {
    expect(shouldSettle("working", "idle")).toBe(true);
    expect(shouldSettle("thinking", "idle")).toBe(true);
    expect(shouldSettle("waiting", "idle")).toBe(false);
    expect(shouldSettle("idle", "working")).toBe(false);
    expect(shouldSettle("working", "waiting")).toBe(false);
  });
});

describe("trackRange", () => {
  it("scales an absolute channel", () => {
    expect(trackRange(track, 0, "absolute", 2)).toEqual({
      inputRange: [0, 0.5, 1],
      outputRange: [2, 4, 6],
    });
  });

  it("measures a channel as a difference from its first keyframe", () => {
    expect(trackRange(track, 1, "difference", 0.1)).toEqual({
      inputRange: [0, 0.5, 1],
      outputRange: [0, 1, 2],
    });
  });

  it("measures a channel as a ratio to its first keyframe", () => {
    expect(trackRange(track, 1, "ratio")).toEqual({
      inputRange: [0, 0.5, 1],
      outputRange: [1, 2, 3],
    });
  });

  it("maps the output after scaling", () => {
    expect(trackRange(track, 0, "absolute", 1, (value) => 1 - value).outputRange).toEqual([
      0, -1, -2,
    ]);
  });
});

describe("the generated table the player relies on", () => {
  it("never changes the happy channel in a loop, so pill opacity needs only the lead track", () => {
    for (const state of Object.values(AVATAR_MOTION_TABLE)) {
      const happy = state.eyes.loop?.values[4] ?? [];
      expect(new Set(happy).size).toBeLessThanOrEqual(1);
    }
  });

  it("starts every track at its first keyframe so a layer begins at rest", () => {
    for (const state of Object.values(AVATAR_MOTION_TABLE)) {
      for (const layer of [state.body, state.eyes]) {
        for (const track of [layer.lead, layer.loop]) {
          if (track !== null) expect(track.times[0]).toBe(0);
        }
      }
    }
  });
});
