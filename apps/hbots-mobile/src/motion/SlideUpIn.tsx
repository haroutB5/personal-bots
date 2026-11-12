import { motionDuration, motionEase } from "@hbots/personal-client/motion/motionTokens";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Animated, Easing, StyleSheet, useWindowDimensions } from "react-native";

import { useReducedMotion } from "./useReducedMotion";

export function SlideUpIn({ children }: PropsWithChildren) {
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      progress.stopAnimation();
      progress.setValue(1);
      return;
    }
    const run = Animated.timing(progress, {
      toValue: 1,
      duration: motionDuration.callIn,
      easing: Easing.bezier(...motionEase.push),
      useNativeDriver: true,
    });
    run.start();
    return () => {
      run.stop();
      progress.setValue(1);
    };
  }, [reduced, progress]);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
