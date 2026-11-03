import { IconChevronLeft } from "@tabler/icons-react-native";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { tokens } from "./tokens";

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onBack?: (() => void) | undefined;
  readonly right?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {onBack === undefined ? null : (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.back}
          hitSlop={4}
        >
          <IconChevronLeft size={24} color={tokens.text} strokeWidth={2} />
        </Pressable>
      )}
      <View style={styles.titleBlock}>
        <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {subtitle}
          </Text>
        )}
      </View>
      <View style={styles.right}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 4,
    paddingRight: 8,
    backgroundColor: tokens.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  titleBlock: { flex: 1, paddingLeft: 4 },
  title: { color: tokens.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.2 },
  subtitle: { color: tokens.textSecondary, fontSize: 12, marginTop: 1 },
  right: { flexDirection: "row", alignItems: "center" },
});
