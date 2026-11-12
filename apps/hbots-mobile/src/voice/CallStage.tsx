import { motionDuration, motionRing } from "@hbots/personal-client/motion/motionTokens";
import { liftForContrast } from "@hbots/personal-client/conversation/voice/callState";
import type { BotAvatarShape } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { useReducedMotion } from "../motion/useReducedMotion";
import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";

const STAGE_SIZE = 196;

export function CallStage({
  shape,
  color,
  label,
  speaking,
  live,
  readLevel,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly label: string;
  readonly speaking: boolean;
  readonly live: boolean;
  readonly readLevel: () => number;
}) {
  const [ring] = useState(() => new Animated.Value(0));
  const [pulse] = useState(() => new Animated.Value(0));
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!live || reduced) {
      ring.setValue(0);
      return;
    }
    let frame = 0;
    let level = 0;
    const step = () => {
      const next = readLevel();
      level += (next - level) * (next > level ? 0.28 : 0.075);
      ring.setValue(level);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [live, reduced, readLevel, ring]);

  useEffect(() => {
    if (live || reduced) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: motionDuration.callRing / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: motionDuration.callRing / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [live, reduced, pulse]);

  const ringColour = speaking ? liftForContrast(color, tokens.bg, 3) : tokens.textSecondary;
  const ringScale = live
    ? ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] })
    : pulse.interpolate({ inputRange: [0, 1], outputRange: [1, motionRing.scale] });
  const pulseOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [motionRing.opacityLow, motionRing.opacityHigh],
  });
  const glowOpacity = live
    ? ring.interpolate({ inputRange: [0, 1], outputRange: [0.08, 0.4] })
    : 0.08;
  const glowScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.32] });

  return (
    <View style={styles.stage} accessibilityElementsHidden importantForAccessibility="no">
      <Animated.View
        style={[
          styles.glow,
          { backgroundColor: ringColour, opacity: glowOpacity, transform: [{ scale: glowScale }] },
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          {
            borderColor: ringColour,
            opacity: live ? 1 : pulseOpacity,
            transform: [{ scale: ringScale }],
          },
        ]}
      />
      <BotAvatar shape={shape} color={color} size={128} label={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    width: STAGE_SIZE,
    height: STAGE_SIZE,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  glow: {
    position: "absolute",
    width: STAGE_SIZE - 44,
    height: STAGE_SIZE - 44,
    borderRadius: STAGE_SIZE,
  },
  ring: {
    position: "absolute",
    width: STAGE_SIZE - 32,
    height: STAGE_SIZE - 32,
    borderRadius: STAGE_SIZE,
    borderWidth: 3,
  },
});
