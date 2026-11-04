import type { PersonalPushInAppNotification } from "@t3tools/contracts";
import {
  FOREGROUND_HEARTBEAT_MS,
  IN_APP_BANNER_MS,
  planInAppNotifications,
} from "@hbots/personal-client/bots/inAppNotifications";
import { IconX } from "@tabler/icons-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View, type AppStateStatus } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { BotAvatar } from "./BotAvatar";
import { tokens } from "./tokens";

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
  const insets = useSafeAreaInsets();
  const feed = native.bots.usePersonalPushInApp(native.environmentId).data;
  const ack = native.client.useAtomCommand(native.bots.personalPushAckInApp, {
    reportFailure: false,
  });
  const presence = native.client.useAtomCommand(native.bots.personalPushReportForeground, {
    reportFailure: false,
  });
  const seen = useRef(new Set<string>());
  const [banner, setBanner] = useState<PersonalPushInAppNotification | null>(null);
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
    if (plan.show !== null) setBanner(plan.show);
  }, [feed, appState, currentPath, ack, native.environmentId]);

  useEffect(() => {
    if (banner === null) return;
    const timer = setTimeout(() => setBanner(null), IN_APP_BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  if (banner === null) return null;
  const line = banner.preview ?? banner.body;
  const name = banner.title.replace(/ replied$/u, "");
  return (
    <View style={[styles.host, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
      <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <Pressable
          onPress={() => {
            setBanner(null);
            onOpen(banner.url);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${banner.title}. ${line}`}
          style={styles.body}
        >
          {banner.avatarShape !== undefined && banner.avatarColor !== undefined ? (
            <BotAvatar shape={banner.avatarShape} color={banner.avatarColor} size={32} label="" />
          ) : null}
          <View style={styles.copy}>
            <Text style={styles.title} numberOfLines={1}>
              {name}
            </Text>
            <Text style={styles.preview} numberOfLines={1}>
              {line}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => setBanner(null)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          style={styles.close}
          hitSlop={8}
        >
          <IconX size={18} color={tokens.textSecondary} strokeWidth={2} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  banner: {
    width: "100%",
    maxWidth: 480,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 4,
    shadowColor: "#000000",
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  body: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  copy: { flex: 1, minWidth: 0 },
  title: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  preview: { color: tokens.textSecondary, fontSize: 13 },
  close: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
});
