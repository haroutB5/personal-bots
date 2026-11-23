import { offlineBannerHint, offlineBannerText } from "@hbots/personal-client/bots/offlineBanner";
import { IconWifiOff } from "../ui/icons";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { RestartLaptopConfirmSheet } from "../settings/RestartLaptopConfirmSheet";
import {
  RESTART_DRY_RUN_TEXT,
  RESTART_OFFLINE_BUTTON_LABEL,
  RESTART_TEST_IDS,
  RESTARTING_TEXT,
  type RestartOutcome,
} from "../settings/restartLaptopModel";
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
 * to a message sent now. Above the header, as on the web. When the owner is
 * signed in, also offers a direct Restart action with confirmation.
 */
export function PersonalOfflineBanner({ native }: { readonly native: NativePersonal }) {
  const connection = native.useConnectionState();
  const [now, setNow] = useState(() => Date.now());
  const [lastContact, setLastContact] = useState<number | null>(() => readLastContact(native));
  const [confirmGeneration, setConfirmGeneration] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [outcomeState, setOutcomeState] = useState<{
    readonly generation: number;
    readonly outcome: RestartOutcome;
  } | null>(null);

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

  const confirmOpen = confirmGeneration === connection.generation;
  const outcome =
    outcomeState !== null && outcomeState.generation === connection.generation
      ? outcomeState.outcome
      : null;

  const showRestartAction = native.canRestartLaptop && (phase === "offline" || phase === "error");

  const confirmRestart = async () => {
    if (sending) return;
    const gen = connection.generation;
    setSending(true);
    const result = await native.restartLaptop();
    setSending(false);
    setConfirmGeneration(null);
    setOutcomeState({ generation: gen, outcome: result });
  };

  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.row}>
        <IconWifiOff size={16} color={tokens.text} strokeWidth={1.75} />
        <View style={styles.copy}>
          <Text style={styles.text} numberOfLines={1}>
            {text}
          </Text>
          <Text style={styles.hint} numberOfLines={2}>
            {offlineBannerHint(0)}
          </Text>
        </View>
        {showRestartAction ? (
          <Pressable
            testID={RESTART_TEST_IDS.offlineRestartButton}
            onPress={() => setConfirmGeneration(connection.generation)}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={RESTART_OFFLINE_BUTTON_LABEL}
            style={({ pressed }) => [
              styles.restartButton,
              pressed ? styles.pressed : null,
              sending ? styles.disabled : null,
            ]}
          >
            <Text style={styles.restartLabel} maxFontSizeMultiplier={1.3}>
              {sending ? "Restarting…" : RESTART_OFFLINE_BUTTON_LABEL}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {outcome?.kind === "restarting" ? (
        <View testID={RESTART_TEST_IDS.offlineRestartStatus}>
          <Text
            testID={RESTART_TEST_IDS.restarting}
            style={styles.statusOk}
            maxFontSizeMultiplier={1.4}
          >
            {outcome.dryRun ? RESTART_DRY_RUN_TEXT : RESTARTING_TEXT}
          </Text>
        </View>
      ) : null}
      {outcome?.kind === "error" ? (
        <View testID={RESTART_TEST_IDS.offlineRestartStatus}>
          <Text
            testID={RESTART_TEST_IDS.error}
            style={styles.statusError}
            maxFontSizeMultiplier={1.4}
          >
            {outcome.message}
          </Text>
        </View>
      ) : null}
      {showRestartAction ? (
        <RestartLaptopConfirmSheet
          visible={confirmOpen}
          sending={sending}
          onConfirm={() => void confirmRestart()}
          onCancel={() => setConfirmGeneration(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 40,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.reviewBorder,
    backgroundColor: tokens.reviewBg,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  copy: { flex: 1, minWidth: 0 },
  text: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  hint: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16 },
  restartButton: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.danger,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  restartLabel: { color: tokens.danger, fontSize: 13, fontWeight: "600" },
  statusOk: { color: tokens.text, fontSize: 12, lineHeight: 16 },
  statusError: { color: tokens.danger, fontSize: 12, lineHeight: 16 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
});
