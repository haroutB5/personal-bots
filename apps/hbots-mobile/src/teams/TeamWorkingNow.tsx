import { IconArrowRight } from "@tabler/icons-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";
import type { WorkingNowRow } from "./teamScreenModel";

/**
 * The handoffs running right now, directly above the team cards. A row opens
 * the receiving bot's task chat; a task that has no chat yet opens its page.
 */
export function TeamWorkingNow({
  rows,
  onOpen,
}: {
  readonly rows: ReadonlyArray<WorkingNowRow>;
  readonly onOpen: (row: WorkingNowRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <View style={styles.dot} />
        <Text style={styles.headingText} maxFontSizeMultiplier={1.4}>
          {`Working now · ${String(rows.length)}`}
        </Text>
      </View>
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Pressable
            key={row.taskId}
            accessibilityRole="button"
            accessibilityLabel={`${row.from.name} to ${row.to.name}: ${row.title}. Open ${
              row.threadId === null ? "the task" : `${row.to.name}'s chat for this task`
            }.`}
            onPress={() => onOpen(row)}
            style={[styles.row, index === rows.length - 1 ? null : styles.divider]}
          >
            <View style={styles.faces}>
              <BotAvatar
                shape={row.from.avatarShape}
                color={row.from.avatarColor}
                size={28}
                label=""
              />
              <IconArrowRight size={14} color={tokens.working} strokeWidth={2.25} />
              <BotAvatar shape={row.to.avatarShape} color={row.to.avatarColor} size={28} label="" />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                {`${row.from.name} → ${row.to.name}`}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                {row.title}
              </Text>
            </View>
            <Text style={styles.rowTime} maxFontSizeMultiplier={1.3}>
              {row.forLabel}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, paddingTop: 4 },
  heading: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.working },
  headingText: { color: tokens.sectionLabel, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  card: {
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    backgroundColor: tokens.surface,
  },
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
  faces: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: tokens.text, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  rowSubtitle: { color: tokens.textSecondary, fontSize: 13, lineHeight: 18 },
  rowTime: { color: tokens.textSecondary, fontSize: 13 },
});
