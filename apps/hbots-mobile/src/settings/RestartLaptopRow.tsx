import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import { Notice } from "./SettingsUi";
import {
  RESTART_CANCEL_LABEL,
  RESTART_CONFIRM_BODY,
  RESTART_CONFIRM_LABEL,
  RESTART_CONFIRM_TITLE,
  RESTART_DRY_RUN_TEXT,
  RESTART_HOLD_HINT_TEXT,
  RESTART_HOLD_MS,
  RESTART_RECHECK_MS,
  RESTART_ROW_HINT,
  RESTART_ROW_TITLE,
  RESTART_TEST_IDS,
  RESTARTING_TEXT,
  type RestartOutcome,
} from "./restartLaptopModel";

/**
 * Settings > Restart laptop. Hold the row for two seconds (the fill shows the
 * progress), then confirm in a sheet. Screen readers activate the row straight
 * to the sheet, which is the confirmation either way. After the server
 * accepts, the normal reconnect does the rest.
 */
export function RestartLaptopRow({ native }: { readonly native: NativePersonal }) {
  // Created once; state, not a ref, because the render reads it.
  const [fill] = useState(() => new Animated.Value(0));
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<RestartOutcome | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [holdHint, setHoldHint] = useState(false);

  // Opening Settings asks whether logind allows a restart, and lets the server
  // remember this phone's credential for when its database fails.
  useEffect(() => {
    let live = true;
    void native.readRestartStatus().then((status) => {
      if (live && status !== null) setRefusal(status.canRestart ? null : status.refusal);
    });
    return () => {
      live = false;
    };
  }, [native]);

  // If the server is somehow still answering long after, say why it did not restart.
  useEffect(() => {
    if (outcome?.kind !== "restarting" || outcome.dryRun) return;
    let live = true;
    const timer = setTimeout(() => {
      void native.readRestartStatus().then((status) => {
        if (live && status?.lastError) setOutcome({ kind: "error", message: status.lastError });
      });
    }, RESTART_RECHECK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [native, outcome]);

  useEffect(
    () => () => {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    },
    [],
  );

  const cancelHold = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    fill.stopAnimation();
    Animated.timing(fill, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };

  const startHold = () => {
    if (sending) return;
    setHoldHint(false);
    fill.setValue(0);
    Animated.timing(fill, {
      toValue: 1,
      duration: RESTART_HOLD_MS,
      useNativeDriver: false,
    }).start();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      fill.setValue(0);
      setConfirmOpen(true);
    }, RESTART_HOLD_MS);
  };

  const confirm = async () => {
    if (sending) return;
    setSending(true);
    const result = await native.restartLaptop();
    setSending(false);
    setConfirmOpen(false);
    setOutcome(result);
  };

  const width = fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <View>
      <Pressable
        testID={RESTART_TEST_IDS.row}
        accessibilityRole="button"
        accessibilityLabel={RESTART_ROW_TITLE}
        accessibilityHint={RESTART_ROW_HINT}
        accessibilityActions={[{ name: "activate" }, { name: "longpress" }]}
        onAccessibilityAction={() => setConfirmOpen(true)}
        onPressIn={startHold}
        onPressOut={() => {
          if (holdTimer.current !== null) {
            setHoldHint(true);
            cancelHold();
          }
        }}
        disabled={sending}
        style={[styles.row, styles.rowDivider]}
      >
        <Animated.View pointerEvents="none" style={[styles.fill, { width }]} />
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} maxFontSizeMultiplier={1.4}>
            {RESTART_ROW_TITLE}
          </Text>
          <Text style={styles.rowHint} maxFontSizeMultiplier={1.4}>
            {refusal ?? RESTART_ROW_HINT}
          </Text>
        </View>
      </Pressable>
      {holdHint && outcome === null ? (
        <Text style={styles.inlineHint} maxFontSizeMultiplier={1.4}>
          {RESTART_HOLD_HINT_TEXT}
        </Text>
      ) : null}
      {outcome?.kind === "restarting" ? (
        <View style={styles.notice}>
          <View testID={RESTART_TEST_IDS.restarting} accessibilityLabel={RESTARTING_TEXT}>
            <Notice tone="success">{RESTARTING_TEXT}</Notice>
          </View>
          {outcome.dryRun ? (
            <Text
              testID={RESTART_TEST_IDS.dryRun}
              accessibilityLabel={RESTART_DRY_RUN_TEXT}
              style={styles.inlineHint}
              maxFontSizeMultiplier={1.4}
            >
              {RESTART_DRY_RUN_TEXT}
            </Text>
          ) : null}
        </View>
      ) : null}
      {outcome?.kind === "error" ? (
        <View
          style={styles.notice}
          testID={RESTART_TEST_IDS.error}
          accessibilityLabel={outcome.message}
        >
          <Notice tone="danger">{outcome.message}</Notice>
        </View>
      ) : null}
      <SheetShell
        visible={confirmOpen}
        title={RESTART_CONFIRM_TITLE}
        onClose={() => {
          if (!sending) setConfirmOpen(false);
        }}
      >
        <View style={styles.sheetBody} testID={RESTART_TEST_IDS.confirmSheet}>
          <Text style={styles.sheetText} maxFontSizeMultiplier={1.4}>
            {RESTART_CONFIRM_BODY}
          </Text>
          <Pressable
            testID={RESTART_TEST_IDS.confirm}
            onPress={() => void confirm()}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={RESTART_CONFIRM_LABEL}
            accessibilityState={{ disabled: sending, busy: sending }}
            style={({ pressed }) => [
              styles.button,
              styles.buttonDanger,
              pressed ? styles.pressed : null,
              sending ? styles.disabled : null,
            ]}
          >
            <Text style={styles.buttonDangerLabel} maxFontSizeMultiplier={1.3}>
              {sending ? "Restarting…" : RESTART_CONFIRM_LABEL}
            </Text>
          </Pressable>
          <Pressable
            testID={RESTART_TEST_IDS.cancel}
            onPress={() => setConfirmOpen(false)}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={RESTART_CANCEL_LABEL}
            style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
          >
            <Text style={styles.buttonLabel} maxFontSizeMultiplier={1.3}>
              {RESTART_CANCEL_LABEL}
            </Text>
          </Pressable>
        </View>
      </SheetShell>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    overflow: "hidden",
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.border },
  fill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: tokens.danger,
    opacity: 0.28,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: tokens.danger, fontSize: 16, fontWeight: "500" },
  rowHint: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  inlineHint: {
    color: tokens.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  notice: { paddingHorizontal: 12, paddingBottom: 10, gap: 4 },
  sheetBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  sheetText: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20 },
  button: {
    minHeight: 48,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  buttonDanger: { backgroundColor: tokens.danger, borderColor: tokens.danger },
  buttonDangerLabel: { color: tokens.bg, fontSize: 15, fontWeight: "600" },
  buttonLabel: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
});
