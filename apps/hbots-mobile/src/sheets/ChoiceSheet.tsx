import { IconCheck } from "@tabler/icons-react-native";
import type { FieldChoice } from "@hbots/personal-client/bots/botFormFields";
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions } from "react-native";

import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

export function ChoiceSheet({
  visible,
  title,
  choices,
  value,
  onSelect,
  onClose,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly choices: ReadonlyArray<FieldChoice>;
  readonly value: string;
  readonly onSelect: (value: string) => void;
  readonly onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  return (
    <SheetShell inline visible={visible} title={title} onClose={onClose}>
      <FlatList
        data={choices}
        keyExtractor={(choice) => choice.value}
        style={{ maxHeight: Math.round(height * 0.55) }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={16}
        renderItem={({ item }) => {
          const selected = item.value === value;
          return (
            <Pressable
              onPress={() => {
                onSelect(item.value);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={item.label}
              android_ripple={{ color: "rgba(255,255,255,0.08)" }}
              style={styles.row}
            >
              <Text
                style={[styles.label, selected ? styles.labelSelected : null]}
                maxFontSizeMultiplier={1.6}
              >
                {item.label}
              </Text>
              {selected ? <IconCheck size={18} color={tokens.text} strokeWidth={2} /> : null}
            </Pressable>
          );
        }}
      />
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: { flex: 1, color: tokens.text, fontSize: 16, lineHeight: 22 },
  labelSelected: { fontWeight: "600" },
});
