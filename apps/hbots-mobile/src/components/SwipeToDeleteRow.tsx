import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";
import {
  armTimedOut,
  CLOSED,
  nextSwipeDelete,
  SWIPE_ARM_TIMEOUT_MS,
  type SwipeDelete,
} from "./swipeDeleteModel";
import { armSwipeRow, disarmSwipeRow, registerSwipeRow, touchSwipeRow } from "./swipeDeleteRows";

const ACTION_WIDTH = 136;

let nextRowId = 1;

/**
 * Swipe left once to arm Delete, again to commit. A tap on Delete always
 * calls `onDelete`, so each screen keeps its own dialog; `onSwipeConfirm`
 * runs instead on the second swipe.
 */
export function SwipeToDeleteRow({
  children,
  label,
  onDelete,
  onSwipeConfirm,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onDelete: () => void;
  readonly onSwipeConfirm?: (() => void) | undefined;
}) {
  // eslint-disable-next-line react/refs -- the animated value is created once
  const translateX = useRef(new Animated.Value(0)).current;
  const stateRef = useRef<SwipeDelete>(CLOSED);
  const [armed, setArmed] = useState(false);
  const [id] = useState(() => `swipe-row-${nextRowId++}`);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armedAt = useRef(0);
  // The responder is created once, so it reads the current callbacks from here.
  const latest = useRef({ onDelete, onSwipeConfirm });
  useEffect(() => {
    latest.current = { onDelete, onSwipeConfirm };
  });

  const clearArmTimer = () => {
    if (armTimer.current !== null) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  const restartArmTimer = () => {
    clearArmTimer();
    armedAt.current = Date.now();
    armTimer.current = setTimeout(() => {
      armTimer.current = null;
      if (stateRef.current.kind === "armed" && armTimedOut(armedAt.current, Date.now())) {
        settleRef.current(CLOSED);
      }
    }, SWIPE_ARM_TIMEOUT_MS);
  };

  const settle = (next: SwipeDelete) => {
    stateRef.current = next;
    const open = next.kind === "armed";
    setArmed(open);
    if (open) {
      armSwipeRow(id);
      restartArmTimer();
    } else {
      clearArmTimer();
      disarmSwipeRow(id);
    }
    Animated.spring(translateX, {
      toValue: open ? -ACTION_WIDTH : 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 24,
    }).start();
  };

  const settleRef = useRef(settle);
  useEffect(() => {
    settleRef.current = settle;
  });
  useEffect(() => registerSwipeRow(id, () => settleRef.current(CLOSED)), [id]);
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current);
    },
    [],
  );

  const responder = useRef(
    // eslint-disable-next-line react/refs -- the responder is created once
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2,
      onPanResponderMove: (_event, gesture) => {
        const base = stateRef.current.kind === "armed" ? -ACTION_WIDTH : 0;
        const next = Math.max(-ACTION_WIDTH * 1.25, Math.min(0, base + gesture.dx));
        translateX.setValue(next);
      },
      onPanResponderRelease: (_event, gesture) => {
        const outcome = nextSwipeDelete(stateRef.current, {
          kind: "swipe",
          distance: gesture.dx,
          threshold: ACTION_WIDTH * 0.4,
        });
        settle(outcome.state);
        if (outcome.effect === "commit") {
          const callback = latest.current.onSwipeConfirm ?? latest.current.onDelete;
          callback();
        }
      },
      onPanResponderTerminate: () => settle(stateRef.current),
    }),
  ).current;

  return (
    <View
      style={styles.root}
      onTouchStart={() => {
        touchSwipeRow(id);
        if (stateRef.current.kind === "armed") restartArmTimer();
      }}
    >
      <View style={styles.actionLayer}>
        <Pressable
          onPress={() => {
            settle(CLOSED);
            onDelete();
          }}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={styles.deleteButton}
        >
          <Text style={styles.deleteText} maxFontSizeMultiplier={1.3}>
            Delete
          </Text>
          {armed ? (
            <Text style={styles.deleteHint} maxFontSizeMultiplier={1.3}>
              Swipe again to delete
            </Text>
          ) : null}
        </Pressable>
      </View>
      <Animated.View
        style={{ backgroundColor: tokens.bg, transform: [{ translateX }] }}
        // eslint-disable-next-line react/refs -- pan handlers are stable for the component lifetime
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
    paddingHorizontal: 8,
  },
  deleteText: { color: tokens.danger, fontSize: 15, fontWeight: "600" },
  deleteHint: {
    color: tokens.textSecondary,
    fontSize: 10,
    lineHeight: 12,
    textAlign: "center",
    marginTop: 2,
  },
});
