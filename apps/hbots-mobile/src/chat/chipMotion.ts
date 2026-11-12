import { motionDuration, motionPress } from "@hbots/personal-client/motion/motionTokens";

export type ChipPhase = "rest" | "pressed" | "holding" | "held";

export type ChipEvent = "pressIn" | "pressOut" | "cue" | "longPress" | "settle";

export function chipReducer(phase: ChipPhase, event: ChipEvent): ChipPhase {
  switch (event) {
    case "pressIn":
      return "pressed";
    case "pressOut":
      return phase === "held" ? "held" : "rest";
    case "cue":
      return phase === "pressed" ? "holding" : phase;
    case "longPress":
      return phase === "pressed" || phase === "holding" ? "held" : phase;
    case "settle":
      return phase === "held" ? "rest" : phase;
  }
}

export interface ChipPose {
  readonly scale: number;
  readonly opacity: number;
  readonly duration: number;
  readonly ease: "cssEaseOut" | "in";
}

const STILL: ChipPose = { scale: 1, opacity: 1, duration: 0, ease: "cssEaseOut" };

export function chipPose(phase: ChipPhase, reduced: boolean): ChipPose {
  if (reduced) return STILL;
  switch (phase) {
    case "rest":
      return { scale: 1, opacity: 1, duration: motionDuration.press, ease: "cssEaseOut" };
    case "pressed":
      return {
        scale: motionPress.chip,
        opacity: 0.8,
        duration: motionDuration.press,
        ease: "cssEaseOut",
      };
    case "holding":
      return {
        scale: motionPress.chipHold,
        opacity: 0.8,
        duration: motionDuration.chipHold,
        ease: "in",
      };
    case "held":
      return {
        scale: motionPress.chipHeld,
        opacity: 0.8,
        duration: motionDuration.chipHeld,
        ease: "cssEaseOut",
      };
  }
}

export function freshChipIds(
  known: ReadonlySet<string> | null,
  ids: ReadonlyArray<string>,
): ReadonlySet<string> {
  if (known === null) return new Set();
  return new Set(ids.filter((id) => !known.has(id)));
}
