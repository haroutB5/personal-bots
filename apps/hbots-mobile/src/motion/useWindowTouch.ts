import { requireOptionalNativeModule } from "expo";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { findNodeHandle, Platform, type View } from "react-native";

import { createWindowTouchGate, type WindowTouchNative } from "./windowTouchGate";

const native =
  Platform.OS === "android" ? requireOptionalNativeModule<WindowTouchNative>("HbotsWindow") : null;

/**
 * Hand the returned callback to `ref` on the root view inside a Modal. While
 * `passThrough` is true that window ignores touches, so a tap lands on the
 * screen beneath. Without the native module it does nothing.
 */
export function useWindowTouch(
  passThrough: boolean,
  mounted: boolean,
): (node: View | null) => void {
  const ref = useRef<View | null>(null);
  const attach = useCallback((node: View | null) => {
    ref.current = node;
  }, []);
  const [gate] = useState(() => createWindowTouchGate(native));
  useLayoutEffect(() => {
    if (!mounted) return;
    const tag = ref.current === null ? null : findNodeHandle(ref.current);
    gate.apply(tag, !passThrough);
  }, [gate, passThrough, mounted]);
  return attach;
}
