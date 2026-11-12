import { motionDuration, motionEase } from "@hbots/personal-client/motion/motionTokens";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { PropsWithChildren } from "react";
import { Animated, Easing, Pressable } from "react-native";
import type { LayoutChangeEvent, StyleProp, ViewStyle } from "react-native";

import { chipPose, chipReducer } from "./chipMotion";
import { useReducedMotion } from "../motion/useReducedMotion";
import { tokens } from "../shell/tokens";

const LONG_PRESS_MS = 350;

export function ChipPill({
  current,
  fresh,
  style,
  currentStyle,
  onLayout,
  onPress,
  onLongPress,
  children,
}: PropsWithChildren<{
  readonly current: boolean;
  readonly fresh: boolean;
  readonly style: StyleProp<ViewStyle>;
  readonly currentStyle: StyleProp<ViewStyle>;
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}>) {
  const reduced = useReducedMotion();
  const [phase, dispatch] = useReducer(chipReducer, "rest");
  const [enters] = useState(fresh);
  const plays = enters && !reduced;
  const [enter] = useState(() => new Animated.Value(plays ? 0 : 1));
  const [pose] = useState(() => ({
    scale: new Animated.Value(1),
    opacity: new Animated.Value(1),
  }));
  const cueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (cueTimer.current !== null) clearTimeout(cueTimer.current);
    if (heldTimer.current !== null) clearTimeout(heldTimer.current);
    cueTimer.current = null;
    heldTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!plays) {
      enter.setValue(1);
      return;
    }
    let started: Animated.CompositeAnimation | null = null;
    const frame = requestAnimationFrame(() => {
      started = Animated.timing(enter, {
        toValue: 1,
        duration: motionDuration.chipIn,
        easing: Easing.bezier(...motionEase.cssEaseOut),
        useNativeDriver: true,
      });
      started.start();
    });
    return () => {
      cancelAnimationFrame(frame);
      started?.stop();
      enter.setValue(1);
    };
  }, [enter, plays]);

  useEffect(() => {
    const target = chipPose(phase, reduced);
    const [x1, y1, x2, y2] = motionEase[target.ease];
    const easing = Easing.bezier(x1, y1, x2, y2);
    if (target.duration === 0) {
      pose.scale.setValue(target.scale);
      pose.opacity.setValue(target.opacity);
      return;
    }
    const animation = Animated.parallel([
      Animated.timing(pose.scale, {
        toValue: target.scale,
        duration: target.duration,
        easing,
        useNativeDriver: true,
      }),
      Animated.timing(pose.opacity, {
        toValue: target.opacity,
        duration: target.duration,
        easing,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [phase, pose, reduced]);

  const shaded = !current && (phase === "holding" || phase === "held");

  return (
    <Pressable
      onLayout={onLayout}
      onPress={onPress}
      onPressIn={() => {
        clearTimers();
        dispatch("pressIn");
        cueTimer.current = setTimeout(() => dispatch("cue"), motionDuration.chipHoldDelay);
      }}
      onPressOut={() => {
        if (cueTimer.current !== null) clearTimeout(cueTimer.current);
        cueTimer.current = null;
        dispatch("pressOut");
      }}
      onLongPress={() => {
        dispatch("longPress");
        onLongPress();
        heldTimer.current = setTimeout(() => dispatch("settle"), motionDuration.chipHeld);
      }}
      delayLongPress={LONG_PRESS_MS}
      accessibilityRole="tab"
      accessibilityState={{ selected: current }}
    >
      <Animated.View
        style={[
          style,
          current ? currentStyle : null,
          shaded ? { backgroundColor: tokens.border } : null,
          {
            opacity: Animated.multiply(enter, pose.opacity),
            transform: [
              {
                scale: Animated.multiply(
                  enter.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
                  pose.scale,
                ),
              },
            ],
          },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
