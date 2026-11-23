import { Pressable, StyleSheet, Text, View } from "react-native";

import { SheetShell } from "../sheets/SheetShell";
import { tokens } from "../shell/tokens";
import {
  RESTART_CANCEL_LABEL,
  RESTART_CONFIRM_BODY,
  RESTART_CONFIRM_LABEL,
  RESTART_CONFIRM_TITLE,
  RESTART_TEST_IDS,
} from "./restartLaptopModel";

export interface RestartLaptopConfirmSheetProps {
  readonly visible: boolean;
  readonly sending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Shared confirmation sheet for restarting the laptop from Settings or the offline banner. */
export function RestartLaptopConfirmSheet({
  visible,
  sending,
  onConfirm,
  onCancel,
}: RestartLaptopConfirmSheetProps) {
  return (
    <SheetShell
      visible={visible}
      title={RESTART_CONFIRM_TITLE}
      onClose={() => {
        if (!sending) onCancel();
      }}
    >
      <View style={styles.sheetBody} testID={RESTART_TEST_IDS.confirmSheet}>
        <Text style={styles.sheetText} maxFontSizeMultiplier={1.4}>
          {RESTART_CONFIRM_BODY}
        </Text>
        <Pressable
          testID={RESTART_TEST_IDS.confirm}
          onPress={onConfirm}
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
          onPress={onCancel}
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
  );
}

const styles = StyleSheet.create({
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
