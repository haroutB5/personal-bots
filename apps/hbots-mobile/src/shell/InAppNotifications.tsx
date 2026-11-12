import type { PersonalPushInAppNotification } from "@t3tools/contracts";
import {
  FOREGROUND_HEARTBEAT_MS,
  planInAppNotifications,
} from "@hbots/personal-client/bots/inAppNotifications";
import { useEffect, useReducer, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { autoHideDelay, bannerReducer } from "../motion/bannerPresence";
import { useReducedMotion } from "../motion/useReducedMotion";
import type { NativePersonal } from "../personal/nativePersonalClient";
import { InAppBanner } from "./InAppBanner";

/**
 * Tells the server the app is on screen, so notifications arrive in-app
 * instead of as a system push, and shows the newest one as a banner over the
 * Bots screen. Every notification the foreground app takes is acknowledged.
 */
export function InAppNotifications({
  native,
  currentPath,
  onOpen,
}: {
  readonly native: NativePersonal;
  readonly currentPath: string;
  readonly onOpen: (url: string) => void;
}) {
  const feed = native.bots.usePersonalPushInApp(native.environmentId).data;
  const ack = native.client.useAtomCommand(native.bots.personalPushAckInApp, {
    reportFailure: false,
  });
  const presence = native.client.useAtomCommand(native.bots.personalPushReportForeground, {
    reportFailure: false,
  });
  const seen = useRef(new Set<string>());
  const [banner, dispatch] = useReducer(bannerReducer<PersonalPushInAppNotification>, {
    phase: "hidden",
  });
  const reduced = useReducedMotion();
  const [appState, setAppState] = useState<AppStateStatus>(() => AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const visible = appState === "active";
    void presence({ environmentId: native.environmentId, input: { foreground: visible } });
    if (!visible) return;
    const timer = setInterval(() => {
      void presence({ environmentId: native.environmentId, input: { foreground: true } });
    }, FOREGROUND_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [appState, native, presence]);

  useEffect(() => {
    if (feed === null) return;
    const plan = planInAppNotifications(seen.current, feed, {
      visible: appState === "active",
      currentPath,
    });
    for (const id of plan.ack) {
      void ack({ environmentId: native.environmentId, input: { id } });
    }
    if (plan.show !== null) dispatch({ kind: "arrive", notification: plan.show });
  }, [feed, appState, currentPath, ack, native.environmentId]);

  const shownId = banner.phase === "shown" ? banner.notification.id : null;
  useEffect(() => {
    if (shownId === null) return;
    const timer = setTimeout(() => dispatch({ kind: "dismiss" }), autoHideDelay(reduced));
    return () => clearTimeout(timer);
  }, [shownId, reduced]);

  if (banner.phase === "hidden") return null;
  const { notification } = banner;
  return (
    <InAppBanner
      key={notification.id}
      notification={notification}
      leaving={banner.phase === "leaving"}
      onOpen={() => {
        dispatch({ kind: "close" });
        onOpen(notification.url);
      }}
      onDismiss={() => dispatch({ kind: "dismiss" })}
      onExited={() => dispatch({ kind: "exited", id: notification.id })}
    />
  );
}
