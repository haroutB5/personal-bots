import { useRef, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";

const ACTION_WIDTH = 96;

/**
 * Swipe left to reveal one destructive action. The row follows the finger,
 * snaps open past half the action width, and closes on a tap or a right swipe.
 * A vertical drag still scrolls the list: the pan only claims mostly-horizontal
 * movement.
 */
export function SwipeToDeleteRow({
  children,
  label,
  onDelete,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onDelete: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef(false);

  const settle = (open: boolean) => {
    openRef.current = open;
    Animated.spring(translateX, {
      toValue: open ? -ACTION_WIDTH : 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 24,
    }).start();
  };

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2,
      onPanResponderMove: (_event, gesture) => {
        const base = openRef.current ? -ACTION_WIDTH : 0;
        const next = Math.max(-ACTION_WIDTH, Math.min(0, base + gesture.dx));
        translateX.setValue(next);
      },
      onPanResponderRelease: (_event, gesture) => {
        const base = openRef.current ? -ACTION_WIDTH : 0;
        settle(base + gesture.dx < -ACTION_WIDTH * 0.45);
      },
      onPanResponderTerminate: () => settle(openRef.current),
    }),
  ).current;

  return (
    <View style={styles.root}>
      <View style={styles.actionLayer}>
        <Pressable
          onPress={() => {
            settle(false);
            onDelete();
          }}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={styles.deleteButton}
        >
          <Text style={styles.deleteText} maxFontSizeMultiplier={1.3}>
            Delete
          </Text>
        </Pressable>
      </View>
      <Animated.View
        style={{ backgroundColor: tokens.bg, transform: [{ translateX }] }}
        {...responder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: "relative", overflow: "hidden", backgroundColor: tokens.dangerBg },
  actionLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  deleteButton: {
    width: ACTION_WIDTH,
    height: "100%",
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.dangerBg,
  },
  deleteText: { color: tokens.danger, fontSize: 15, fontWeight: "600" },
});
