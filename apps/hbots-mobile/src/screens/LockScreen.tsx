import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";

import { tokens } from "../shell/tokens";

const MARK = require("../../assets/icon/foreground.png");

/** The cover shown while the app lock is closed: the mark at 40% height and one button. */
export function LockScreen({ onUnlock }: { readonly onUnlock: () => void }) {
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
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
});
