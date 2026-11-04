import { offlineBannerHint, offlineBannerText } from "@hbots/personal-client/bots/offlineBanner";
import { IconWifiOff } from "@tabler/icons-react-native";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "./tokens";

const LAST_CONTACT_PREFIX = "t3.personal.lastContact.";
const MINUTE_MS = 60_000;

function readLastContact(native: NativePersonal): number | null {
  const raw = native.client.ports.kv.getItem(LAST_CONTACT_PREFIX + native.environmentId);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * "Laptop offline · last contact 5m ago", with the line that says what happens
 * to a message sent now. Above the header, as on the web.
 */
export function PersonalOfflineBanner({ native }: { readonly native: NativePersonal }) {
  const connection = native.useConnectionState();
  const [now, setNow] = useState(() => Date.now());
  const [lastContact, setLastContact] = useState<number | null>(() => readLastContact(native));

  useEffect(() => {
    if (connection.phase === "connected") {
      const stamp = () => {
        const at = Date.now();
        native.client.ports.kv.setItem(LAST_CONTACT_PREFIX + native.environmentId, String(at));
        setLastContact(at);
        setNow(at);
      };
      stamp();
      const timer = setInterval(stamp, MINUTE_MS);
      return () => clearInterval(timer);
    }
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [connection.phase, native]);

  const phase =
    connection.phase === "backoff"
      ? "offline"
      : connection.phase === "blocked"
        ? "error"
        : connection.phase;
  const text = offlineBannerText(phase, lastContact, now);
  if (text === null) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <IconWifiOff size={16} color={tokens.text} strokeWidth={1.75} />
      <View style={styles.copy}>
        <Text style={styles.text} numberOfLines={1}>
          {text}
        </Text>
        <Text style={styles.hint} numberOfLines={2}>
          {offlineBannerHint(0)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.reviewBorder,
    backgroundColor: tokens.reviewBg,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  copy: { flex: 1, minWidth: 0 },
  text: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  hint: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
});
