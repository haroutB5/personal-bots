import { PERSONAL_TABS } from "@hbots/personal-client/bots/personalMode";
import {
  IconCircleCheck,
  IconCircleCheckFilled,
  IconDeviceLaptop,
  IconFile,
  IconFileFilled,
  IconMessageCircle,
  IconMessageCircleFilled,
  IconTimeline,
} from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { TabName } from "../nav/routes";
import { tokens } from "./tokens";

const LABELS = new Map(
  PERSONAL_TABS.map((entry) => [entry.tab === "chats" ? "bots" : entry.tab, entry.label]),
);

const TABS = [
  {
    tab: "bots",
    label: LABELS.get("bots") ?? "Chats",
    Icon: IconMessageCircle,
    ActiveIcon: IconMessageCircleFilled,
  },
  {
    tab: "work",
    label: LABELS.get("work") ?? "Work",
    Icon: IconTimeline,
    ActiveIcon: IconTimeline,
  },
  {
    tab: "tasks",
    label: LABELS.get("tasks") ?? "Tasks",
    Icon: IconCircleCheck,
    ActiveIcon: IconCircleCheckFilled,
  },
  {
    tab: "computer",
    label: LABELS.get("computer") ?? "Computer",
    Icon: IconDeviceLaptop,
    ActiveIcon: IconDeviceLaptop,
  },
  {
    tab: "files",
    label: LABELS.get("files") ?? "Files",
    Icon: IconFile,
    ActiveIcon: IconFileFilled,
  },
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
      <View style={styles.tabs}>
        {TABS.map(({ tab, label, Icon, ActiveIcon }) => {
          const selected = tab === active;
          const Glyph = selected ? ActiveIcon : Icon;
          return (
            <Pressable
              key={tab}
              onPress={() => onSelect(tab)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={label}
              style={styles.tab}
            >
              <Glyph
                size={24}
                color={selected ? tokens.text : tokens.textSecondary}
                // Work has no filled glyph, so a heavier stroke marks it as selected.
                strokeWidth={selected && tab === "work" ? 2.5 : 1.75}
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
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: tokens.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
  },
  tabs: { flexDirection: "row", height: 56 },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  label: { color: tokens.textSecondary, fontSize: 12, lineHeight: 16, fontWeight: "400" },
  labelActive: { color: tokens.text, fontWeight: "600" },
});
