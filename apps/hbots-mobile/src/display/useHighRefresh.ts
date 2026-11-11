import { requireOptionalNativeModule } from "expo";
import { useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";

import { createRefreshLease, type DisplayNative } from "./refreshLease";

/** A drag with no momentum settles at once; a fling keeps the lease until it stops. */
const DRAG_SETTLE_MS = 450;
const MOMENTUM_SETTLE_MS = 120;

const native =
  Platform.OS === "android" ? requireOptionalNativeModule<DisplayNative>("HbotsDisplay") : null;

const lease = createRefreshLease(native);
let nextOwner = 0;

/**
 * Props for a list: the fastest refresh rate is requested while the list scrolls and handed
 * back after. Spread the result on a ScrollView or FlatList. No request goes out on a
 * display with one refresh rate.
 */
export function useHighRefresh() {
  const owner = useRef<string | null>(null);
  if (owner.current === null) owner.current = `list-${nextOwner++}`;
  const id = owner.current;

  useEffect(() => () => lease.release(id), [id]);

  return useMemo(
    () => ({
      onScrollBeginDrag: () => lease.acquire(id),
      onScrollEndDrag: () => lease.releaseSoon(id, DRAG_SETTLE_MS),
      onMomentumScrollBegin: () => lease.acquire(id),
      onMomentumScrollEnd: () => lease.releaseSoon(id, MOMENTUM_SETTLE_MS),
    }),
    [id],
  );
}
