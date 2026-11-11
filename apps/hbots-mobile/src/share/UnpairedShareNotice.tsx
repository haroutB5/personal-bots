import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "../shell/tokens";

/**
 * Shown over the sign-in screen when a share arrived with no session. The
 * button only dismisses the card: the sign-in screen is already underneath.
 */
export function UnpairedShareNotice({
  message,
  onOpenSignIn,
}: {
  readonly message: string;
  readonly onOpenSignIn: () => void;
}) {
  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <View style={styles.card}>
        <Text style={styles.message} accessibilityRole="alert" maxFontSizeMultiplier={1.6}>
          {message}
        </Text>
        <Pressable
          onPress={onOpenSignIn}
          accessibilityRole="button"
          accessibilityLabel="Open sign-in"
          style={styles.button}
        >
          <Text style={styles.buttonText} maxFontSizeMultiplier={1.6}>
            Open sign-in
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: tokens.scrim,
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 20,
    gap: 16,
  },
  message: { color: tokens.text, fontSize: 16, lineHeight: 22 },
  button: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: tokens.primaryText, fontSize: 16, fontWeight: "700" },
});
