import {
  BUSY_PERCENT,
  LOW_DISK_SHARE,
  formatGB,
} from "@hbots/personal-client/computer/systemStats";
import { IconServer } from "../ui/icons";
import { memo } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { tokens } from "../shell/tokens";
import { serverAppsParts, serverStatParts, type ServerLinePart } from "./serverStats";
import { useSystemSummary } from "./useSystemSummary";

const HOT_CPU_TEMP_C = 85;
const HOT_DISK_TEMP_C = 65;

interface MeterTile {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
  readonly percent: number | null;
  readonly busy: boolean;
}

interface SensorChip {
  readonly key: string;
  readonly text: string;
  readonly hot: boolean;
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Compact visual vitals card for the laptop hosting the bots: 3-column
 * CPU/Memory/Disk meters, inline thermal & fan chips, and an optional 1-line
 * App server status footer when server telemetry is present.
 */
export const MachineStatsCard = memo(function MachineStatsCard({
  native,
}: {
  readonly native: NativePersonal;
}) {
  const summary = useSystemSummary(native);
  if (summary === null) return null;

  const tiles: MeterTile[] = [];
  if (summary.cpuPct !== null) {
    const pct = clampPct(summary.cpuPct);
    tiles.push({
      key: "cpu",
      label: "CPU",
      value: `${pct}%`,
      detail: pct >= BUSY_PERCENT ? "Busy" : "Load",
      percent: pct,
      busy: pct >= BUSY_PERCENT,
    });
  }
  if (summary.memUsedGB !== null && summary.memTotalGB !== null) {
    const pct =
      summary.memUsedPct !== null
        ? clampPct(summary.memUsedPct)
        : summary.memTotalGB > 0
          ? clampPct((summary.memUsedGB / summary.memTotalGB) * 100)
          : null;
    tiles.push({
      key: "memory",
      label: "Memory",
      value: `${summary.memUsedGB.toFixed(1)} GB`,
      detail: `of ${Math.round(summary.memTotalGB)} GB`,
      percent: pct,
      busy: pct !== null && pct >= BUSY_PERCENT,
    });
  }
  if (summary.diskFreeGB !== null) {
    const total = summary.diskTotalGB;
    const low = total !== null && total > 0 && summary.diskFreeGB / total < LOW_DISK_SHARE;
    const usedPct =
      total !== null && total > 0 ? clampPct(((total - summary.diskFreeGB) / total) * 100) : null;
    tiles.push({
      key: "disk",
      label: summary.diskLabel ?? "Disk",
      value: formatGB(summary.diskFreeGB),
      detail: "free",
      percent: usedPct,
      busy: low,
    });
  }

  const chips: SensorChip[] = [];
  if (summary.cpuTempC !== null) {
    chips.push({
      key: "cpuTemp",
      text: `CPU ${Math.round(summary.cpuTempC)} °C`,
      hot: summary.cpuTempC >= HOT_CPU_TEMP_C,
    });
  }
  if (summary.diskTempC !== null) {
    chips.push({
      key: "diskTemp",
      text: `SSD ${Math.round(summary.diskTempC)} °C`,
      hot: summary.diskTempC >= HOT_DISK_TEMP_C,
    });
  }
  summary.fans.slice(0, 2).forEach((fan, index) => {
    chips.push({
      key: `fan:${index}`,
      text: `${Math.round(fan.rpm).toLocaleString("en-GB")} rpm`,
      hot: false,
    });
  });

  const serverParts = serverStatParts(summary.server);
  const appParts = serverAppsParts(summary.serverApps);
  const footerParts: ReadonlyArray<ServerLinePart> = [
    ...serverParts.filter((part) => part.key !== "label"),
    ...appParts,
  ];

  if (tiles.length === 0 && chips.length === 0 && footerParts.length === 0) return null;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          This laptop
        </Text>
        {chips.length > 0 ? (
          <View style={styles.chipsRow}>
            {chips.map((chip) => (
              <View key={chip.key} style={[styles.chip, chip.hot ? styles.chipHot : null]}>
                <Text
                  style={[styles.chipText, chip.hot ? styles.chipTextHot : null]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.2}
                >
                  {chip.text}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {tiles.length > 0 ? (
        <View style={styles.tilesRow}>
          {tiles.map((tile) => (
            <View key={tile.key} style={styles.tile}>
              <Text style={styles.tileLabel} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {tile.label}
              </Text>
              <Text
                style={[styles.tileValue, tile.busy ? styles.tileValueBusy : null]}
                numberOfLines={1}
                maxFontSizeMultiplier={1.2}
              >
                {tile.value}
              </Text>
              {tile.detail === null ? null : (
                <Text style={styles.tileDetail} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                  {tile.detail}
                </Text>
              )}
              {tile.percent === null ? null : (
                <View style={styles.meterTrack}>
                  <View
                    style={[
                      styles.meterFill,
                      {
                        width: `${tile.percent > 0 ? Math.max(4, tile.percent) : 0}%`,
                        backgroundColor: tile.busy ? tokens.needs : tokens.working,
                      },
                    ]}
                  />
                </View>
              )}
            </View>
          ))}
        </View>
      ) : null}

      {footerParts.length > 0 ? (
        <View style={styles.serverFooter}>
          <IconServer size={14} color={tokens.textSecondary} />
          <Text style={styles.serverText} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            <Text style={styles.serverLabel}>App server</Text>
            {footerParts.map((part) => (
              <Text key={part.key} style={part.busy ? styles.serverBusy : undefined}>
                {" · "}
                {part.text}
              </Text>
            ))}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    color: tokens.sectionLabel,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    flexShrink: 0,
  },
  chipsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 6,
    flexShrink: 1,
  },
  chip: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: tokens.fillMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
  },
  chipHot: {
    backgroundColor: tokens.reviewBg,
    borderColor: tokens.reviewBorder,
  },
  chipText: {
    color: tokens.textSecondary,
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  chipTextHot: {
    color: tokens.reviewText,
  },
  tilesRow: {
    flexDirection: "row",
    gap: 8,
  },
  tile: {
    flex: 1,
    minWidth: 0,
    backgroundColor: tokens.raised,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  tileLabel: {
    color: tokens.textSecondary,
    fontSize: 11,
    fontWeight: "500",
  },
  tileValue: {
    color: tokens.text,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    marginTop: 1,
  },
  tileValueBusy: {
    color: tokens.needs,
  },
  tileDetail: {
    color: tokens.textTertiary,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  meterTrack: {
    height: 4,
    borderRadius: 999,
    backgroundColor: tokens.track,
    overflow: "hidden",
    marginTop: 6,
  },
  meterFill: {
    height: "100%",
    borderRadius: 999,
  },
  serverFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: tokens.border,
    paddingTop: 8,
  },
  serverText: {
    flex: 1,
    color: tokens.textSecondary,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  serverLabel: {
    color: tokens.text,
    fontWeight: "600",
  },
  serverBusy: {
    color: tokens.needs,
    fontWeight: "600",
  },
});
