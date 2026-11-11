import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { tokens } from "../shell/tokens";
import type { LockCallLine } from "../voice/callLock";

const MARK = require("../../assets/icon/foreground.png");

/** The cover shown while the app lock is closed: the mark at 40% height and one button. */
export function LockScreen({
  onUnlock,
  call = null,
  onHangUp,
}: {
  readonly onUnlock: () => void;
  readonly call?: LockCallLine | null;
  readonly onHangUp?: () => void;
}) {
  const { height } = useWindowDimensions();
  return (
    <View style={styles.screen} accessibilityViewIsModal>
      <View style={[styles.body, { paddingTop: Math.round(height * 0.4) }]}>
        <Image source={MARK} style={styles.mark} accessibilityIgnoresInvertColors />
        <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.4}>
          hbots is locked
        </Text>
        <Text style={styles.line} maxFontSizeMultiplier={1.4}>
          Unlock to continue
        </Text>
        {call === null ? null : (
          <View style={styles.call} accessibilityRole="summary">
            <Text style={styles.callTitle} maxFontSizeMultiplier={1.4}>
              {call.title}
            </Text>
            <Text style={styles.line} maxFontSizeMultiplier={1.4}>
              {call.body}
            </Text>
            {onHangUp === undefined ? null : (
              <Pressable
                onPress={onHangUp}
                accessibilityRole="button"
                accessibilityLabel="Hang up"
                style={styles.hangUp}
              >
                <Text style={styles.hangUpText} maxFontSizeMultiplier={1.6}>
                  Hang up
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
      <Pressable
        onPress={onUnlock}
        accessibilityRole="button"
        accessibilityLabel="Unlock"
        style={styles.button}
      >
        <Text style={styles.buttonText} maxFontSizeMultiplier={1.6}>
          Unlock
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: tokens.bg,
    padding: 24,
    justifyContent: "space-between",
  },
  body: { alignItems: "center", gap: 10 },
  mark: { width: 56, height: 56, resizeMode: "contain" },
  title: { color: tokens.text, fontSize: 22, fontWeight: "700", marginTop: 8 },
  line: { color: tokens.textSecondary, fontSize: 16, lineHeight: 22 },
  call: { alignItems: "center", gap: 8, marginTop: 24 },
  callTitle: { color: tokens.text, fontSize: 17, fontWeight: "700" },
  hangUp: {
    minHeight: 48,
    minWidth: 160,
    borderRadius: 12,
    backgroundColor: tokens.dangerBg,
    borderColor: tokens.danger,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  hangUpText: { color: tokens.danger, fontSize: 16, fontWeight: "700" },
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
});
