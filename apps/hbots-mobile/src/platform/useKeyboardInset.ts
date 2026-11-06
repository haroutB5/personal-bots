import { useEffect, useRef, useState } from "react";
import { Keyboard, type LayoutChangeEvent } from "react-native";

import { keyboardRemainder } from "./keyboardInset";

/**
 * Padding that lifts a full-height container above the IME. It measures the
 * container before and during the keyboard, so a window that resizes for the
 * keyboard gets no extra padding and an edge-to-edge window gets all of it.
 */
export function useKeyboardInset(active = true): {
  readonly padding: number;
  readonly onLayout: (event: LayoutChangeEvent) => void;
} {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [frameHeight, setFrameHeight] = useState(0);
  const baseHeight = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardHeight(0);
      baseHeight.current = null;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [active]);

  if (!active) return { padding: 0, onLayout: () => undefined };
  const onLayout = (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setFrameHeight(height);
    if (keyboardHeight === 0) baseHeight.current = height;
  };
  if (keyboardHeight === 0 || baseHeight.current === null) {
    return { padding: 0, onLayout };
  }
  return {
    padding: keyboardRemainder({
      baseHeight: baseHeight.current,
      frameHeight,
      keyboardHeight,
    }),
    onLayout,
  };
}
