import {
  motionDuration,
  motionEase,
  motionPulse,
} from "@hbots/personal-client/motion/motionTokens";
import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { AppState, Animated, Easing } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { pulseRuns } from "./pulseGate";
import { useReducedMotion } from "./useReducedMotion";

function useAppState(): string {
  const [state, setState] = useState(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", setState);
    return () => subscription.remove();
  }, []);
  return state;
}

/**
 * A dot that breathes between full and half opacity every 2 s while its screen
 * is in front and the app is in the foreground. Otherwise it holds full
 * opacity and nothing is scheduled.
 */
export function PulseDot({ style }: { readonly style: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const focused = useIsFocused();
  const appState = useAppState();
  const runs = pulseRuns({ focused, appState, reduced });
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!runs) {
      opacity.setValue(1);
      return;
    }
    const [x1, y1, x2, y2] = motionEase.pulse;
    const easing = Easing.bezier(x1, y1, x2, y2);
    const half = motionDuration.pulse / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: motionPulse.low,
          duration: half,
          easing,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, { toValue: 1, duration: half, easing, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      opacity.setValue(1);
    };
  }, [opacity, runs]);

  return <Animated.View style={[style, { opacity }]} />;
}
