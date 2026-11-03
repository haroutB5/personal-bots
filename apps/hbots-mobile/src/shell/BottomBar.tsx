import {
  IconCircleCheck,
  IconFile,
  IconDeviceLaptop,
  IconMessageCircle,
} from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { TabName } from "../nav/routes";
import { tokens } from "./tokens";

const TABS = [
  { tab: "bots", label: "Bots", Icon: IconMessageCircle },
  { tab: "tasks", label: "Tasks", Icon: IconCircleCheck },
  { tab: "computer", label: "Computer", Icon: IconDeviceLaptop },
  { tab: "files", label: "Files", Icon: IconFile },
] as const;

export function BottomBar({
  active,
  bottomInset,
  onSelect,
}: {
  readonly active: TabName;
  readonly bottomInset: number;
  readonly onSelect: (tab: TabName) => void;
}) {
  return (
    <View style={[styles.bar, { paddingBottom: bottomInset }]}>
      {TABS.map(({ tab, label, Icon }) => {
        const selected = tab === active;
        return (
          <Pressable
            key={tab}
            onPress={() => onSelect(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            style={styles.tab}
          >
            <Icon
              size={24}
              color={selected ? tokens.text : tokens.textSecondary}
              strokeWidth={selected ? 2.2 : 1.8}
            />
            <Text
              style={[styles.label, selected ? styles.labelActive : null]}
              maxFontSizeMultiplier={1.3}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    backgroundColor: tokens.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  tab: {
    flex: 1,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 6,
    paddingBottom: 4,
    gap: 2,
  },
  label: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  labelActive: { color: tokens.text, fontWeight: "600" },
});
