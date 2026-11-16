import {
  FOREGROUND_HEARTBEAT_MS,
  planInAppNotifications,
} from "@hbots/personal-client/bots/inAppNotifications";
import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import type { InAppBannerFeed } from "./inAppBannerFeed";

/** The screen the banner shows over: a notification for it needs no banner. */
export const BANNER_HOST_PATH = "/bots";

/**
 * Tells the server the app is on screen, so notifications arrive in-app
 * instead of as a system push, and acknowledges every one the foreground app
 * takes. Mounted once for the whole session, so it holds on every tab and
 * screen. It draws nothing: the banner host shows what it publishes.
 */
export function InAppPresence({
  native,
  banners,
}: {
  readonly native: NativePersonal;
  readonly banners: InAppBannerFeed;
}) {
  const feed = native.bots.usePersonalPushInApp(native.environmentId).data;
  const ack = native.client.useAtomCommand(native.bots.personalPushAckInApp, {
    reportFailure: false,
  });
  const presence = native.client.useAtomCommand(native.bots.personalPushReportForeground, {
    reportFailure: false,
  });
  const seen = useRef(new Set<string>());
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
      currentPath: BANNER_HOST_PATH,
    });
    for (const id of plan.ack) {
      void ack({ environmentId: native.environmentId, input: { id } });
    }
    if (plan.show !== null) banners.publish(plan.show);
  }, [feed, appState, ack, banners, native.environmentId]);

  return null;
}
