import { describe, expect, it } from "vite-plus/test";

import { chipPose, chipReducer, freshChipIds, type ChipPhase } from "./chipMotion";

function run(events: ReadonlyArray<Parameters<typeof chipReducer>[1]>): ChipPhase {
  return events.reduce<ChipPhase>((phase, event) => chipReducer(phase, event), "rest");
}

describe("chipReducer", () => {
  it("a press dips the chip", () => {
    expect(run(["pressIn"])).toBe("pressed");
  });

  it("a tap returns to rest before the hold cue arrives", () => {
    expect(run(["pressIn", "pressOut"])).toBe("rest");
  });

  it("the hold cue starts after the pause and a scroll away cancels it", () => {
    expect(run(["pressIn", "cue"])).toBe("holding");
    expect(run(["pressIn", "cue", "pressOut"])).toBe("rest");
  });

  it("the long press pops the chip, and releasing early does not cut the pop short", () => {
    expect(run(["pressIn", "cue", "longPress"])).toBe("held");
    expect(run(["pressIn", "cue", "longPress", "pressOut"])).toBe("held");
  });

  it("the pop settles back to rest", () => {
    expect(run(["pressIn", "cue", "longPress", "settle"])).toBe("rest");
  });

  it("a late cue after the finger lifted does nothing", () => {
    expect(run(["pressIn", "pressOut", "cue"])).toBe("rest");
  });

  it("a settle without a pop does nothing", () => {
    expect(run(["pressIn", "settle"])).toBe("pressed");
  });

  it("a new press during the pop starts a fresh dip", () => {
    expect(run(["pressIn", "cue", "longPress", "pressIn"])).toBe("pressed");
  });
});

describe("chipPose", () => {
  it("rest is full size over the press time", () => {
    expect(chipPose("rest", false)).toEqual({
      scale: 1,
      opacity: 1,
      duration: 80,
      ease: "cssEaseOut",
    });
  });

  it("pressed is 0.96 and 0.8 over 80 ms", () => {
    expect(chipPose("pressed", false)).toEqual({
      scale: 0.96,
      opacity: 0.8,
      duration: 80,
      ease: "cssEaseOut",
    });
  });

  it("holding dips to 0.92 over 350 ms on the slow-start curve", () => {
    expect(chipPose("holding", false)).toEqual({
      scale: 0.92,
      opacity: 0.8,
      duration: 350,
      ease: "in",
    });
  });

  it("held pops to 1.04 over 120 ms", () => {
    expect(chipPose("held", false)).toEqual({
      scale: 1.04,
      opacity: 0.8,
      duration: 120,
      ease: "cssEaseOut",
    });
  });

  it("reduced motion never changes size or opacity and takes no time", () => {
    for (const phase of ["rest", "pressed", "holding", "held"] as const) {
      expect(chipPose(phase, true)).toEqual({
        scale: 1,
        opacity: 1,
        duration: 0,
        ease: "cssEaseOut",
      });
    }
  });
});

describe("freshChipIds", () => {
  it("the first paint has no fresh chips", () => {
    expect(freshChipIds(null, ["a", "b"])).toEqual(new Set());
  });

  it("a chip added after the first paint is fresh", () => {
    expect(freshChipIds(new Set(["a", "b"]), ["a", "b", "c"])).toEqual(new Set(["c"]));
  });

  it("a chip that was already shown is not fresh again", () => {
    expect(freshChipIds(new Set(["a", "b"]), ["b", "a"])).toEqual(new Set());
  });
});
