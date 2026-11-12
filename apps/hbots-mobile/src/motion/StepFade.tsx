import { motionDuration, motionEase } from "@hbots/personal-client/motion/motionTokens";
import { useEffect, useState } from "react";
import type { PropsWithChildren } from "react";
import { Animated, Easing } from "react-native";

import { useReducedMotion } from "./useReducedMotion";

/** Fades its children in over 120 ms when they appear. Under reduced motion they are simply there. */
export function StepFade({ children }: PropsWithChildren) {
  const reduced = useReducedMotion();
  const [opacity] = useState(() => new Animated.Value(reduced ? 1 : 0));

  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    const [x1, y1, x2, y2] = motionEase.cssEaseOut;
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: motionDuration.stepFade,
      easing: Easing.bezier(x1, y1, x2, y2),
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
      opacity.setValue(1);
    };
  }, [opacity, reduced]);

  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}
