import { useCallback, useEffect, useMemo, useRef } from "react";
import type { GestureResponderEvent } from "react-native";

import {
  LONG_PRESS_IDLE,
  LONG_PRESS_MS,
  longPressStep,
  type LongPressEvent,
  type LongPressState,
} from "./longPressModel";

export interface LongPressTouchProps {
  readonly onTouchStart: (event: GestureResponderEvent) => void;
  readonly onTouchMove: (event: GestureResponderEvent) => void;
  readonly onTouchEnd: () => void;
  readonly onTouchCancel: () => void;
}

export interface LongPress {
  readonly touchProps: LongPressTouchProps;
  /** True once after a hold fired, so the tap that ends it does not also open the chat. */
  readonly takeFiredHold: () => boolean;
}

/**
 * Hold a row still for 500 ms. Reads the raw touches, so it runs beside the
 * row's Pressable and the swipe row's pan without taking either's gesture.
 */
export function useLongPress(onLongPress: () => void, enabled: boolean): LongPress {
  const stateRef = useRef<LongPressState>(LONG_PRESS_IDLE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const handlerRef = useRef(onLongPress);
  useEffect(() => {
    handlerRef.current = onLongPress;
  }, [onLongPress]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const step = useCallback(
    (event: LongPressEvent) => {
      const next = longPressStep(stateRef.current, event);
      stateRef.current = next.state;
      if (next.state.kind !== "holding") clearTimer();
      if (next.fire) {
        firedRef.current = true;
        handlerRef.current();
      }
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  const touchProps = useMemo<LongPressTouchProps>(
    () => ({
      onTouchStart: (event) => {
        if (!enabled) return;
        firedRef.current = false;
        clearTimer();
        step({
          kind: "down",
          x: event.nativeEvent.pageX,
          y: event.nativeEvent.pageY,
        });
        timerRef.current = setTimeout(() => step({ kind: "elapsed" }), LONG_PRESS_MS);
      },
      onTouchMove: (event) =>
        step({ kind: "move", x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }),
      onTouchEnd: () => step({ kind: "end" }),
      onTouchCancel: () => step({ kind: "end" }),
    }),
    [enabled, clearTimer, step],
  );

  const takeFiredHold = useCallback(() => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  return { touchProps, takeFiredHold };
}
