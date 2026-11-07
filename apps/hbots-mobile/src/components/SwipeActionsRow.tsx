import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";
import {
  SWIPE_ACTION_WIDTH,
  claimsSwipe,
  dragOffset,
  restOffset,
  settleRest,
  swipeReach,
  type SwipeRest,
} from "./swipeModel";

export interface SwipeAction {
  readonly key: string;
  readonly label: string;
  readonly tone: "neutral" | "accent" | "danger";
  readonly onPress: () => void;
}

/**
 * A row with actions under it. Swiping left reveals the trailing actions,
 * swiping right the leading ones. The row follows the finger, opens past 45%
 * of the actions' width and shuts on a tap, an action or a swipe back. A
 * vertical drag still scrolls the list.
 */
export function SwipeActionsRow({
  children,
  leadingActions,
  trailingActions,
  enabled,
}: {
  readonly children: ReactNode;
  readonly leadingActions: ReadonlyArray<SwipeAction>;
  readonly trailingActions: ReadonlyArray<SwipeAction>;
  readonly enabled: boolean;
}) {
  // eslint-disable-next-line react/refs -- the animated value is created once
  const translateX = useRef(new Animated.Value(0)).current;
  const restRef = useRef<SwipeRest>("closed");
  const [rest, setRest] = useState<SwipeRest>("closed");
  const reach = useMemo(
    () => swipeReach(leadingActions.length, trailingActions.length),
    [leadingActions.length, trailingActions.length],
  );
  const reachRef = useRef(reach);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    reachRef.current = reach;
    enabledRef.current = enabled;
  }, [reach, enabled]);

  const settle = (next: SwipeRest) => {
    restRef.current = next;
    setRest(next);
    Animated.spring(translateX, {
      toValue: restOffset(next, reachRef.current),
      useNativeDriver: true,
      bounciness: 0,
      speed: 24,
    }).start();
  };
  const settleRef = useRef(settle);
  useEffect(() => {
    settleRef.current = settle;
  });

  useEffect(() => {
    if (!enabled && restRef.current !== "closed") settleRef.current("closed");
  }, [enabled]);

  const responder = useMemo(
    () =>
      // eslint-disable-next-line react/refs -- the responder is created once
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          enabledRef.current && claimsSwipe(gesture.dx, gesture.dy),
        onPanResponderMove: (_event, gesture) => {
          translateX.setValue(dragOffset(restRef.current, gesture.dx, reachRef.current));
        },
        onPanResponderRelease: (_event, gesture) => {
          settleRef.current(
            settleRest(dragOffset(restRef.current, gesture.dx, reachRef.current), reachRef.current),
          );
        },
        onPanResponderTerminate: () => settleRef.current(restRef.current),
      }),
    [translateX],
  );

  const run = (action: SwipeAction) => {
    settle("closed");
    action.onPress();
  };

  return (
    <View style={styles.root}>
      <View
        style={[styles.actionLayer, styles.leadingLayer]}
        pointerEvents={rest === "right" ? "auto" : "none"}
      >
        {leadingActions.map((action) => (
          <ActionButton key={action.key} action={action} onPress={() => run(action)} />
        ))}
      </View>
      <View
        style={[styles.actionLayer, styles.trailingLayer]}
        pointerEvents={rest === "left" ? "auto" : "none"}
      >
        {trailingActions.map((action) => (
          <ActionButton key={action.key} action={action} onPress={() => run(action)} />
        ))}
      </View>
      <Animated.View style={styles.row} {...responder.panHandlers}>
        <Animated.View style={{ backgroundColor: tokens.bg, transform: [{ translateX }] }}>
          {children}
          {rest === "closed" ? null : (
            <Pressable
              onPress={() => settle("closed")}
              accessibilityRole="button"
              accessibilityLabel="Close actions"
              style={StyleSheet.absoluteFill}
            />
          )}
        </Animated.View>
      </Animated.View>
    </View>
  );
}

function ActionButton({
  action,
  onPress,
}: {
  readonly action: SwipeAction;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={[styles.action, toneStyle(action.tone)]}
    >
      <Text style={[styles.actionText, toneTextStyle(action.tone)]} maxFontSizeMultiplier={1.3}>
        {action.label}
      </Text>
    </Pressable>
  );
}

function toneStyle(tone: SwipeAction["tone"]) {
  switch (tone) {
    case "neutral":
      return styles.neutral;
    case "accent":
      return styles.accent;
    case "danger":
      return styles.danger;
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

function toneTextStyle(tone: SwipeAction["tone"]) {
  switch (tone) {
    case "neutral":
      return styles.neutralText;
    case "accent":
      return styles.accentText;
    case "danger":
      return styles.dangerText;
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

const styles = StyleSheet.create({
  root: { position: "relative", overflow: "hidden", backgroundColor: tokens.bg },
  row: { backgroundColor: tokens.bg },
  actionLayer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    flexDirection: "row",
  },
  leadingLayer: { left: 0 },
  trailingLayer: { right: 0 },
  action: {
    width: SWIPE_ACTION_WIDTH,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  actionText: { fontSize: 14, fontWeight: "600" },
  neutral: { backgroundColor: tokens.raised },
  neutralText: { color: tokens.text },
  accent: { backgroundColor: tokens.fillMuted },
  accentText: { color: tokens.primary },
  danger: { backgroundColor: tokens.dangerBg },
  dangerText: { color: tokens.danger },
});
