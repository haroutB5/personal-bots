import type { JSX } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

import type { BotAvatarShape } from "@t3tools/contracts";

import type { AvatarMotion } from "../avatarMotion";
import { AvatarFace } from "./AvatarFace";
import { AVATAR_FPS, avatarPoseAt } from "./avatarStates";

/** Canvas side of a single-avatar composition (Root registers it at this size). */
export const AVATAR_COMPOSITION_PX = 200;

// A type alias, not an interface: Remotion needs props assignable to
// Record<string, unknown>, which interfaces are not.
export type BotAvatarCompositionProps = {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly state: AvatarMotion;
  readonly haloColor: string;
  /** Transparent in the app; a theme surface in renders. */
  readonly background: string;
  /** Inset so hops/tilts stay inside the canvas, as a fraction of the side. */
  readonly padding: number;
};

/**
 * One bot avatar in one state. Every value comes from `useCurrentFrame`, so
 * the Studio and renders agree frame for frame.
 */
export function BotAvatarComposition({
  shape,
  color,
  state,
  haloColor,
  background,
  padding,
}: BotAvatarCompositionProps): JSX.Element {
  const frame = useCurrentFrame();
  const pose = avatarPoseAt(state, frame);
  return (
    <AbsoluteFill style={{ background, padding: `${padding * 100}%` }}>
      <AvatarFace
        shape={shape}
        color={color}
        pose={pose}
        haloColor={haloColor}
        cometSeconds={state === "working" ? frame / AVATAR_FPS : undefined}
        sizePx={AVATAR_COMPOSITION_PX * (1 - 2 * padding)}
      />
    </AbsoluteFill>
  );
}
