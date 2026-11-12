import { motionDuration, motionEase, motionRise } from "@hbots/personal-client/motion/motionTokens";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Animated, Easing } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { useReducedMotion } from "./useReducedMotion";

/**
 * Fades its children in while they rise 8 px, once, on the native driver.
 * Without `enabled`, or under reduced motion, the children are in their
 * final state from the first frame and nothing starts.
 */
export function RiseIn({
  enabled,
  duration = motionDuration.rise,
  style,
  children,
}: PropsWithChildren<{
  readonly enabled: boolean;
  readonly duration?: number;
  readonly style?: StyleProp<ViewStyle>;
}>) {
  const reduced = useReducedMotion();
  const plays = enabled && !reduced;
  const [progress] = useState(() => new Animated.Value(plays ? 0 : 1));

  useEffect(() => {
    if (!plays) {
      progress.stopAnimation();
      progress.setValue(1);
      return;
    }
    let started: Animated.CompositeAnimation | null = null;
    const frame = requestAnimationFrame(() => {
      started = Animated.timing(progress, {
        toValue: 1,
        duration,
        easing: Easing.bezier(...motionEase.cssEaseOut),
        useNativeDriver: true,
      });
      started.start();
    });
    return () => {
      cancelAnimationFrame(frame);
      started?.stop();
      progress.setValue(1);
    };
  }, [plays, progress, duration]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [motionRise.translateY, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
