import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { tokens } from "../shell/tokens";

const MARK = require("../../assets/icon/foreground.png");

/** Opens the phone's own security settings, where a screen lock is set up. */
function openSecuritySettings(): void {
  Linking.sendIntent("android.settings.SECURITY_SETTINGS").catch(() => Linking.openSettings());
}

/**
 * The cover shown while the app lock is closed: the mark at 40% height and one button.
 * On a phone with no screen lock there is nothing to unlock with, so it says so and
 * offers the two ways out: set one up, or sign out (which removes this phone's data).
 */
export function LockScreen({
  onUnlock,
  noScreenLock,
  onSignOut,
}: {
  readonly onUnlock: () => void;
  readonly noScreenLock: boolean;
  readonly onSignOut: () => void;
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
          {noScreenLock
            ? "This phone has no screen lock, so hbots cannot check it is you. Set a screen lock in your phone's settings, or sign out to remove hbots from this phone."
            : "Unlock to continue"}
        </Text>
      </View>
      <View style={styles.actions}>
        {noScreenLock ? (
          <>
            <Pressable
              onPress={openSecuritySettings}
              accessibilityRole="button"
              accessibilityLabel="Open security settings"
              style={styles.button}
            >
              <Text style={styles.buttonText} maxFontSizeMultiplier={1.6}>
                Open security settings
              </Text>
            </Pressable>
            <Pressable
              onPress={onSignOut}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              style={styles.secondary}
            >
              <Text style={styles.secondaryText} maxFontSizeMultiplier={1.6}>
                Sign out
              </Text>
            </Pressable>
          </>
        ) : (
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
        )}
      </View>
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
  line: { color: tokens.textSecondary, fontSize: 16, lineHeight: 22, textAlign: "center" },
  actions: { gap: 12 },
  secondary: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.textSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { color: tokens.text, fontSize: 16, fontWeight: "700" },
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
});
