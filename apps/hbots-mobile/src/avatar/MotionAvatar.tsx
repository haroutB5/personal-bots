import {
  AVATAR_MOTION_TABLE,
  type AvatarLayerTracks,
  type AvatarTrack,
} from "@hbots/personal-client/bots/avatarMotionTable.generated";
import {
  BOT_AVATAR_EYE_COLOR,
  BOT_AVATAR_EYE_HEIGHT,
  BOT_AVATAR_EYE_TILT_DEG,
  BOT_AVATAR_EYE_WIDTH,
  BOT_AVATAR_EYES,
  botAvatarHappyArcPath,
  BOT_AVATAR_VIEWBOX,
} from "@hbots/personal-client/bots/botAvatarShapes";
import type { BotAvatarShape } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet } from "react-native";
import Svg, { G, Path } from "react-native-svg";

import { BotAvatarArt } from "../shell/BotAvatarArt";
import { trackRange, type AvatarPlayback, type RangeKind } from "./avatarPlan";

type Interpolation = Animated.AnimatedInterpolation<number | string>;

interface LayerDrive {
  readonly lead: Animated.Value;
  readonly loop: Animated.Value;
}

function useLayerDrive(): LayerDrive {
  const [drive] = useState(() => ({ lead: new Animated.Value(0), loop: new Animated.Value(0) }));
  return drive;
}

function layerAnimation(
  drive: LayerDrive,
  tracks: AvatarLayerTracks,
  introSeconds: number,
  repeats: boolean,
): Animated.CompositeAnimation | null {
  const steps: Animated.CompositeAnimation[] = [];
  if (tracks.lead !== null) {
    steps.push(
      Animated.timing(drive.lead, {
        toValue: 1,
        duration: tracks.lead.seconds * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
  } else if (repeats && tracks.loop !== null) {
    steps.push(Animated.delay(introSeconds * 1000));
  }
  if (repeats && tracks.loop !== null) {
    steps.push(
      Animated.loop(
        Animated.timing(drive.loop, {
          toValue: 1,
          duration: tracks.loop.seconds * 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ),
    );
  }
  return steps.length === 0 ? null : Animated.sequence(steps);
}

function channel(
  drive: LayerDrive,
  tracks: AvatarLayerTracks,
  index: number,
  loopKind: Exclude<RangeKind, "absolute">,
  scale: number,
  asDegrees = false,
): readonly Interpolation[] {
  const make = (value: Animated.Value, track: AvatarTrack, kind: RangeKind): Interpolation => {
    const range = trackRange(track, index, kind, kind === "ratio" ? 1 : scale);
    return asDegrees
      ? value.interpolate({
          inputRange: range.inputRange,
          outputRange: range.outputRange.map(degrees),
        })
      : value.interpolate(range);
  };
  const nodes: Interpolation[] = [];
  if (tracks.lead !== null) nodes.push(make(drive.lead, tracks.lead, "absolute"));
  if (tracks.loop !== null) nodes.push(make(drive.loop, tracks.loop, loopKind));
  return nodes;
}

function happyRange(track: AvatarTrack, map?: (value: number) => number) {
  return trackRange(track, 4, "absolute", 1, map);
}

const degrees = (value: number): string => `${value}deg`;

/**
 * One state of the motion table on native-driver transforms and opacity. The body moves the
 * silhouette and eyes together, the eyes move inside it. Mount it keyed by playback: it starts at
 * rest and runs until it unmounts.
 */
export function MotionAvatar({
  shape,
  color,
  size,
  playback,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly size: number;
  readonly playback: AvatarPlayback;
}) {
  const tracks = AVATAR_MOTION_TABLE[playback.state];
  const body = useLayerDrive();
  const eyes = useLayerDrive();
  const repeats = playback.mode === "loop";
  const unit = size / 100;

  useEffect(() => {
    const introSeconds = tracks.body.lead?.seconds ?? tracks.eyes.lead?.seconds ?? 0;
    const running = [
      layerAnimation(body, tracks.body, introSeconds, repeats),
      layerAnimation(eyes, tracks.eyes, introSeconds, repeats),
    ].filter((animation) => animation !== null);
    for (const animation of running) animation.start();
    return () => {
      for (const animation of running) animation.stop();
    };
  }, [body, eyes, repeats, tracks]);

  const bodyTransform = [
    ...channel(body, tracks.body, 0, "difference", unit).map((translateX) => ({ translateX })),
    ...channel(body, tracks.body, 1, "difference", unit).map((translateY) => ({ translateY })),
    ...channel(body, tracks.body, 2, "difference", 1, true).map((rotate) => ({ rotate })),
    ...channel(body, tracks.body, 3, "ratio", 1).map((scaleX) => ({ scaleX })),
    ...channel(body, tracks.body, 4, "ratio", 1).map((scaleY) => ({ scaleY })),
  ];
  const gazeTransform = [
    ...channel(eyes, tracks.eyes, 0, "difference", unit).map((translateX) => ({ translateX })),
    ...channel(eyes, tracks.eyes, 1, "difference", unit).map((translateY) => ({ translateY })),
  ];
  const pillScale = [
    ...channel(eyes, tracks.eyes, 2, "ratio", 1).map((scaleX) => ({ scaleX })),
    ...channel(eyes, tracks.eyes, 3, "ratio", 1).map((scaleY) => ({ scaleY })),
  ];
  const happy = tracks.eyes.lead;
  const pillOpacity =
    happy === null ? undefined : eyes.lead.interpolate(happyRange(happy, (value) => 1 - value));
  const arcOpacity = happy === null ? undefined : eyes.lead.interpolate(happyRange(happy));
  const shapeEyes = BOT_AVATAR_EYES[shape];
  const hasArc = tracks.eyes.lead?.values[4]?.some((value) => value > 0.001) === true;
  const pillWidth = BOT_AVATAR_EYE_WIDTH * unit;
  const pillHeight = BOT_AVATAR_EYE_HEIGHT * unit;

  return (
    <Animated.View style={[styles.layer, { width: size, height: size, transform: bodyTransform }]}>
      <BotAvatarArt shape={shape} color={color} size={size} withEyes={false} />
      <Animated.View style={[styles.layer, { transform: gazeTransform }]}>
        {shapeEyes.map((eye) => (
          <Animated.View
            key={`${eye.cx}-${eye.cy}`}
            style={{
              position: "absolute",
              left: (eye.cx - BOT_AVATAR_EYE_WIDTH / 2) * unit,
              top: (eye.cy - BOT_AVATAR_EYE_HEIGHT / 2) * unit,
              width: pillWidth,
              height: pillHeight,
              borderRadius: pillWidth / 2,
              backgroundColor: BOT_AVATAR_EYE_COLOR,
              opacity: pillOpacity,
              transform: [{ rotate: degrees(BOT_AVATAR_EYE_TILT_DEG) }, ...pillScale],
            }}
          />
        ))}
        {hasArc ? (
          <Animated.View style={[styles.layer, { opacity: arcOpacity }]}>
            <Svg width={size} height={size} viewBox={BOT_AVATAR_VIEWBOX}>
              {shapeEyes.map((eye) => (
                <G
                  key={`${eye.cx}-${eye.cy}`}
                  rotation={BOT_AVATAR_EYE_TILT_DEG}
                  origin={`${eye.cx}, ${eye.cy}`}
                >
                  <Path
                    d={botAvatarHappyArcPath(eye.cx, eye.cy)}
                    fill="none"
                    stroke={BOT_AVATAR_EYE_COLOR}
                    strokeWidth={5}
                    strokeLinecap="round"
                  />
                </G>
              ))}
            </Svg>
          </Animated.View>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 },
});
