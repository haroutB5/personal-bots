import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { IconBell } from "@tabler/icons-react-native";

import { tokens } from "../shell/tokens";
import { nativeNotify } from "./nativeNotify";
import { cardWords } from "./permissionCard";
import { permissionCardStore } from "./permissionCardRuntime";
import { androidPermission } from "./pushPermission";
import { pushController } from "./pushRuntime";

function enabledNow(): boolean {
  try {
    return nativeNotify?.notificationsEnabled() ?? true;
  } catch {
    return true;
  }
}

/**
 * The in-chat ask for notifications. It docks above the composer when the store says so, and
 * asks Android only when the owner taps Turn on.
 */
export function PermissionCard({
  botName,
  questionOpen,
}: {
  readonly botName: string;
  readonly questionOpen: boolean;
}) {
  const memory = useSyncExternalStore(
    permissionCardStore.subscribe,
    permissionCardStore.get,
    permissionCardStore.get,
  );
  const [enabled, setEnabled] = useState(enabledNow);
  const [busy, setBusy] = useState(false);
  // The clock is read when the card mounts and when the app comes back, never during a render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      setEnabled(enabledNow());
      setNow(Date.now());
    });
    return () => subscription.remove();
  }, []);
  const raw = permissionCardStore.view({
    now,
    notificationsEnabled: enabled,
    questionOpen,
    canAsk: Platform.OS === "android" && nativeNotify !== null,
  });
  // One episode per appearance: it counts as a show once, and then stays up until the owner
  // answers it, even though that count may already have reached the cap.
  const [shownAtMount] = useState(memory.shown);
  const episode = memory.shown > shownAtMount;
  useEffect(() => {
    if (raw.kind === "ask" && memory.shown === shownAtMount) permissionCardStore.shown();
  }, [raw.kind, memory.shown, shownAtMount]);
  const stillAsking =
    episode && !enabled && !memory.closed && memory.step === "ask" && now >= memory.hiddenUntil;
  const view: { readonly kind: "none" | "ask" | "background" } =
    raw.kind === "background" ? raw : stillAsking ? { kind: "ask" } : { kind: "none" };

  if (view.kind === "none") return null;
  const words = cardWords(
    view.kind === "background" ? "background" : "ask",
    botName,
    nativeNotify?.isFcmConfigured() ?? false,
  );

  const turnOn = async () => {
    setBusy(true);
    try {
      const answer = await androidPermission.request();
      if (answer === "blocked" || answer === "not-needed") nativeNotify?.openNotificationSettings();
      setEnabled(enabledNow());
      permissionCardStore.answered(answer);
      void pushController.refresh({ force: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} accessibilityRole="alert">
      <IconBell size={24} color={tokens.text} strokeWidth={1.75} />
      <View style={styles.text}>
        <Text style={styles.headline}>{words.headline}</Text>
        <Text style={styles.body}>{words.body}</Text>
        <View style={styles.buttons}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              if (view.kind === "ask") void turnOn();
              else void Linking.openSettings();
            }}
            style={[styles.primary, busy && styles.busy]}
          >
            <Text style={styles.primaryText}>{words.primary}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              view.kind === "ask"
                ? permissionCardStore.notNow(Date.now())
                : permissionCardStore.backgroundDone()
            }
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>{words.secondary}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 14,
    borderRadius: 16,
    backgroundColor: tokens.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  text: { flex: 1, gap: 4 },
  headline: { color: tokens.text, fontSize: 16, fontWeight: "600" },
  body: { color: tokens.textSecondary, fontSize: 14 },
  buttons: { flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" },
  primary: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  busy: { opacity: 0.6 },
  secondary: { minHeight: 44, paddingHorizontal: 14, justifyContent: "center" },
  secondaryText: { color: tokens.textSecondary, fontSize: 15 },
});
