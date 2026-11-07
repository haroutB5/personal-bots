import { IconChevronDown } from "@tabler/icons-react-native";
import type { ReactNode, RefObject } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { tokens } from "../shell/tokens";

export function FieldLabel({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={styles.label} maxFontSizeMultiplier={1.6}>
      {children}
    </Text>
  );
}

export function Hint({
  children,
  error = false,
}: {
  readonly children: ReactNode;
  readonly error?: boolean;
}) {
  return (
    <Text
      style={error ? styles.errorText : styles.hint}
      maxFontSizeMultiplier={1.6}
      accessibilityRole={error ? "alert" : undefined}
    >
      {children}
    </Text>
  );
}

export function TextField({
  label,
  optionalNote,
  value,
  onChange,
  placeholder,
  maxLength,
  multiline = false,
  error = null,
  inputRef,
  testID,
}: {
  readonly label: string;
  readonly optionalNote?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  readonly error?: string | null;
  readonly inputRef?: RefObject<TextInput | null>;
  readonly testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label} maxFontSizeMultiplier={1.6}>
        {label}
        {optionalNote === undefined ? null : <Text style={styles.optional}> {optionalNote}</Text>}
      </Text>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={tokens.textTertiary}
        maxLength={maxLength}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        autoComplete="off"
        autoCorrect={false}
        accessibilityLabel={label}
        testID={testID}
        maxFontSizeMultiplier={1.6}
        style={[
          styles.input,
          multiline ? styles.inputMultiline : null,
          error === null ? null : styles.inputInvalid,
        ]}
      />
      {error === null ? null : <Hint error>{error}</Hint>}
    </View>
  );
}

export function PickerField({
  label,
  valueLabel,
  onPress,
  hint,
  disabled = false,
}: {
  readonly label: string;
  readonly valueLabel: string;
  readonly onPress: () => void;
  readonly hint?: string;
  readonly disabled?: boolean;
}) {
  return (
    <View style={styles.field}>
      <FieldLabel>{label}</FieldLabel>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${valueLabel}`}
        style={[styles.input, styles.picker, disabled ? styles.disabled : null]}
      >
        <Text style={styles.pickerValue} numberOfLines={1} maxFontSizeMultiplier={1.6}>
          {valueLabel}
        </Text>
        <IconChevronDown size={18} color={tokens.textSecondary} strokeWidth={2} />
      </Pressable>
      {hint === undefined ? null : <Hint>{hint}</Hint>}
    </View>
  );
}

export function SwitchRow({
  label,
  detail,
  value,
  onChange,
}: {
  readonly label: string;
  readonly detail: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.switchLabel} maxFontSizeMultiplier={1.6}>
          {label}
        </Text>
        <Text style={styles.hintPlain} maxFontSizeMultiplier={1.6}>
          {detail}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ false: tokens.track, true: tokens.primary }}
        thumbColor={value ? tokens.primaryText : tokens.textSecondary}
      />
    </View>
  );
}

export function InfoRow({ label, detail }: { readonly label: string; readonly detail: string }) {
  return (
    <View style={styles.switchText}>
      <Text style={styles.switchLabel} maxFontSizeMultiplier={1.6}>
        {label}
      </Text>
      <Text style={styles.hintPlain} maxFontSizeMultiplier={1.6}>
        {detail}
      </Text>
    </View>
  );
}

export function SectionCard({
  children,
  accessibilityLabel,
}: {
  readonly children: ReactNode;
  readonly accessibilityLabel: string;
}) {
  return (
    <View accessibilityLabel={accessibilityLabel} style={styles.card}>
      {children}
    </View>
  );
}

export function FormButton({
  label,
  onPress,
  variant,
  disabled = false,
  busy = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant: "primary" | "danger" | "quiet";
  readonly disabled?: boolean;
  readonly busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      style={[
        styles.button,
        variant === "primary" ? styles.buttonPrimary : styles.buttonOutlined,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          variant === "primary"
            ? styles.buttonTextPrimary
            : variant === "danger"
              ? styles.buttonTextDanger
              : null,
        ]}
        maxFontSizeMultiplier={1.6}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const formStyles = StyleSheet.create({
  body: { padding: 20, gap: 20, paddingBottom: 48 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  note: { color: tokens.textSecondary, fontSize: 15, lineHeight: 21, textAlign: "center" },
  inlineLink: { minHeight: 44, justifyContent: "center" },
  inlineLinkText: {
    color: tokens.text,
    fontSize: 14,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  optional: { color: tokens.textSecondary, fontWeight: "400" },
  hint: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  hintPlain: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  errorText: { color: tokens.error, fontSize: 14, lineHeight: 19 },
  input: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.fillMuted,
    color: tokens.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
  },
  inputMultiline: { minHeight: 120, lineHeight: 22 },
  inputInvalid: { borderColor: tokens.error },
  picker: { flexDirection: "row", alignItems: "center", gap: 8 },
  pickerValue: { flex: 1, color: tokens.text, fontSize: 16 },
  switchRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12 },
  switchText: { flex: 1, gap: 2 },
  switchLabel: { color: tokens.text, fontSize: 15 },
  card: {
    gap: 20,
    padding: 16,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  button: { minHeight: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  buttonPrimary: { backgroundColor: tokens.primary },
  buttonOutlined: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.fillMuted,
  },
  buttonText: { color: tokens.text, fontSize: 15, fontWeight: "500" },
  buttonTextPrimary: { color: tokens.primaryText, fontWeight: "600" },
  buttonTextDanger: { color: tokens.error },
  disabled: { opacity: 0.4 },
});
