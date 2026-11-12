import { machineStatRows } from "@hbots/personal-client/computer/systemStats";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { useSystemSummary } from "./useSystemSummary";

/**
 * The laptop that hosts the bots: CPU, memory, disk, temperatures and fans.
 * A sensor the host does not have has no row, so nothing reads as zero.
 */
export function MachineStatsCard({ native }: { readonly native: NativePersonal }) {
  const summary = useSystemSummary(native);
  const rows = summary === null ? [] : machineStatRows(summary);
  if (rows.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title} maxFontSizeMultiplier={1.3}>
        This laptop
      </Text>
      {rows.map((row) => (
        <View key={row.key} style={styles.row}>
          <Text style={styles.label} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {row.label}
          </Text>
          <Text style={styles.value} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    color: tokens.sectionLabel,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  row: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  label: { color: tokens.textSecondary, fontSize: 14, flexShrink: 1 },
  value: { color: tokens.text, fontSize: 14, fontWeight: "500", flexShrink: 0 },
});
