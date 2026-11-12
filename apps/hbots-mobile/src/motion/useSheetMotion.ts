import {
  motionDuration,
  motionEase,
  motionSheet,
} from "@hbots/personal-client/motion/motionTokens";
import { useLayoutEffect, useRef, useState } from "react";
import { Animated, Easing } from "react-native";

import { createSheetPresence, type SheetPresence } from "./sheetPresence";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Drives a bottom sheet's enter and exit on the native driver. `mounted` is
 * what to hand the Modal: it stays true until the close motion is done.
 * `closing` marks that motion.
 */
export function useSheetMotion(visible: boolean): {
  readonly mounted: boolean;
  readonly closing: boolean;
  readonly backdropStyle: { readonly opacity: Animated.Value };
  readonly panelStyle: {
    readonly opacity: Animated.Value;
    readonly transform: readonly [{ readonly translateY: Animated.AnimatedInterpolation<number> }];
  };
} {
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const [progress] = useState(() => new Animated.Value(0));
  const [presence] = useState<SheetPresence>(() =>
    createSheetPresence(
      {
        animateTo: (target, done) => {
          Animated.timing(progress, {
            toValue: target,
            duration: motionDuration.sheet,
            easing: Easing.bezier(...motionEase.inOut),
            useNativeDriver: true,
          }).start(({ finished }) => done(finished));
        },
        snapTo: (target) => {
          progress.stopAnimation();
          progress.setValue(target);
        },
      },
      setMounted,
    ),
  );

  useLayoutEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  useLayoutEffect(() => {
    if (visible) presence.show(reducedRef.current);
    else presence.hide(reducedRef.current);
  }, [visible, presence]);

  const closing = mounted && !visible;

  return {
    mounted,
    closing,
    backdropStyle: { opacity: progress },
    panelStyle: {
      opacity: progress,
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [motionSheet.translateY, 0],
          }),
        },
      ],
    },
  };
}
