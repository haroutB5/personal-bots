import { IconCheck } from "@tabler/icons-react-native";
import type { BotAvatarShape } from "@t3tools/contracts";
import {
  BOT_AVATAR_SHAPE_LABELS,
  BOT_AVATAR_SHAPE_ORDER,
  BOT_AVATAR_SWATCHES,
  botAvatarNeedsHalo,
} from "@hbots/personal-client/bots/botAvatarShapes";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BotAvatar } from "../shell/BotAvatar";
import { tokens } from "../shell/tokens";

export interface BotAvatarSelection {
  readonly shape: BotAvatarShape;
  readonly color: string;
}

export function BotAvatarPicker({
  shape,
  color,
  onChange,
  previewName,
}: {
  readonly shape: BotAvatarShape;
  readonly color: string;
  readonly onChange: (next: BotAvatarSelection) => void;
  readonly previewName: string;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.preview}>
        <BotAvatar shape={shape} color={color} size={72} label={`${previewName} preview`} />
        <View style={styles.previewText}>
          <Text style={styles.previewName} numberOfLines={1} maxFontSizeMultiplier={1.6}>
            {previewName || "Your bot"}
          </Text>
          <Text style={styles.previewShape} maxFontSizeMultiplier={1.6}>
            {BOT_AVATAR_SHAPE_LABELS[shape]}
          </Text>
        </View>
      </View>

      <View style={styles.group}>
        <Text style={styles.legend} maxFontSizeMultiplier={1.6}>
          Shape
        </Text>
        <View style={styles.grid}>
          {BOT_AVATAR_SHAPE_ORDER.map((option) => {
            const selected = option === shape;
            return (
              <Pressable
                key={option}
                onPress={() => onChange({ shape: option, color })}
                accessibilityRole="button"
                accessibilityLabel={`Shape ${BOT_AVATAR_SHAPE_LABELS[option]}`}
                accessibilityState={{ selected }}
                style={[styles.shapeCell, selected ? styles.cellSelected : null]}
              >
                <BotAvatar shape={option} color={color} size={36} label="" />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.group}>
        <Text style={styles.legend} maxFontSizeMultiplier={1.6}>
          Colour
        </Text>
        <View style={styles.grid}>
          {BOT_AVATAR_SWATCHES.map((swatch) => {
            const selected = swatch.toLowerCase() === color.toLowerCase();
            return (
              <Pressable
                key={swatch}
                onPress={() => onChange({ shape, color: swatch })}
                accessibilityRole="button"
                accessibilityLabel={`Colour ${swatch}`}
                accessibilityState={{ selected }}
                style={[styles.swatchCell, selected ? styles.cellSelected : null]}
              >
                <View
                  style={[
                    styles.swatch,
                    { backgroundColor: swatch },
                    botAvatarNeedsHalo(swatch) ? styles.swatchHalo : null,
                  ]}
                >
                  {selected ? <IconCheck size={16} color="#ffffff" strokeWidth={3} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 20 },
  preview: { flexDirection: "row", alignItems: "center", gap: 16 },
  previewText: { flex: 1 },
  previewName: { color: tokens.text, fontSize: 18, fontWeight: "600" },
  previewShape: { color: tokens.textSecondary, fontSize: 14 },
  group: { gap: 8 },
  legend: { color: tokens.text, fontSize: 14, fontWeight: "500" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  shapeCell: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.borderStrong,
    backgroundColor: tokens.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchCell: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  cellSelected: { borderWidth: 2, borderColor: tokens.text },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchHalo: { borderWidth: 1.5, borderColor: tokens.avatarHalo },
});
