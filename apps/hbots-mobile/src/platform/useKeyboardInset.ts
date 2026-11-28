import { useEffect, useRef, useState } from "react";
import { Keyboard, type LayoutChangeEvent } from "react-native";

import { keyboardRemainder, nextBaseHeight } from "./keyboardInset";

/** The height of a keyboard that is up right now, 0 when there is none. */
function openKeyboardHeight(): number {
  if (!Keyboard.isVisible()) return 0;
  return Keyboard.metrics()?.height ?? 0;
}

/**
 * Padding that lifts a full-height container above the IME. It measures the
 * container before and during the keyboard, so a window that resizes for the
 * keyboard gets no extra padding and an edge-to-edge window gets all of it.
 */
export function useKeyboardInset(active = true): {
  readonly padding: number;
  /** True while the IME is up, even when the window resize already made room. */
  readonly open: boolean;
  /** The measured container height, which shrinks on a window that resizes. */
  readonly frameHeight: number;
  readonly onLayout: (event: LayoutChangeEvent) => void;
} {
  const [keyboardHeight, setKeyboardHeight] = useState(() => (active ? openKeyboardHeight() : 0));
  const [frameHeight, setFrameHeight] = useState(0);
  const baseHeight = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    // A keyboard that is already up sends no keyboardDidShow, and one that closed
    // while this was inactive sent its hide to nobody: read where it stands now.
    // eslint-disable-next-line react/set-state-in-effect -- syncs with the IME on activation
    setKeyboardHeight(openKeyboardHeight());
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      // Keep the closed-keyboard height: edge-to-edge windows do not lay out
      // again on hide, so clearing it left every later open without padding.
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [active]);

  if (!active) return { padding: 0, open: false, frameHeight, onLayout: () => undefined };
  const onLayout = (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setFrameHeight(height);
    baseHeight.current = nextBaseHeight({
      previous: baseHeight.current,
      layoutHeight: height,
      keyboardOpen: keyboardHeight > 0,
    });
  };
  // eslint-disable-next-line react/refs -- the layout height is captured by onLayout
  if (keyboardHeight === 0 || baseHeight.current === null) {
    return { padding: 0, open: keyboardHeight > 0, frameHeight, onLayout };
  }
  return {
    padding: keyboardRemainder({
      // eslint-disable-next-line react/refs -- the layout height is captured by onLayout
      baseHeight: baseHeight.current,
      frameHeight,
      keyboardHeight,
    }),
    open: true,
    frameHeight,
    onLayout,
  };
}
