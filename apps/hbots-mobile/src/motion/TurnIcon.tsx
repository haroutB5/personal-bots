import { motionDuration, motionEase } from "@hbots/personal-client/motion/motionTokens";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Animated, Easing } from "react-native";

import { useReducedMotion } from "./useReducedMotion";

/**
 * Turns its icon by `degrees` when `turned` is true, over 150 ms, instead of
 * swapping two icons. It starts in the right pose, and under reduced motion it
 * jumps to it.
 */
export function TurnIcon({
  turned,
  degrees,
  children,
}: PropsWithChildren<{ readonly turned: boolean; readonly degrees: number }>) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(turned ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      progress.setValue(turned ? 1 : 0);
      return;
    }
    const [x1, y1, x2, y2] = motionEase.inOut;
    const animation = Animated.timing(progress, {
      toValue: turned ? 1 : 0,
      duration: motionDuration.chevron,
      easing: Easing.bezier(x1, y1, x2, y2),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduced, turned]);

  return (
    <Animated.View
      style={{
        transform: [
          {
            rotate: progress.interpolate({
              inputRange: [0, 1],
              outputRange: ["0deg", `${degrees}deg`],
            }),
          },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}
