import type { PersonalPushInAppNotification } from "@t3tools/contracts";
import { motionDuration, motionEase } from "@hbots/personal-client/motion/motionTokens";
import { IconX } from "@tabler/icons-react-native";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, Easing, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BANNER_DRAG_START, dragTo, type BannerDrag } from "../motion/bannerPresence";
import { useReducedMotion } from "../motion/useReducedMotion";
import { BotAvatar } from "./BotAvatar";
import { tokens } from "./tokens";

const HIDDEN_TRAVEL = 1.2;
const DRAG_CAPTURE_PX = 6;
const FIRST_HEIGHT_GUESS = 64;

/**
 * The banner over the Bots screen. It slides down from above its own height
 * and fades in, and the same motion plays backwards when `leaving`. An upward
 * drag follows the finger and dismisses past the threshold. A banner that is
 * leaving lets every touch through.
 */
export function InAppBanner({
  notification,
  leaving,
  onOpen,
  onDismiss,
  onExited,
}: {
  readonly notification: PersonalPushInAppNotification;
  readonly leaving: boolean;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
  readonly onExited: () => void;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const [dragY] = useState(() => new Animated.Value(0));
  const [height, setHeight] = useState(FIRST_HEIGHT_GUESS);
  const drag = useRef<BannerDrag>(BANNER_DRAG_START);
  const latest = useRef({ onDismiss, onExited });
  useLayoutEffect(() => {
    latest.current = { onDismiss, onExited };
  }, [onDismiss, onExited]);

  useEffect(() => {
    drag.current = BANNER_DRAG_START;
    dragY.setValue(0);
    if (reduced) {
      progress.stopAnimation();
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    let started: Animated.CompositeAnimation | null = null;
    const frame = requestAnimationFrame(() => {
      started = Animated.timing(progress, {
        toValue: 1,
        duration: motionDuration.banner,
        easing: Easing.bezier(...motionEase.cssEaseOut),
        useNativeDriver: true,
      });
      started.start();
    });
    return () => {
      cancelAnimationFrame(frame);
      started?.stop();
    };
  }, [reduced, progress, dragY]);

  useEffect(() => {
    if (!leaving) return;
    if (reduced) {
      progress.setValue(0);
      latest.current.onExited();
      return;
    }
    const exit = Animated.timing(progress, {
      toValue: 0,
      duration: motionDuration.banner,
      easing: Easing.bezier(...motionEase.cssEaseOut),
      useNativeDriver: true,
    });
    exit.start(({ finished }) => {
      if (finished) latest.current.onExited();
    });
    return () => exit.stop();
  }, [leaving, reduced, progress]);

  const responder = useRef(
    // eslint-disable-next-line react/refs -- the responder is created once
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        gesture.dy < -DRAG_CAPTURE_PX && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_event, gesture) => {
        drag.current = dragTo(drag.current, gesture.dy);
        dragY.setValue(drag.current.offset);
      },
      onPanResponderRelease: () => {
        if (drag.current.swiped) {
          latest.current.onDismiss();
          return;
        }
        drag.current = BANNER_DRAG_START;
        Animated.timing(dragY, {
          toValue: 0,
          duration: motionDuration.bannerSnap,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }).start();
      },
      onPanResponderTerminate: () => {
        drag.current = BANNER_DRAG_START;
        Animated.timing(dragY, {
          toValue: 0,
          duration: motionDuration.bannerSnap,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const line = notification.preview ?? notification.body;
  const name = notification.title.replace(/ replied$/u, "");
  const enterTravel = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-height * HIDDEN_TRAVEL, 0],
  });

  return (
    <View
      style={[styles.host, { paddingTop: insets.top + 8 }]}
      pointerEvents={leaving ? "none" : "box-none"}
    >
      <Animated.View
        // eslint-disable-next-line react/refs -- pan handlers are stable for the component lifetime
        {...responder.panHandlers}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={[
          styles.banner,
          { opacity: progress, transform: [{ translateY: Animated.add(enterTravel, dragY) }] },
        ]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`${notification.title}. ${line}`}
          style={styles.body}
        >
          {notification.avatarShape !== undefined && notification.avatarColor !== undefined ? (
            <BotAvatar
              shape={notification.avatarShape}
              color={notification.avatarColor}
              size={32}
              label=""
            />
          ) : null}
          <View style={styles.copy}>
            <Text style={styles.title} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.preview} numberOfLines={1}>
              {line}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          style={styles.close}
          hitSlop={8}
        >
          <IconX size={18} color={tokens.textSecondary} strokeWidth={2} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  banner: {
    width: "100%",
    maxWidth: 480,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 4,
    shadowColor: "#000000",
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  body: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  copy: { flex: 1, minWidth: 0 },
  title: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  preview: { color: tokens.textSecondary, fontSize: 13 },
  close: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
});
