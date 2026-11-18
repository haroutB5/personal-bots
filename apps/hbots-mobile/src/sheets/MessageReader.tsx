import { ScrollView, StyleSheet, Text, useWindowDimensions } from "react-native";

import { tokens } from "../shell/tokens";

/** One selectable `Text` in a scroller: a drag of a handle can cross paragraphs and code. */
export function MessageReader({ text }: { readonly text: string }) {
  const { height } = useWindowDimensions();
  return (
    <ScrollView
      style={[styles.scroll, { maxHeight: Math.round(height * 0.7) }]}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text selectable accessibilityLabel="Message text" style={styles.text}>
        {text}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    margin: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
  },
  content: { padding: 12 },
  text: { color: tokens.text, fontSize: 15, lineHeight: 21 },
});
