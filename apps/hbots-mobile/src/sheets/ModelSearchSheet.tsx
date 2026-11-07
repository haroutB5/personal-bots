import { IconCheck } from "@tabler/icons-react-native";
import type { ServerProvider } from "@t3tools/contracts";
import { modelOptionLabel } from "@hbots/personal-client/bots/botFormModel";
import {
  MODEL_PLAN_FILTER_OPTIONS,
  type ModelPlanFilter,
} from "@hbots/personal-client/bots/modelPlanFilter";
import { modelSearchView } from "@hbots/personal-client/bots/modelSearchView";
import { useEffect, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import { tokens } from "../shell/tokens";
import { SheetShell } from "./SheetShell";

export function ModelSearchSheet({
  visible,
  title,
  models,
  value,
  onSelect,
  onClose,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly models: ServerProvider["models"];
  readonly value: string;
  readonly onSelect: (slug: string) => void;
  readonly onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [planFilter, setPlanFilter] = useState<ModelPlanFilter>("all");

  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react/set-state-in-effect -- opening the sheet resets its search
    setQuery("");
    setPlanFilter("all");
  }, [visible]);

  const view = modelSearchView({ models, value, query, open: true, planFilter });

  return (
    <SheetShell inline visible={visible} title={title} onClose={onClose}>
      <View style={styles.body}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={view.placeholder}
          placeholderTextColor={tokens.textTertiary}
          accessibilityLabel="Search models"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxFontSizeMultiplier={1.6}
          style={styles.input}
        />
        {view.showPlanFilter ? (
          <View style={styles.chips} accessibilityLabel="Model plan">
            {MODEL_PLAN_FILTER_OPTIONS.map((option) => {
              const selected = option.id === planFilter;
              return (
                <Pressable
                  key={option.id}
                  onPress={() => setPlanFilter(option.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[styles.chip, selected ? styles.chipOn : null]}
                >
                  <Text
                    style={[styles.chipText, selected ? styles.chipTextOn : null]}
                    maxFontSizeMultiplier={1.6}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <Text style={styles.summary} maxFontSizeMultiplier={1.6}>
          {view.summary}
        </Text>
        <FlatList
          data={view.results}
          keyExtractor={(model) => model.slug}
          style={{ maxHeight: Math.round(height * 0.4) }}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={16}
          renderItem={({ item }) => {
            const selected = item.slug === value;
            return (
              <Pressable
                onPress={() => {
                  onSelect(item.slug);
                  onClose();
                }}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                android_ripple={{ color: "rgba(255,255,255,0.08)" }}
                style={styles.row}
              >
                <Text
                  style={[styles.label, selected ? styles.labelSelected : null]}
                  maxFontSizeMultiplier={1.6}
                >
                  {modelOptionLabel(item)}
                </Text>
                {selected ? <IconCheck size={18} color={tokens.text} strokeWidth={2} /> : null}
              </Pressable>
            );
          }}
        />
      </View>
    </SheetShell>
  );
}

const styles = StyleSheet.create({
  body: { gap: 8, paddingHorizontal: 4 },
  input: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.bg,
    color: tokens.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  chips: { flexDirection: "row", gap: 6 },
  chip: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    alignItems: "center",
    justifyContent: "center",
  },
  chipOn: { backgroundColor: tokens.primary, borderColor: tokens.primary },
  chipText: { color: tokens.textSecondary, fontSize: 13, fontWeight: "500" },
  chipTextOn: { color: tokens.primaryText },
  summary: { color: tokens.textSecondary, fontSize: 14, lineHeight: 19 },
  row: {
    minHeight: 48,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: { flex: 1, color: tokens.text, fontSize: 16, lineHeight: 22 },
  labelSelected: { fontWeight: "600" },
});
