import type { ReactNode, Ref } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "../shell/ScreenHeader";
import { tokens } from "../shell/tokens";

export function SettingsPage({
  title,
  onBack,
  right,
  children,
}: {
  readonly title: string;
  readonly onBack?: (() => void) | undefined;
  readonly right?: ReactNode;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={title} onBack={onBack} right={right} />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

export function Row({
  title,
  hint,
  value,
  onPress,
  right,
  disabled = false,
  accessibilityLabel,
  last = false,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly value?: string | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly right?: ReactNode;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly last?: boolean;
}) {
  const body = (
    <>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} maxFontSizeMultiplier={1.4}>
          {title}
        </Text>
        {hint === undefined ? null : (
          <Text style={styles.rowHint} maxFontSizeMultiplier={1.4}>
            {hint}
          </Text>
        )}
      </View>
      {value === undefined ? null : (
        <Text style={styles.rowValue} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {value}
        </Text>
      )}
      {right}
    </>
  );
  if (onPress === undefined) {
    return <View style={[styles.row, last ? null : styles.rowDivider]}>{body}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.row,
        last ? null : styles.rowDivider,
        pressed && !disabled ? styles.rowPressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      {body}
    </Pressable>
  );
}

export function ToggleRow({
  title,
  hint,
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  last = false,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly last?: boolean;
}) {
  return (
    <View style={[styles.row, last ? null : styles.rowDivider]}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} maxFontSizeMultiplier={1.4}>
          {title}
        </Text>
        {hint === undefined ? null : (
          <Text style={styles.rowHint} maxFontSizeMultiplier={1.4}>
            {hint}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel ?? title}
        trackColor={{ true: tokens.primary, false: tokens.track }}
        thumbColor={tokens.text}
      />
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure = false,
  keyboardType,
  autoCapitalize = "sentences",
  autoComplete,
  maxLength,
  multiline = false,
  help,
  error,
  editable = true,
  inputRef,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder?: string;
  readonly secure?: boolean;
  readonly keyboardType?: "default" | "url" | "email-address" | "numeric";
  readonly autoCapitalize?: "none" | "sentences" | "words" | "characters";
  readonly autoComplete?: "off" | "username" | "new-password" | "given-name";
  readonly maxLength?: number;
  readonly multiline?: boolean;
  readonly help?: string;
  readonly error?: string | null;
  readonly editable?: boolean;
  readonly inputRef?: Ref<TextInput>;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.textTertiary}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        autoCorrect={!secure}
        maxLength={maxLength}
        multiline={multiline}
        editable={editable}
        accessibilityLabel={label}
        style={[styles.input, multiline ? styles.inputMultiline : null]}
      />
      {help === undefined ? null : (
        <Text style={styles.fieldHelp} maxFontSizeMultiplier={1.4}>
          {help}
        </Text>
      )}
      {error === undefined || error === null ? null : (
        <Text style={styles.fieldError} maxFontSizeMultiplier={1.4}>
          {error}
        </Text>
      )}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  busy = false,
  disabled = false,
  destructive = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      style={({ pressed }) => [
        styles.primary,
        destructive ? styles.primaryDestructive : null,
        pressed ? styles.pressed : null,
        disabled || busy ? styles.disabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={destructive ? tokens.danger : tokens.primaryText} />
      ) : (
        <Text
          style={[styles.primaryLabel, destructive ? styles.primaryLabelDestructive : null]}
          maxFontSizeMultiplier={1.3}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function TextButton({
  label,
  onPress,
  destructive = false,
  disabled = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.textButton, pressed ? styles.pressed : null]}
    >
      <Text
        style={[
          styles.textButtonLabel,
          destructive ? styles.textButtonDestructive : null,
          disabled ? styles.textButtonDisabled : null,
        ]}
        maxFontSizeMultiplier={1.3}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Notice({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "danger" | "success";
}) {
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : "text"}
      style={[
        styles.notice,
        tone === "danger" ? styles.noticeDanger : null,
        tone === "success" ? styles.noticeSuccess : null,
      ]}
    >
      <Text
        style={[styles.noticeText, tone === "danger" ? styles.noticeTextDanger : null]}
        maxFontSizeMultiplier={1.4}
      >
        {children}
      </Text>
    </View>
  );
}

export function SectionNote({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={styles.sectionNote} maxFontSizeMultiplier={1.4}>
      {children}
    </Text>
  );
}

export function BodyText({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={styles.bodyText} maxFontSizeMultiplier={1.5}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  body: { padding: 16, gap: 4 },
  section: { marginTop: 16, gap: 8 },
  sectionLabel: {
    color: tokens.sectionLabel,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    overflow: "hidden",
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: tokens.border,
  },
  rowPressed: { backgroundColor: tokens.raised },
  rowDisabled: { opacity: 0.5 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  rowHint: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  rowValue: { color: tokens.textSecondary, fontSize: 14, maxWidth: 140, textAlign: "right" },
  field: { padding: 16, gap: 6 },
  fieldLabel: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: "top" },
  fieldHelp: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17 },
  fieldError: { color: tokens.danger, fontSize: 12, lineHeight: 17 },
  primary: {
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: tokens.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    marginHorizontal: 16,
    marginVertical: 8,
  },
  primaryDestructive: { backgroundColor: tokens.danger },
  primaryLabel: { color: tokens.primaryText, fontSize: 15, fontWeight: "600" },
  primaryLabelDestructive: { color: tokens.primaryText },
  textButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  textButtonLabel: { color: tokens.textSecondary, fontSize: 14, fontWeight: "500" },
  textButtonDestructive: { color: tokens.danger },
  textButtonDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  notice: {
    backgroundColor: tokens.raised,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
  },
  noticeDanger: {
    backgroundColor: tokens.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.dangerBorder,
  },
  noticeSuccess: {
    backgroundColor: tokens.reviewBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.reviewBorder,
  },
  noticeText: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  noticeTextDanger: { color: tokens.danger },
  sectionNote: { color: tokens.textTertiary, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
  bodyText: { color: tokens.textSecondary, fontSize: 14, lineHeight: 20, paddingHorizontal: 4 },
});
