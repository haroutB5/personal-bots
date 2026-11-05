import type { PersonalBot } from "@t3tools/contracts";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { ReactNode } from "react";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";

export type StatusTone = "live" | "review" | "error" | "none";

/** The small avatar a task or routine row carries, blank when the bot is gone. */
export function SmallBotAvatar({
  bot,
  size = 34,
}: {
  readonly bot: PersonalBot | undefined;
  readonly size?: number;
}) {
  if (bot === undefined) {
    return (
      <View
        style={[styles.avatarPlaceholder, { width: size, height: size, borderRadius: size / 2 }]}
      />
    );
  }
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} label={bot.name} />;
}

export function StatusDot({ tone }: { readonly tone: StatusTone }) {
  if (tone === "none") return null;
  return (
    <View
      style={[
        styles.dot,
        tone === "live" ? styles.dotLive : tone === "review" ? styles.dotReview : styles.dotError,
      ]}
    />
  );
}

export function Card({
  children,
  style,
}: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { readonly children: string }) {
  return (
    <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
      {children}
    </Text>
  );
}

export function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
      <Text style={styles.detailValue} maxFontSizeMultiplier={1.6}>
        {children}
      </Text>
    </View>
  );
}

export function TaskButton({
  label,
  onPress,
  variant = "secondary",
  disabled = false,
  busy = false,
  grow = true,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: "primary" | "secondary" | "danger";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly grow?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.button,
        grow ? styles.buttonGrow : null,
        variant === "primary"
          ? styles.buttonPrimary
          : variant === "danger"
            ? styles.buttonDanger
            : styles.buttonSecondary,
        pressed && !disabled && !busy ? styles.buttonPressed : null,
        disabled || busy ? styles.buttonDisabled : null,
      ]}
    >
      <Text
        style={[
          styles.buttonLabel,
          variant === "primary"
            ? styles.buttonLabelPrimary
            : variant === "danger"
              ? styles.buttonLabelDanger
              : null,
        ]}
        maxFontSizeMultiplier={1.6}
      >
        {busy ? `${label}…` : label}
      </Text>
    </Pressable>
  );
}

export function EmptyText({ children }: { readonly children: string }) {
  return (
    <Text style={styles.emptyText} maxFontSizeMultiplier={1.6}>
      {children}
    </Text>
  );
}

export function ScreenScroll({
  children,
  contentStyle,
}: {
  readonly children: ReactNode;
  readonly contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.scrollBody, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  avatarPlaceholder: { backgroundColor: tokens.fillMuted },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotLive: { backgroundColor: tokens.working },
  dotReview: { backgroundColor: tokens.needs },
  dotError: { backgroundColor: tokens.error },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    padding: 16,
  },
  sectionLabel: {
    color: tokens.sectionLabel,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 16,
    paddingVertical: 6,
  },
  detailLabel: { color: tokens.textSecondary, fontSize: 14, flexShrink: 0 },
  detailValue: { color: tokens.text, fontSize: 14, flexShrink: 1, textAlign: "right" },
  button: {
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonGrow: { flexGrow: 1, flexBasis: 0 },
  buttonPrimary: { backgroundColor: tokens.primary },
  buttonSecondary: {
    backgroundColor: tokens.fillMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  buttonDanger: {
    backgroundColor: "transparent",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
  },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: tokens.text, fontSize: 15, fontWeight: "600" },
  buttonLabelPrimary: { color: tokens.primaryText },
  buttonLabelDanger: { color: tokens.error },
  emptyText: {
    color: tokens.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
    paddingVertical: 32,
  },
  scroll: { flex: 1 },
  scrollBody: { paddingBottom: 24 },
});
