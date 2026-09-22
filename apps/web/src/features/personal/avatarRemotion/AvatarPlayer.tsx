import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";

import type { BotAvatarShape } from "@t3tools/contracts";

import { AvatarFace } from "./AvatarFace";
import { AVATAR_FPS, AVATAR_STATE_SPECS, avatarFinalPose } from "./avatarStates";
import { BotAvatarComposition, type BotAvatarCompositionProps } from "./BotAvatarComposition";
import type { AvatarAnimState } from "./playerMode";

/** Canvas side; the Player scales it to `size`. Matches the Studio compositions. */
const COMPOSITION_SIZE = 200;
/** Halo token resolved by the page's stylesheet (light: transparent). */
const APP_HALO = "var(--personal-avatar-halo)";

export interface AvatarPlayerProps {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly state: Exclude<AvatarAnimState, "idle">;
  readonly size: number;
  readonly loop: boolean;
  /** Fired once when a one-shot finishes. */
  readonly onEnded?: (() => void) | undefined;
}

/**
 * The Remotion half of `AnimatedBotAvatar`, loaded lazily so idle screens never
 * download the Remotion runtime.
 *
 * A one-shot plays once, then this component unmounts its Player and draws the
 * held final pose as a plain SVG: a list full of waiting bots keeps zero live
 * Players. Remount (the wrapper keys it by state) to play again.
 */
export default function AvatarPlayer({
  shape,
  color,
  state,
  size,
  loop,
  onEnded,
}: AvatarPlayerProps): JSX.Element {
  const playerRef = useRef<PlayerRef>(null);
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || loop) return;
    const handleEnded = () => {
      setEnded(true);
      onEnded?.();
    };
    player.addEventListener("ended", handleEnded);
    return () => player.removeEventListener("ended", handleEnded);
  }, [loop, onEnded]);

  if (ended) {
    return (
      <span style={{ display: "block", width: size, height: size }}>
        <AvatarFace
          shape={shape}
          color={color}
          pose={avatarFinalPose(state)}
          haloColor={APP_HALO}
        />
      </span>
    );
  }

  const inputProps: BotAvatarCompositionProps = {
    shape,
    color,
    state,
    haloColor: APP_HALO,
    background: "transparent",
    padding: 0,
  };

  return (
    <Player
      ref={playerRef}
      component={BotAvatarComposition}
      inputProps={inputProps}
      durationInFrames={AVATAR_STATE_SPECS[state].durationInFrames}
      fps={AVATAR_FPS}
      compositionWidth={COMPOSITION_SIZE}
      compositionHeight={COMPOSITION_SIZE}
      style={{ width: size, height: size, background: "transparent" }}
      loop={loop}
      autoPlay
      controls={false}
      clickToPlay={false}
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      moveToBeginningWhenEnded={false}
      numberOfSharedAudioTags={0}
      overflowVisible
      acknowledgeRemotionLicense
    />
  );
}
