import type { AvatarMotion } from "@hbots/personal-client/bots/avatarMotionState";
import { pulseRuns } from "../motion/pulseGate";
import { useAppState } from "../motion/useAppState";
import { useReducedMotion } from "../motion/useReducedMotion";
import { BotAvatarArt } from "../shell/BotAvatarArt";
import { useIsFocused } from "@react-navigation/native";
import type { BotAvatarShape } from "@t3tools/contracts";
import { useState } from "react";

import { playbackFor, shouldSettle } from "./avatarPlan";
import { MotionAvatar } from "./MotionAvatar";

/**
 * The avatar for one motion state. It plays only while its screen is in front,
 * the app is active and reduced motion is off. Otherwise it is the static
 * drawing and nothing is scheduled.
 */
export function LiveAvatarFace({
  shape,
  color,
  size,
  motion,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly size: number;
  readonly motion: AvatarMotion;
}) {
  const reduced = useReducedMotion();
  const focused = useIsFocused();
  const appState = useAppState();
  const runs = pulseRuns({ focused, appState, reduced });
  const [previous, setPrevious] = useState(motion);
  const [settling, setSettling] = useState(false);
  if (motion !== previous) {
    setPrevious(motion);
    setSettling(shouldSettle(previous, motion));
  } else if (!runs && settling) {
    setSettling(false);
  }
  const playback = playbackFor(motion, runs, settling);
  if (playback === null) {
    return <BotAvatarArt shape={shape} color={color} size={size} withEyes />;
  }
  return (
    <MotionAvatar key={playback.key} shape={shape} color={color} size={size} playback={playback} />
  );
}
