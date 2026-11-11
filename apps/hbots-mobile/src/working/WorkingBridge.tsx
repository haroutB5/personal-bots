import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import { nativeNotify } from "../notifications/nativeNotify";
import type { NativePersonal } from "../personal/nativePersonalClient";
import {
  buildWorkingFeed,
  createWorkingPublisher,
  HEARTBEAT_MS,
  type WorkingPublisher,
} from "./workingFeed";
import { useWorkingThreads } from "./useWorkingThreads";

/**
 * Mounted while a session is ready. It tells the native "bots working" notification who is running,
 * resends every 15 s so native keeps it alive, and clears it when the last run ends. If this
 * process is frozen the heartbeat stops and native expires the notification by itself.
 */
export function WorkingBridge({ native }: { readonly native: NativePersonal }) {
  const view = useWorkingThreads(native);
  const publisher = useRef<WorkingPublisher | null>(null);
  if (publisher.current === null) {
    publisher.current = createWorkingPublisher({
      set: (feed) => {
        try {
          nativeNotify?.setWorking(feed.map((bot) => ({ ...bot })));
        } catch (cause) {
          console.warn("Could not update the working notification.", cause);
        }
      },
      clear: () => {
        try {
          nativeNotify?.clearWorking();
        } catch (cause) {
          console.warn("Could not clear the working notification.", cause);
        }
      },
    });
  }

  const feed = useMemo(
    () => (view.status === "ready" ? buildWorkingFeed(view.threads, view.notes) : null),
    [view],
  );

  useEffect(() => {
    publisher.current?.update(feed);
  }, [feed]);

  useEffect(() => {
    const timer = setInterval(() => publisher.current?.heartbeat(), HEARTBEAT_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") publisher.current?.heartbeat();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      // A session that ends, or this bridge unmounting, leaves no notification behind.
      publisher.current?.update([]);
      publisher.current?.reset();
    };
  }, []);

  return null;
}
